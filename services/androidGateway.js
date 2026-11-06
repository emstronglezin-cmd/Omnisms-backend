'use strict';
/**
 * OmniSMS — Passerelle Android propriétaire (stratégie SMS retenue).
 *
 * Principe : les SMS sortants sont écrits dans une OUTBOX PERSISTANTE
 * (Firestore, collection `sms_outbox`). Une application Android autorisée
 * (l'appareil passerelle, via sa carte SIM) récupère les tâches (claim),
 * les envoie avec l'app SMS du téléphone, puis confirme le résultat.
 *
 * Garanties :
 *  - persistance : les tâches survivent aux redémarrages (Firestore, pas de
 *    mémoire seule, pas de dépendance Redis/BullMQ) ;
 *  - idempotence : 1 tâche par messageId (id de document = messageId) ;
 *  - anti-doublon : claim TRANSACTIONNEL (une tâche `pending` ne peut être
 *    prise que par un seul appareil) + `claimedBy` vérifié sur le résultat ;
 *  - retries bornés : attempts incrémenté à chaque claim ; au-delà de
 *    GATEWAY_MAX_ATTEMPTS → échec définitif ;
 *  - reprise : une tâche `claimed` sans résultat depuis GATEWAY_STALE_MS
 *    est remise en `pending` au prochain claim (appareil mort/crashé) ;
 *  - sécurité : jetons d'appareil (aléatoires 256 bits, stockés hashés),
 *    révocation immédiate, aucune clé en clair dans les logs.
 *
 * INfiniReach reste disponible comme transport alternatif (voir
 * services/smsGateway.js) mais l'envoi n'en dépend PLUS lorsque
 * OFFLINE_SMS_PROVIDER=android_gateway.
 */

const crypto = require('crypto');
const { logger } = require('../middleware/logger');

const OUTBOX_COL = 'sms_outbox';
const DEVICES_COL = 'gateway_devices';
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.GATEWAY_MAX_ATTEMPTS || '3', 10) || 3);
const STALE_MS = Math.max(30000, parseInt(process.env.GATEWAY_STALE_MS || '300000', 10) || 300000);

function getDb() {
  try { return require('../config/firebase'); } catch (_) { return null; }
}

function isConfigured() {
  return String(process.env.OFFLINE_SMS_PROVIDER || '').trim().toLowerCase() === 'android_gateway' && !!getDb();
}
function isEnabled() { return isConfigured(); }

function nowIso() { return new Date().toISOString(); }

/** Journal sans secrets : numéro masqué, contenu jamais loggé. */
function maskPhone(p) { return p ? String(p).replace(/\d{4}$/, '****') : null; }

/* ── Envoi : écriture de la tâche dans l'outbox ─────────────── */

/**
 * Point d'entrée « transport » (même forme que les autres providers).
 * @returns {Promise<{success:boolean, provider:string, state?:string, queued?:boolean, error?:string}>}
 */
async function sendSMS({ to, text, messageId }) {
  if (!isConfigured()) return { success: false, provider: 'android_gateway', error: 'NOT_CONFIGURED' };
  if (!to || !text) return { success: false, provider: 'android_gateway', error: 'MISSING_FIELDS' };
  const db = getDb();
  try {
    const id = messageId ? String(messageId) : `gw-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    // set(merge) : re-enqueue du même messageId = no-op idempotent (pas de doublon)
    await db.collection(OUTBOX_COL).doc(id).set({
      messageId: id,
      to,
      text,
      status: 'pending',
      attempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }, { merge: true });
    logger.info('[AndroidGW] tâche en outbox', { messageId: id, to: maskPhone(to) });
    return { success: true, provider: 'android_gateway', queued: true, state: 'QUEUED_OUTBOX', messageId: id };
  } catch (err) {
    logger.error('[AndroidGW] échec écriture outbox', { error: err.message });
    return { success: false, provider: 'android_gateway', error: err.message };
  }
}

/* ── Appareils passerelle : enregistrement / révocation ─────── */

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Crée un appareil actif et renvoie son jeton EN CLAIR (une seule fois). */
async function registerDevice(name) {
  const db = getDb();
  if (!db) return { ok: false, error: 'NO_DB' };
  const deviceId = `dev-${crypto.randomBytes(6).toString('hex')}`;
  const token = crypto.randomBytes(32).toString('hex'); // 256 bits — montré UNE fois
  await db.collection(DEVICES_COL).doc(deviceId).set({
    deviceId,
    name: String(name || 'passerelle').slice(0, 60),
    tokenHash: hashToken(token),
    status: 'active',
    createdAt: nowIso(),
    lastSeenAt: null,
  });
  logger.info('[AndroidGW] appareil enregistré', { deviceId });
  return { ok: true, deviceId, token };
}

/** Révoque immédiatement un appareil (les claims/résultats seront refusés). */
async function revokeDevice(deviceId) {
  const db = getDb();
  if (!db) return { ok: false, error: 'NO_DB' };
  await db.collection(DEVICES_COL).doc(String(deviceId)).set(
    { status: 'revoked', revokedAt: nowIso() },
    { merge: true },
  );
  logger.info('[AndroidGW] appareil révoqué', { deviceId: String(deviceId) });
  return { ok: true };
}

/** Vérifie (deviceId, token) : actif + hash correspondant (timing-safe). */
async function verifyDevice(deviceId, token) {
  const db = getDb();
  if (!db || !deviceId || !token) return false;
  try {
    const snap = await db.collection(DEVICES_COL).doc(String(deviceId)).get();
    if (!snap || !snap.exists) return false;
    const d = snap.data();
    if (d.status !== 'active') return false;
    const expected = String(d.tokenHash || '');
    const given = hashToken(token);
    if (expected.length !== given.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  } catch (_) {
    return false;
  }
}

async function touchDevice(deviceId) {
  const db = getDb();
  try { await db.collection(DEVICES_COL).doc(String(deviceId)).set({ lastSeenAt: nowIso() }, { merge: true }); } catch (_) {}
}

/* ── Claim transactionnel + reprise des tâches abandonnées ──── */

/** Remet en `pending` les tâches claimées sans résultat depuis STALE_MS. */
async function requeueStale() {
  const db = getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  let n = 0;
  try {
    const snap = await db.collection(OUTBOX_COL).where('status', '==', 'claimed').limit(20).get();
    for (const doc of (snap.docs || [])) {
      const d = doc.data() || {};
      if ((d.claimedAt || '') >= cutoff) continue; // encore frais
      if ((d.attempts || 0) >= MAX_ATTEMPTS) {
        await doc.ref.set({ status: 'failed', lastError: 'stale_no_result', updatedAt: nowIso() }, { merge: true });
      } else {
        await doc.ref.set({ status: 'pending', lastError: 'stale_requeued', updatedAt: nowIso() }, { merge: true });
      }
      n++;
    }
  } catch (err) {
    logger.warn('[AndroidGW] requeueStale échoué (non bloquant)', { error: err.message });
  }
  return n;
}

/**
 * Claim transactionnel : réserve jusqu'à `limit` tâches `pending` pour
 * l'appareil. Deux appareils ne peuvent jamais obtenir la même tâche.
 */
async function claimTasks(deviceId, limit) {
  const db = getDb();
  if (!db) return { ok: false, error: 'NO_DB' };
  const n = Math.min(10, Math.max(1, parseInt(limit, 10) || 5));
  await requeueStale();
  const taken = [];
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.collection(OUTBOX_COL).where('status', '==', 'pending').limit(n));
      for (const doc of (snap.docs || [])) {
        const d = doc.data() || {};
        tx.update(doc.ref, {
          status: 'claimed',
          claimedBy: String(deviceId),
          claimedAt: nowIso(),
          attempts: (d.attempts || 0) + 1,
          updatedAt: nowIso(),
        });
        taken.push({
          messageId: d.messageId || doc.id,
          to: d.to,
          text: d.text,
          attempts: (d.attempts || 0) + 1,
          claimedAt: nowIso(),
        });
      }
    });
  } catch (err) {
    logger.error('[AndroidGW] claim échoué', { error: err.message });
    return { ok: false, error: err.message };
  }
  return { ok: true, tasks: taken };
}

/* ── Résultat d'envoi transmis par l'appareil ───────────────── */

/**
 * Applique le résultat d'un envoi rapporté par l'appareil.
 * Seul l'appareil qui a claimé la tâche peut la conclure (sinon FORBIDDEN).
 * Échec avec attempts < MAX → re-pending (retry) ; sinon échec définitif.
 * Met à jour le message interne (messages/{messageId}) comme processSmsJob.
 */
async function applyResult({ deviceId, messageId, success, error }) {
  const db = getDb();
  if (!db || !messageId) return { ok: false, code: 'BAD_REQUEST' };
  try {
    const ref = db.collection(OUTBOX_COL).doc(String(messageId));
    const snap = await ref.get();
    if (!snap || !snap.exists) return { ok: false, code: 'NOT_FOUND' };
    const d = snap.data() || {};
    if (d.status === 'sent') return { ok: true, already: true }; // idempotent
    if (d.claimedBy && d.claimedBy !== String(deviceId)) return { ok: false, code: 'FORBIDDEN' };

    if (success) {
      await ref.set({ status: 'sent', resultAt: nowIso(), updatedAt: nowIso(), lastError: null }, { merge: true });
      await updateInternalMessage(messageId, { status: 'sent', smsStatus: 'SENT', smsError: null });
      return { ok: true, status: 'sent' };
    }

    const attempts = d.attempts || 1;
    if (attempts < MAX_ATTEMPTS) {
      await ref.set({ status: 'pending', lastError: String(error || 'device_failure').slice(0, 200), updatedAt: nowIso() }, { merge: true });
      await updateInternalMessage(messageId, { status: 'pending', smsStatus: 'RETRY_QUEUED', smsError: String(error || '').slice(0, 200) });
      return { ok: true, status: 'retry_queued', attempts };
    }
    await ref.set({ status: 'failed', lastError: String(error || 'device_failure').slice(0, 200), resultAt: nowIso(), updatedAt: nowIso() }, { merge: true });
    await updateInternalMessage(messageId, { status: 'failed', smsStatus: 'FAILED', smsError: String(error || '').slice(0, 200) });
    return { ok: true, status: 'failed' };
  } catch (err) {
    logger.error('[AndroidGW] applyResult échoué', { error: err.message });
    return { ok: false, code: 'SERVER_ERROR', error: err.message };
  }
}

async function updateInternalMessage(messageId, fields) {
  const db = getDb();
  if (!db || !messageId) return;
  try {
    await db.collection('messages').doc(String(messageId)).set({
      ...fields,
      smsProvider: 'android_gateway',
      smsUpdatedAt: nowIso(),
    }, { merge: true });
  } catch (_) { /* message interne absent (SMS hors conversation) : non bloquant */ }
}

/** Compteurs outbox (monitoring, endpoint protégé ADMIN_KEY). */
async function outboxStats() {
  const db = getDb();
  if (!db) return null;
  const stats = { pending: 0, claimed: 0, sent: 0, failed: 0 };
  try {
    for (const s of Object.keys(stats)) {
      const snap = await db.collection(OUTBOX_COL).where('status', '==', s).limit(100).get();
      stats[s] = (snap.docs || []).length;
    }
  } catch (_) {}
  return stats;
}

module.exports = {
  isConfigured,
  isEnabled,
  sendSMS,
  registerDevice,
  revokeDevice,
  verifyDevice,
  claimTasks,
  applyResult,
  outboxStats,
  _internals: { OUTBOX_COL, DEVICES_COL, MAX_ATTEMPTS, STALE_MS, hashToken, requeueStale },
};
