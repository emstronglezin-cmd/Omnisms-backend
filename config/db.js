'use strict';
/**
 * OmniSMS — Firestore Database Adapter
 *
 * Remplace l'ancien in-memory store par Firestore (production).
 * Expose la même interface (findUserByPhone, upsertUser, updateUser, …)
 * pour la compatibilité avec l'existant, tout en persistant toutes
 * les données sur Firebase Firestore.
 *
 * Collection Firestore utilisée : "users_sms"
 * Collection logs paiement      : "payment_logs"
 */

const db = require('./firebase');

// ─────────────────────────────────────────────────────────────
// Normalisation du numéro de téléphone
// ─────────────────────────────────────────────────────────────

/**
 * Normaliser un numéro de téléphone au format E.164.
 * - Supprime espaces, tirets, parenthèses
 * - Remplace le préfixe 00 par +
 * - Ajoute l'indicatif +226 (Burkina Faso) si absent
 */
function normalizePhone(phone) {
  if (!phone) return '';
  let p = String(phone).replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) p = '+226' + p;
  return p;
}

// ─────────────────────────────────────────────────────────────
// Helpers Firestore
// ─────────────────────────────────────────────────────────────

/** Référence au document d'un utilisateur par téléphone */
function userRef(phone) {
  return db.collection('users_sms').doc(normalizePhone(phone));
}

// ─────────────────────────────────────────────────────────────
// API publique — compatible avec l'ancien interface
// ─────────────────────────────────────────────────────────────

/**
 * Trouver un utilisateur par numéro de téléphone.
 * @returns {Promise<object|null>}
 */
async function findUserByPhone(phone) {
  try {
    const snap = await userRef(phone).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...snap.data() };
  } catch (err) {
    console.error('[db] findUserByPhone error:', err.message);
    return null;
  }
}

/**
 * Créer ou mettre à jour un utilisateur.
 * @returns {Promise<object>} Données fusionnées après upsert
 */
async function upsertUser(phone, data = {}) {
  const key = normalizePhone(phone);
  const ref = db.collection('users_sms').doc(key);

  const defaults = {
    phone     : key,
    credits   : 0,
    premium   : false,
    createdAt : new Date().toISOString(),
    lastPaymentAt     : null,
    premiumActivatedAt: null,
    activationIp      : null,
  };

  // merge: true → ne supprime pas les champs existants
  const toWrite = { ...defaults, ...data, phone: key };
  await ref.set(toWrite, { merge: true });

  const snap = await ref.get();
  return { id: snap.id, ...snap.data() };
}

/**
 * Mettre à jour un utilisateur existant (pas de création).
 * @returns {Promise<object|null>}
 */
async function updateUser(phone, data) {
  const key = normalizePhone(phone);
  const ref = db.collection('users_sms').doc(key);
  const snap = await ref.get();

  if (!snap.exists) return null;

  await ref.update({ ...data, updatedAt: new Date().toISOString() });

  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}

/**
 * Ajouter un log de paiement (anti-fraude, audit).
 * Persiste dans la collection "payment_logs" Firestore.
 */
async function addPaymentLog(entry) {
  try {
    await db.collection('payment_logs').add({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Ne pas bloquer le flux principal si le log échoue
    console.error('[db] addPaymentLog error:', err.message);
  }
}

/**
 * Récupérer les N derniers logs de paiement (admin/debug).
 * @param {number} [limit=100]
 * @returns {Promise<Array>}
 */
async function getPaymentLogs(limit = 100) {
  try {
    const snap = await db
      .collection('payment_logs')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('[db] getPaymentLogs error:', err.message);
    return [];
  }
}

/**
 * Compter le nombre d'utilisateurs SMS.
 * @returns {Promise<number>}
 */
async function getUserCount() {
  try {
    // Firestore ne propose pas de COUNT natif gratuit ;
    // on utilise un compteur agrégé stocké dans un document dédié.
    const snap = await db.collection('users_sms').select().get();
    return snap.size;
  } catch (err) {
    console.error('[db] getUserCount error:', err.message);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// Compatibilité rétroactive : store fictif (ne plus utiliser)
// ─────────────────────────────────────────────────────────────
/**
 * @deprecated Utiliser les fonctions async ci-dessus.
 * Conservé uniquement pour ne pas casser d'éventuelles
 * références directes à `store`.
 */
const store = {
  get users() {
    console.warn('[db] store.users est déprécié — utiliser findUserByPhone()');
    return new Map();
  },
  paymentLogs: [],
};

module.exports = {
  findUserByPhone,
  upsertUser,
  updateUser,
  addPaymentLog,
  getPaymentLogs,
  normalizePhone,
  getUserCount,
  store,   // rétrocompat (déprécié)
};
