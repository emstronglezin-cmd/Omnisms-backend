'use strict';
/**
 * OmniSMS — Notifications push distantes (FCM Android / APNs via Firebase).
 *
 * Architecture (V3) :
 *  - registre de tokens : collection Firestore `device_tokens`, 1 document par
 *    appareil (id = sha256(token)) : {uid, token, platform, deviceId?, …} ;
 *  - coexistence : Socket.IO reste le canal TEMPS RÉEL (app au premier plan) ;
 *    le push FCM/APNs cible les appareils SANS socket (app en arrière-plan ou
 *    fermée) — les deux mécanismes cohabitent, ni l'un ni l'autre n'est remplacé ;
 *  - invalidation : les tokens rejetés par FCM (uninstalled/invalid) sont
 *    supprimés automatiquement après l'envoi ;
 *  - iOS : l'app iOS obtient un token FCM (SDK Firebase) et l'enregistre avec
 *    platform='ios' — côté serveur le chemin est identique ; la distribution
 *    APNs exige que la clé APNs (.p8) soit configurée dans la console Firebase
 *    (action console, pas de code backend).
 *
 * Sécurité : les tokens ne sont JAMAIS loggés en clair ni renvoyés (masqués).
 */

const crypto = require('crypto');
const { logger } = require('../middleware/logger');

const TOKENS_COL = 'device_tokens';
const PLATFORMS = ['android', 'ios', 'web'];

function getDb() {
  try { return require('../config/firebase'); } catch (_) { return null; }
}
function getMessaging() {
  try {
    const admin = require('../firebase-admin/index');
    if (admin._stub || !admin.messaging) return null;
    return admin.messaging();
  } catch (_) { return null; }
}

function maskToken(t) { return t ? `${String(t).slice(0, 8)}…${String(t).slice(-4)}` : null; }
function tokenDocId(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function nowIso() { return new Date().toISOString(); }

/** Enregistre / rafraîchit un token pour un utilisateur (upsert, ré-assignation si changement de compte). */
async function registerToken({ uid, token, platform, deviceId }) {
  const db = getDb();
  if (!db || !uid || !token) return { ok: false, code: 'BAD_REQUEST' };
  const p = PLATFORMS.includes(platform) ? platform : 'android';
  const id = tokenDocId(token);
  try {
    const ref = db.collection(TOKENS_COL).doc(id);
    const snap = await ref.get();
    const existing = snap && snap.exists ? snap.data() : null;
    await ref.set({
      tokenHashPrefix: id.slice(0, 12), // diagnostic sans révéler le token
      uid: String(uid),                  // ré-assignation automatique si l'appareil change de compte
      token: String(token),              // nécessaire à l'envoi — jamais loggé ni renvoyé
      platform: p,
      deviceId: deviceId ? String(deviceId).slice(0, 128) : null,
      createdAt: existing ? (existing.createdAt || nowIso()) : nowIso(),
      updatedAt: nowIso(),
    }, { merge: true });
    if (existing && existing.uid !== String(uid)) {
      logger.info('[Push] token ré-assigné à un autre compte', { platform: p, from: '***', to: '***' });
    }
    return { ok: true, created: !existing, platform: p };
  } catch (err) {
    logger.error('[Push] registerToken échoué', { error: err.message });
    return { ok: false, code: 'SERVER_ERROR', error: err.message };
  }
}

/** Supprime le token d'un utilisateur (déconnexion / logout). Sans uid → exige uid. */
async function unregisterToken({ uid, token }) {
  const db = getDb();
  if (!db || !uid || !token) return { ok: false, code: 'BAD_REQUEST' };
  try {
    const ref = db.collection(TOKENS_COL).doc(tokenDocId(token));
    const snap = await ref.get();
    if (!snap || !snap.exists) return { ok: true, removed: 0 };
    const d = snap.data() || {};
    if (d.uid !== String(uid)) return { ok: false, code: 'FORBIDDEN' }; // un compte ne supprime pas le token d'un autre
    await ref.delete();
    return { ok: true, removed: 1 };
  } catch (err) {
    logger.error('[Push] unregisterToken échoué', { error: err.message });
    return { ok: false, code: 'SERVER_ERROR', error: err.message };
  }
}

/** Liste des appareils d'un utilisateur — tokens MASQUÉS. */
async function listDevices(uid) {
  const db = getDb();
  if (!db || !uid) return [];
  try {
    const snap = await db.collection(TOKENS_COL).where('uid', '==', String(uid)).limit(50).get();
    return (snap.docs || []).map((doc) => {
      const d = doc.data() || {};
      return {
        id       : doc.id.slice(0, 12),
        platform : d.platform || null,
        deviceId : d.deviceId || null,
        tokenMask: maskToken(d.token),
        updatedAt: d.updatedAt || null,
      };
    });
  } catch (_) {
    return [];
  }
}

/** Erreurs FCM qui signifient « ce token ne servira plus jamais » → nettoyage. */
function isInvalidTokenError(e) {
  const m = String((e && (e.code || e.message)) || '');
  return /registration-token-not-registered|invalid-registration-token|unregistered|invalid-argument|mismatch/i.test(m);
}

/**
 * Envoie une push notification à TOUS les appareils d'un utilisateur.
 * Ne lève jamais : le push est un complément, jamais un chemin critique.
 * @returns {{attempted, sent, failed, invalidRemoved, skipped?}}
 */
async function sendPushToUser(uid, { title, body, data } = {}) {
  const db = getDb();
  if (!db || !uid) return { attempted: 0, sent: 0, failed: 0, invalidRemoved: 0, skipped: 'no_db' };
  // Respect des PRÉFÉRENCES utilisateur (PUT /notifications/toggle) :
  // notificationsEnabled === false → aucun push distant.
  try {
    const uSnap = await db.collection('users').doc(String(uid)).get();
    if (uSnap && uSnap.exists && (uSnap.data() || {}).notificationsEnabled === false) {
      return { attempted: 0, sent: 0, failed: 0, invalidRemoved: 0, skipped: 'disabled_by_user' };
    }
  } catch (_) { /* préférence illisible → on tente l'envoi (défaut = activé) */ }
  let tokens = [];
  try {
    const snap = await db.collection(TOKENS_COL).where('uid', '==', String(uid)).limit(50).get();
    tokens = (snap.docs || []).map((doc) => ({ docId: doc.id, token: (doc.data() || {}).token })).filter((x) => x.token);
  } catch (err) {
    logger.warn('[Push] lecture tokens échouée (non bloquant)', { error: err.message });
    return { attempted: 0, sent: 0, failed: 0, invalidRemoved: 0, skipped: 'db_error' };
  }
  if (!tokens.length) return { attempted: 0, sent: 0, failed: 0, invalidRemoved: 0, skipped: 'no_devices' };

  const messaging = getMessaging();
  if (!messaging) return { attempted: 0, sent: 0, failed: 0, invalidRemoved: 0, skipped: 'push_unavailable' };

  const payload = {
    notification: { title: String(title || 'OmniSMS').slice(0, 120), body: String(body || '').slice(0, 240) },
    data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
  };

  let sent = 0, failed = 0;
  const invalid = [];
  try {
    if (typeof messaging.sendEachForMulticast === 'function') {
      const resp = await messaging.sendEachForMulticast({
        ...payload,
        tokens: tokens.map((t) => t.token),
        android: { priority: 'high' },
        apns: { headers: { 'apns-priority': '10' } },
      });
      sent = resp.successCount || 0;
      failed = resp.failureCount || 0;
      (resp.responses || []).forEach((r, i) => {
        if (r.success === false && isInvalidTokenError(r.error)) invalid.push(tokens[i]);
      });
    } else {
      for (const t of tokens) {
        try { await messaging.send({ ...payload, token: t.token }); sent++; }
        catch (e) { failed++; if (isInvalidTokenError(e)) invalid.push(t); }
      }
    }
  } catch (err) {
    logger.warn('[Push] envoi échoué (non bloquant)', { error: err.message });
    return { attempted: tokens.length, sent, failed, invalidRemoved: 0, skipped: 'send_error' };
  }

  // Invalidation : token désinstallé/invalide → suppression (renouvellement par l'app au prochain lancement)
  let invalidRemoved = 0;
  for (const t of invalid) {
    try { await db.collection(TOKENS_COL).doc(t.docId).delete(); invalidRemoved++; } catch (_) {}
  }
  if (sent > 0) logger.info('[Push] notification envoyée', { uid: '***', sent, failed, invalidRemoved });
  return { attempted: tokens.length, sent, failed, invalidRemoved };
}

module.exports = {
  registerToken,
  unregisterToken,
  listDevices,
  sendPushToUser,
  _internals: { TOKENS_COL, PLATFORMS, isInvalidTokenError, maskToken, tokenDocId },
};
