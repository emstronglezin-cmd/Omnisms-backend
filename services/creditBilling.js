'use strict';
/**
 * OmniSMS — Facturation des envois SMS (orchestration métier).
 *
 * Règles :
 *   - Messages en ligne (route OMNISMS) : GRATUITS, aucun crédit.
 *   - Seuls les messages partant par le transport SMS consomment :
 *       1) le quota gratuit (FREE_SMS_QUOTA par numéro E.164, une seule fois,
 *          consommé en premier — 1 message = 1 unité gratuite) ;
 *       2) sinon des crédits : 1 crédit = 1 segment (voir segmentCalculator).
 *   - Réservation à l'envoi, capture quand la passerelle accepte,
 *     remboursement automatique sur échec / QUOTA_EXCEEDED / expiration.
 *   - Solde insuffisant → message refusé (jamais envoyé aux frais de la
 *     maison) + SMS explicite à l'expéditeur (réponses limitées dans le
 *     temps pour ne pas coûter cher aux spammeurs).
 *
 * Activation : CREDITS_ENABLED=true (défaut : false → comportement historique,
 * aucune régression tant que le flag n'est pas activé sur Render).
 *
 * Flag Google Play : IN_APP_PURCHASE_UI (défaut false) — aucune UI d'achat
 * dans l'app tant que la conformité n'est pas validée ; le canal SMS reste
 * hors app.
 */

const ledger = require('./creditLedger');
const { getLimits } = require('./packsConfig');
const { countSegments } = require('./segmentCalculator');

function getDb(dbParam) {
  if (dbParam) return dbParam;
  const db = require('../config/firebase');
  return db && !db._stub ? db : null;
}

function isCreditsEnabled() {
  return (process.env.CREDITS_ENABLED || '').trim().toLowerCase() === 'true';
}

/** Flag conformité Google Play : UI d'achat dans l'app interdite par défaut. */
function isInAppPurchaseUiAllowed() {
  return (process.env.IN_APP_PURCHASE_UI || '').trim().toLowerCase() === 'true';
}

/** Flag « push FCM avant SMS » (désactivé par défaut — voir README). */
function isPushBeforeSmsEnabled() {
  return (process.env.OFFLINE_PUSH_BEFORE_SMS || '').trim().toLowerCase() === 'true';
}

/* ── Quota gratuit : free_sms_quota/{e164} — une seule fois par numéro ── */

/**
 * Consomme 1 unité du quota gratuit pour ce numéro (transactionnel).
 * @returns {{ used:boolean, remaining:number }}
 */
async function consumeFreeUnit(dbParam, phoneE164) {
  const db = getDb(dbParam);
  if (!db || !phoneE164) return { used: false, remaining: 0 };
  const quota = getLimits().freeSmsQuota;
  const ref = db.collection('free_sms_quota').doc(String(phoneE164));
  let result = { used: false, remaining: 0 };
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = snap.exists ? (Number(snap.data().used) || 0) : 0;
    if (used >= quota) { result = { used: false, remaining: 0 }; return; }
    if (snap.exists) tx.update(ref, { used: used + 1, quota, updatedAt: new Date().toISOString() });
    else tx.set(ref, { phone: String(phoneE164), used: 1, quota, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    result = { used: true, remaining: quota - used - 1 };
  });
  return result;
}

/** Restitue 1 unité gratuite si l'envoi a échoué (jamais négatif). */
async function refundFreeUnit(dbParam, phoneE164) {
  const db = getDb(dbParam);
  if (!db || !phoneE164) return false;
  const ref = db.collection('free_sms_quota').doc(String(phoneE164));
  let done = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const used = Number(snap.data().used) || 0;
    if (used <= 0) return;
    tx.update(ref, { used: used - 1, updatedAt: new Date().toISOString() });
    done = true;
  });
  return done;
}

async function getFreeRemaining(dbParam, phoneE164) {
  const db = getDb(dbParam);
  if (!db || !phoneE164) return 0;
  const snap = await db.collection('free_sms_quota').doc(String(phoneE164)).get();
  if (!snap.exists) return getLimits().freeSmsQuota;
  return Math.max(0, getLimits().freeSmsQuota - (Number(snap.data().used) || 0));
}

/* ── Cycle de vie d'un envoi SMS facturé ───────────────────────────── */

/**
 * Réserve le coût d'un envoi SMS (gratuit → crédits). Idempotent par messageId.
 * @param {object} p { db, uid, senderPhoneE164, messageId, text }
 * @returns {{ ok:true, freeUsed:boolean, segments:number, creditsReserved:number, remainingFree?:number, balance?:number }
 *          | { ok:false, code:'INSUFFICIENT_CREDITS', segments:number, balance:number, senderPhoneE164?:string }}
 */
async function chargeSmsSend({ db, uid, senderPhoneE164, messageId, text }) {
  const segments = Math.max(1, countSegments(text));
  if (!uid || !messageId) return { ok: false, code: 'INSUFFICIENT_CREDITS', segments, balance: 0 };

  // 1. Quota gratuit d'abord (une seule fois par numéro, 1 message = 1 unité).
  const free = await consumeFreeUnit(db, senderPhoneE164);
  if (free.used) {
    await ledger.applyLedgerEntry(db, {
      uid, type: 'FREE_USE', delta: 0, reason: 'free_quota', reference: messageId, ledgerId: `resv-${messageId}`,
    }).catch(() => {});
    return { ok: true, freeUsed: true, segments, creditsReserved: 0, remainingFree: free.remaining };
  }

  // 2. Crédits : réservation atomique (1 crédit = 1 segment).
  const res = await ledger.reserveCredits(db, { uid, messageId, credits: segments, reason: 'sms_send' });
  if (!res.ok) {
    return { ok: false, code: 'INSUFFICIENT_CREDITS', segments, balance: res.balance, senderPhoneE164 };
  }
  return { ok: true, freeUsed: false, segments, creditsReserved: segments, balance: res.balance };
}

/** La passerelle a accepté l'envoi → capture (audit). */
async function captureSmsSend(db, messageId) {
  try { return await ledger.captureReservation(db, { messageId, reason: 'sms_accepted' }); }
  catch (_) { return { ok: false }; }
}

/** Échec / QUOTA_EXCEEDED / expiration → remboursement automatique. */
async function refundSmsSend(db, messageId, reason) {
  try {
    const resvSnap = db ? await db.collection('credit_ledger').doc(`resv-${messageId}`).get().catch(() => null) : null;
    const resvData = resvSnap && resvSnap.exists ? resvSnap.data() : null;
    if (resvData && resvData.type === 'FREE_USE' && resvData.reference) {
      const userDoc = db ? await db.collection('users').doc(String(resvData.uid)).get().catch(() => null) : null;
      const phone = userDoc && userDoc.exists ? userDoc.data().phone : null;
      if (phone) await refundFreeUnit(db, phone);
    }
    return await ledger.refundReservation(db, { messageId, reason });
  } catch (_) { return { ok: false }; }
}

/* ── Réponse « solde insuffisant » (1 segment, limitée dans le temps) ── */

const _insufficientNotify = new Map(); // clé uid → last ts (fallback mémoire)
function _rateOk(key, cooldownMs) {
  const now = Date.now();
  const last = _insufficientNotify.get(key) || 0;
  if (now - last < cooldownMs) return false;
  _insufficientNotify.set(key, now);
  return true;
}

/**
 * SMS explicite à l'expéditeur : solde insuffisant + comment recharger.
 * Limité à 1 réponse par numéro et INSUFFICIENT_REPLY_COOLDOWN_MIN minutes.
 * @returns {boolean} true si un SMS de refus a été envoyé
 */
async function notifyInsufficientBalance({ db, uid, senderPhoneE164, sendSms }) {
  const cooldownMs = getLimits().insufficientReplyCooldownMin * 60 * 1000;
  const key = senderPhoneE164 || String(uid);
  if (!_rateOk(`insuff:${key}`, cooldownMs)) return false;
  if (typeof sendSms !== 'function' || !senderPhoneE164) return false;
  const { getGatewayOmNumber, getEffectivePacks } = require('./packsConfig');
  let cheapest = null;
  try {
    const packs = await getEffectivePacks(db);
    cheapest = packs.reduce((min, p) => (!min || p.priceFcfa < min.priceFcfa ? p : min), null);
  } catch (_) {}
  const text = cheapest
    ? `OmniSMS: solde insuffisant. Rechargez: envoyer "RECHARGE ${cheapest.id.replace('PACK_', '')}" au ${getGatewayOmNumber()} ou ${cheapest.priceFcfa}F Orange Money pour ${cheapest.sms} SMS.`
    : `OmniSMS: solde insuffisant. Envoyez PACKS au ${getGatewayOmNumber()} pour voir les recharges.`;
  try { await sendSms({ to: senderPhoneE164, text }); return true; }
  catch (_) { return false; }
}

/**
 * Push FCM avant SMS pour un destinataire OmniSMS hors ligne.
 * OFFLINE_PUSH_BEFORE_SMS=true requis. Hypothèse non testée en prod :
 * le token FCM est lu dans users/{uid}.fcmToken.
 * @returns {Promise<boolean>} true si un push a effectivement été envoyé
 */
async function tryPushWake(db, uid) {
  if (!isPushBeforeSmsEnabled()) return false;
  try {
    const d = getDb(db);
    if (!d) return false;
    const userSnap = await d.collection('users').doc(String(uid)).get();
    const token = userSnap && userSnap.exists ? userSnap.data().fcmToken : null;
    if (!token) return false;
    const admin = require('../firebase-admin/index');
    if (admin._stub || !admin.messaging) return false;
    await admin.messaging().send({
      token,
      data: { type: 'presence_wake', uid: String(uid) },
      android: { priority: 'high' },
    });
    await new Promise((r) => setTimeout(r, getLimits().pushWaitMs));
    return true;
  } catch (_) { return false; }
}

module.exports = {
  isCreditsEnabled, isInAppPurchaseUiAllowed, isPushBeforeSmsEnabled,
  consumeFreeUnit, refundFreeUnit, getFreeRemaining,
  chargeSmsSend, captureSmsSend, refundSmsSend,
  notifyInsufficientBalance, tryPushWake,
};
