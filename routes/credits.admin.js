'use strict';
/**
 * OmniSMS — Admin minimal du module crédits (protection x-admin-key).
 *
 * Monté sur /api/admin/credits (server.js) :
 *   GET  /api/admin/credits/payments?status=unmatched|matched|review|rejected
 *   POST /api/admin/credits/payments/:txnId/match   { uid }            → rapprochement manuel
 *   POST /api/admin/credits/payments/:txnId/reject  { reason }         → rejet (aucun crédit)
 *   POST /api/admin/credits/adjust                  { uid, delta, reason, reference? }
 *   POST /api/admin/credits/reconcile-expired                          → rembourse les réservations expirées
 *   GET  /api/admin/credits/payments/export.csv                        → export CSV des paiements
 *   GET  /api/admin/credits/ledger/:uid                                → audit du ledger
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../middleware/logger');

const ledger = require('../services/creditLedger');
const { getLimits } = require('../services/packsConfig');

/* ── Protection : header x-admin-key == ADMIN_KEY (même modèle que admin.js) ── */
function requireAdminKey(req, res, next) {
  const provided = String(req.headers['x-admin-key'] || '').trim();
  const expected = String(process.env.ADMIN_KEY || '').trim();
  if (!expected || !provided || provided !== expected) {
    logger.warn('[CreditsAdmin] Accès refusé (x-admin-key invalide)', { path: req.path, ip: req.ip });
    return res.status(401).json({ success: false, error: 'Clé admin requise.', code: 'ADMIN_KEY_REQUIRED' });
  }
  return next();
}
router.use(requireAdminKey);

function getDb() {
  const db = require('../config/firebase');
  return db && !db._stub ? db : null;
}

/* ── Liste des paiements entrants par statut ─────────────────────── */
router.get('/payments', async (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ success: false, error: 'Firestore indisponible.' });
  const status = String(req.query.status || '').trim();
  try {
    let query = db.collection('incoming_payments');
    if (status) query = query.where('status', '==', status);
    const snap = await query.limit(200).get();
    const payments = snap.docs.map((d) => {
      const p = d.data();
      return { id: d.id, ...p, payerPhone: p.payerPhone ? String(p.payerPhone).replace(/\d{4}$/, '****') : null };
    });
    return res.json({ success: true, count: payments.length, payments });
  } catch (err) {
    logger.error('[CreditsAdmin] list payments failed', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Rapprochement manuel d'un paiement unmatched/review vers un utilisateur ── */
router.post('/payments/:txnId/match', async (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ success: false, error: 'Firestore indisponible.' });
  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ success: false, error: 'uid requis.' });
  const { txnId } = req.params;
  try {
    const payRef = db.collection('incoming_payments').doc(txnId);
    const snap = await payRef.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Paiement introuvable.' });
    const pay = snap.data();
    if (pay.status === 'matched' || pay.status === 'duplicate') {
      return res.status(409).json({ success: false, error: 'Paiement déjà crédité.' });
    }
    const packs = await require('../services/packsConfig').getEffectivePacks(db);
    const pack = packs.find((p) => p.priceFcfa === Number(pay.amountFcfa));
    if (!pack) return res.status(422).json({ success: false, error: `Montant ${pay.amountFcfa}F sans pack correspondant — utiliser /adjust avec audit.` });
    const grant = await ledger.grantPurchase(db, { uid, credits: pack.sms, reference: `manual-${txnId}`, reason: `pack ${pack.id} (admin match)` });
    if (grant.alreadyDone) return res.status(409).json({ success: false, error: 'Crédit déjà accordé pour cette référence.' });
    await payRef.set({ status: 'matched', creditedUid: uid, creditsGranted: pack.sms, matchedBy: 'admin', processedAt: new Date().toISOString() }, { merge: true });
    logger.info('[CreditsAdmin] Paiement rapproché manuellement', { txnId, uid, credits: pack.sms });
    return res.json({ success: true, credited: pack.sms, balance: grant.balance });
  } catch (err) {
    logger.error('[CreditsAdmin] manual match failed', { error: err.message, txnId });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Rejet d'un paiement (fraude suspectée…) — jamais crédité ── */
router.post('/payments/:txnId/reject', async (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ success: false, error: 'Firestore indisponible.' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ success: false, error: 'reason requise.' });
  try {
    await db.collection('incoming_payments').doc(req.params.txnId).set({
      status: 'rejected', rejectReason: reason, rejectedAt: new Date().toISOString(),
    }, { merge: true });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Ajustement manuel de crédits (audit complet au ledger) ─────── */
router.post('/adjust', async (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ success: false, error: 'Firestore indisponible.' });
  const { uid, delta, reason, reference } = req.body || {};
  try {
    const result = await ledger.adminAdjust(db, {
      uid, delta: parseInt(delta, 10), reason: `[admin] ${reason || 'sans raison'}`, reference,
    });
    logger.info('[CreditsAdmin] Ajustement de crédits', { uid, delta, reason, reference: reference || null });
    return res.json({ success: true, balance: result.balance });
  } catch (err) {
    const code = err.code === 'INVALID_ARG' ? 400 : 500;
    return res.status(code).json({ success: false, error: err.message });
  }
});

/* ── Réconciliation : rembourser les réservations expirées (crash/oubli) ── */
router.post('/reconcile-expired', async (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ success: false, error: 'Firestore indisponible.' });
  const ttlMs = getLimits().paymentIntentTtlMin * 60 * 1000; // réutilise le TTL configurable
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  try {
    const snap = await db.collection('credit_ledger')
      .where('type', '==', 'RESERVATION')
      .where('createdAt', '<', cutoff)
      .limit(200)
      .get();
    let refunded = 0, checked = 0;
    for (const doc of snap.docs) {
      const entry = doc.data();
      const messageId = String(entry.reference || '');
      if (!messageId) continue;
      checked++;
      const capt = await db.collection('credit_ledger').doc(`capt-${messageId}`).get();
      const refd = await db.collection('credit_ledger').doc(`refd-${messageId}`).get();
      if (!capt.exists && !refd.exists) {
        const r = await ledger.refundReservation(db, { messageId, reason: 'reservation_expired' });
        if (r.ok) refunded++;
      }
    }
    logger.info('[CreditsAdmin] reconcile-expired', { checked, refunded });
    return res.json({ success: true, checked, refunded });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Export CSV des paiements (rapprochement relevé Orange Money) ── */
router.get('/payments/export.csv', async (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).type('text/plain').send('Firestore indisponible.');
  try {
    const snap = await db.collection('incoming_payments').limit(1000).get();
    const rows = [['omTransactionId', 'status', 'amountFcfa', 'payerPhone', 'receivedAt', 'processedAt', 'creditedUid', 'intentId']];
    snap.docs.forEach((d) => {
      const p = d.data();
      rows.push([p.omTransactionId || d.id, p.status || '', p.amountFcfa || '', p.payerPhone || '', p.receivedAt || '', p.processedAt || '', p.creditedUid || p.claimedByUid || '', p.intentId || '']);
    });
    const csv = rows.map((r) => r.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="incoming_payments.csv"');
    return res.send(csv);
  } catch (err) {
    return res.status(500).type('text/plain').send(err.message);
  }
});

/* ── Audit : dernières écritures du ledger d'un utilisateur ─────── */
router.get('/ledger/:uid', async (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ success: false, error: 'Firestore indisponible.' });
  try {
    const entries = await ledger.getLedger(db, req.params.uid, 50);
    const balance = await ledger.getBalance(db, req.params.uid);
    return res.json({ success: true, balance, entries });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
