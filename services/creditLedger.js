'use strict';
/**
 * OmniSMS — Ledger de crédits SMS (source de vérité comptable).
 *
 * Principes :
 *   - `credit_ledger` : collection IMMUTABLE (jamais d'update/delete) d'écritures
 *     { id, uid, type, delta, reason, reference, balanceAfter, createdAt }.
 *     Types : PURCHASE (+n), RESERVATION (-n), CAPTURE (0, confirme une
 *     réservation), REFUND (+n, annule une réservation), FREE_USE (0),
 *     ADMIN_ADJUST (±n, audit obligatoire).
 *   - `credit_balances/{uid}` : solde courant, mis à jour DANS LA MÊME
 *     transaction Firestore que l'écriture du ledger → jamais négatif,
 *     jamais de double dépense (atomicité Firestore).
 *   - Idempotence par référence (messageId / idTransaction) via des IDs de
 *     documents déterministes : relire le doc avant écriture dans la txn.
 *
 * Réservation → CAPTURE (passerelle accepte) ou REFUND (échec / expiration /
 * QUOTA_EXCEEDED). Le solde = somme des deltas ; les REFUND/CAPTURE sont
 * lisibles dans le ledger.
 */

function getDb(dbParam) {
  if (dbParam) return dbParam;
  const db = require('../config/firebase');
  if (!db || db._stub) {
    throw Object.assign(new Error('Firestore unavailable.'), { code: 'DB_UNAVAILABLE' });
  }
  return db;
}

function nowIso() { return new Date().toISOString(); }

/** Solde courant (0 si aucun document). */
async function getBalance(dbParam, uid) {
  const db = getDb(dbParam);
  const snap = await db.collection('credit_balances').doc(String(uid)).get();
  if (!snap.exists) return 0;
  return Number(snap.data().balance) || 0;
}

/**
 * Credit/débit générique atomique. Idempotent si `ledgerId` fourni.
 * @returns {{ ok:boolean, alreadyDone?:boolean, balance?:number }}
 */
async function applyLedgerEntry(dbParam, { uid, type, delta, reason, reference, ledgerId }) {
  const db = getDb(dbParam);
  const col = db.collection('credit_ledger');
  const balRef = db.collection('credit_balances').doc(String(uid));
  const entryId = ledgerId || `${type.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entryRef = col.doc(entryId);
  let balanceAfter = 0;

  await db.runTransaction(async (tx) => {
    const entrySnap = await tx.get(entryRef);
    if (entrySnap.exists) { balanceAfter = Number(entrySnap.data().balanceAfter) || 0; return; } // déjà appliqué
    const balSnap = await tx.get(balRef);
    const balance = balSnap.exists ? (Number(balSnap.data().balance) || 0) : 0;
    const next = balance + delta;
    if (next < 0) {
      throw Object.assign(new Error('Solde de crédits insuffisant.'), { code: 'INSUFFICIENT_CREDITS', balance, requested: -delta });
    }
    balanceAfter = next;
    if (balSnap.exists) tx.update(balRef, { balance: next, updatedAt: nowIso() });
    else tx.set(balRef, { uid: String(uid), balance: next, createdAt: nowIso(), updatedAt: nowIso() });
    tx.create(entryRef, {
      uid: String(uid), type, delta, reason: reason || null, reference: reference || null,
      balanceAfter: next, createdAt: nowIso(),
    });
  });
  return { ok: true, balance: balanceAfter };
}

/**
 * Réservation de crédits pour un envoi (idempotent par messageId).
 * @returns {{ ok:true, alreadyDone:boolean, balance:number } | { ok:false, code:'INSUFFICIENT_CREDITS', balance, required }}
 */
async function reserveCredits(dbParam, { uid, messageId, credits, reason }) {
  const db = getDb(dbParam);
  const n = Number(credits) | 0;
  if (!uid || !messageId || !(n > 0)) {
    throw Object.assign(new Error('reserveCredits: uid, messageId et credits>0 requis'), { code: 'INVALID_ARG' });
  }
  const entryRef = db.collection('credit_ledger').doc(`resv-${messageId}`);
  const exists = await entryRef.get();
  if (exists.exists) return { ok: true, alreadyDone: true, balance: await getBalance(db, uid) };
  try {
    return await applyLedgerEntry(db, {
      uid, type: 'RESERVATION', delta: -n, reason: reason || 'sms_send', reference: messageId, ledgerId: `resv-${messageId}`,
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_CREDITS') {
      return { ok: false, code: 'INSUFFICIENT_CREDITS', balance: err.balance, required: err.requested };
    }
    throw err;
  }
}

/** Confirme qu'un envoi réservé est parti (la passerelle a accepté). Idempotent. */
async function captureReservation(dbParam, { messageId, reason }) {
  const db = getDb(dbParam);
  const entryRef = db.collection('credit_ledger').doc(`capt-${messageId}`);
  const exists = await entryRef.get();
  if (exists.exists) return { ok: true, alreadyDone: true };
  const resvSnap = await db.collection('credit_ledger').doc(`resv-${messageId}`).get();
  if (!resvSnap.exists) return { ok: false, code: 'NO_RESERVATION' };
  await applyLedgerEntry(db, {
    uid: resvSnap.data().uid, type: 'CAPTURE', delta: 0, reason: reason || 'sms_accepted', reference: messageId, ledgerId: `capt-${messageId}`,
  });
  return { ok: true, alreadyDone: false };
}

/**
 * Rembourse une réservation (échec / expiration / QUOTA_EXCEEDED). Idempotent.
 * Crédite à nouveau les segments réservés (aucun effet si la réservation
 * était un quota gratuit ou n'existe pas).
 */
async function refundReservation(dbParam, { messageId, reason }) {
  const db = getDb(dbParam);
  const refundRef = db.collection('credit_ledger').doc(`refd-${messageId}`);
  const already = await refundRef.get();
  if (already.exists) return { ok: true, alreadyDone: true };
  const resvSnap = await db.collection('credit_ledger').doc(`resv-${messageId}`).get();
  if (!resvSnap.exists) return { ok: false, code: 'NO_RESERVATION' };
  const data = resvSnap.data();
  if (data.type === 'FREE_USE') return { ok: true, freeUsed: true, alreadyDone: false };
  const credits = Math.abs(Number(data.delta) || 0);
  if (credits <= 0) return { ok: false, code: 'NOTHING_TO_REFUND' };
  const res = await applyLedgerEntry(db, {
    uid: data.uid, type: 'REFUND', delta: credits, reason: reason || 'sms_failed', reference: messageId, ledgerId: `refd-${messageId}`,
  });
  return { ...res, credits };
}

/**
 * Crédite un achat de pack (rapprochement Orange Money / admin). Idempotent
 * par référence (idTransaction OM).
 */
async function grantPurchase(dbParam, { uid, credits, reference, reason }) {
  return applyLedgerEntry(dbParam, {
    uid, type: 'PURCHASE', delta: Number(credits), reason: reason || 'pack_purchase', reference,
    ledgerId: `purch-${reference}`,
  });
}

/** Ajustement administrateur (audit complet obligatoire). Idempotent par reference. */
async function adminAdjust(dbParam, { uid, delta, reason, reference }) {
  if (!Number.isInteger(delta) || delta === 0) {
    throw Object.assign(new Error('delta doit être un entier non nul'), { code: 'INVALID_ARG' });
  }
  if (!reason) throw Object.assign(new Error('reason obligatoire pour un ajustement'), { code: 'INVALID_ARG' });
  const ref = reference || `admin-${Date.now()}`;
  return applyLedgerEntry(dbParam, {
    uid, type: 'ADMIN_ADJUST', delta, reason, reference: ref, ledgerId: `adj-${ref}`,
  });
}

/** Dernières écritures d'un utilisateur (audit / SOLDE détaillé). */
async function getLedger(dbParam, uid, limit = 20) {
  const db = getDb(dbParam);
  return db.collection('credit_ledger')
    .where('uid', '==', String(uid))
    .orderBy('createdAt', 'desc')
    .limit(Math.min(limit, 100))
    .get()
    .then((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })));
}

module.exports = {
  getBalance, applyLedgerEntry, reserveCredits, captureReservation,
  refundReservation, grantPurchase, adminAdjust, getLedger,
};
