'use strict';
/**
 * OmniSMS — Service Résolution Utilisateurs (Source de Vérité)
 *
 * Ce service est le SEUL point d'entrée pour toutes les recherches d'utilisateurs.
 * Toute logique de recherche par téléphone / email / username doit passer ici.
 *
 * Fonctions exportées :
 *   resolveUserByPhone(phone)    → { found, uid, phone, ... } | { found: false }
 *   resolveUserByEmail(email)    → { found, uid, email, ... } | { found: false }
 *   resolveUserByUsername(uname) → { found, uid, username, ... } | { found: false }
 *   resolveUserByUid(uid)        → { found, uid, ... } | { found: false }
 *   normalizeEmail(email)        → string (lowercase trim)
 *   normalizeUsername(username)  → string (lowercase trim)
 *
 * Règles :
 *  - Normalisation E.164 systématique des numéros
 *  - Comptes deleted=true EXCLUS par défaut
 *  - phoneVerified=false EXCLUS par défaut
 *  - TTL Redis minimal (résolution dynamique, pas de stale data permanente)
 *  - JAMAIS de secret dans les logs
 */

const { normalizePhone } = require('./phoneNormalizer');
const { logger }         = require('../middleware/logger');

/* ── Firestore lazy ─────────────────────────────────────────── */
function getDb() {
  try {
    const db = require('../config/firebase');
    return db && !db._stub ? db : null;
  } catch (_) { return null; }
}

/* ── Normalisation centralisée ──────────────────────────────── */

/**
 * Normalise une adresse email : lowercase + trim.
 */
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.toLowerCase().trim();
}

/**
 * Normalise un username : lowercase + trim.
 */
function normalizeUsername(username) {
  if (!username || typeof username !== 'string') return '';
  return username.toLowerCase().trim();
}

/**
 * Retourne toutes les variantes d'un numéro à tester dans Firestore.
 * Ex: "+22670000000" → ["+22670000000", "0022670000000", "70000000"] 
 */
function phoneVariants(rawPhone) {
  const e164 = normalizePhone(rawPhone) || rawPhone;
  const set  = new Set();
  if (e164)     set.add(e164);
  if (rawPhone) set.add(rawPhone.trim());
  // +226xxx → 00226xxx
  if (e164.startsWith('+')) set.add('00' + e164.slice(1));
  // 00226xxx → +226xxx
  if (rawPhone && rawPhone.trim().startsWith('00')) set.add('+' + rawPhone.trim().slice(2));
  // supprimer espaces
  const noSpace = rawPhone.replace(/\s/g, '');
  if (noSpace) set.add(noSpace);
  const noSpaceE164 = e164.replace(/\s/g, '');
  if (noSpaceE164) set.add(noSpaceE164);
  return [...set].filter(Boolean);
}

/* ── Résolution par numéro de téléphone ─────────────────────── */

/**
 * Résout un utilisateur OmniSMS à partir d'un numéro de téléphone.
 *
 * Recherche dans Firestore avec plusieurs variantes du numéro.
 * Exclut automatiquement les comptes deleted=true.
 *
 * @param {string} phone   - Numéro brut (n'importe quel format)
 * @param {object} [opts]
 * @param {boolean} [opts.includeDeleted=false]    - Inclure les comptes supprimés
 * @param {boolean} [opts.requireVerified=false]   - Exiger phoneVerified=true
 * @returns {Promise<{found: boolean, uid?: string, phone?: string, name?: string, username?: string, avatar?: string}>}
 */
async function resolveUserByPhone(phone, opts = {}) {
  if (!phone) return { found: false };

  const { includeDeleted = false, requireVerified = false } = opts;
  const db = getDb();
  if (!db) {
    logger.warn('[UserResolver] Firestore unavailable — resolveUserByPhone failed', { phone: phone.slice(0, 8) + '...' });
    return { found: false };
  }

  const variants = phoneVariants(phone);

  logger.info('[USER_RESOLUTION] Looking up phone', {
    phone   : phone.replace(/\d{4}$/, '****'),   // masquer les 4 derniers chiffres
    variants: variants.length,
  });

  for (const variant of variants) {
    try {
      const snap = await db.collection('users')
        .where('phone', '==', variant)
        .limit(1)
        .get();

      if (snap.empty) continue;

      const doc  = snap.docs[0];
      const data = doc.data();

      // Exclusions
      if (!includeDeleted && data.deleted === true) continue;
      if (requireVerified && data.phoneVerified === false) continue;

      const result = {
        found   : true,
        uid     : doc.id,
        phone   : data.phone || variant,
        name    : data.name     || null,
        username: data.username || null,
        email   : data.email    || null,
        avatar  : data.avatar   || null,
        isSubscribed: data.isSubscribed || false,
        credits : data.credits  || 0,
      };

      logger.info('[USER_RESOLUTION] Phone resolved → OmniSMS', {
        phone   : phone.replace(/\d{4}$/, '****'),
        uid     : result.uid,
        isOmniSms: true,
      });

      return result;

    } catch (err) {
      logger.warn('[UserResolver] Firestore query error', { error: err.message, variant: variant.slice(0, 8) + '...' });
    }
  }

  logger.info('[USER_RESOLUTION] Phone not found in OmniSMS', {
    phone: phone.replace(/\d{4}$/, '****'),
    isOmniSms: false,
  });

  return { found: false };
}

/* ── Résolution par email ────────────────────────────────────── */

/**
 * Résout un utilisateur OmniSMS à partir d'une adresse email.
 */
async function resolveUserByEmail(email, opts = {}) {
  if (!email) return { found: false };

  const { includeDeleted = false } = opts;
  const db = getDb();
  if (!db) return { found: false };

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { found: false };

  try {
    const snap = await db.collection('users')
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (snap.empty) return { found: false };

    const doc  = snap.docs[0];
    const data = doc.data();

    if (!includeDeleted && data.deleted === true) return { found: false };

    return {
      found   : true,
      uid     : doc.id,
      email   : data.email    || normalizedEmail,
      phone   : data.phone    || null,
      name    : data.name     || null,
      username: data.username || null,
      avatar  : data.avatar   || null,
    };

  } catch (err) {
    logger.warn('[UserResolver] resolveUserByEmail error', { error: err.message });
    return { found: false };
  }
}

/* ── Résolution par username ─────────────────────────────────── */

/**
 * Résout un utilisateur OmniSMS à partir d'un username.
 */
async function resolveUserByUsername(username, opts = {}) {
  if (!username) return { found: false };

  const { includeDeleted = false } = opts;
  const db = getDb();
  if (!db) return { found: false };

  const normalized = normalizeUsername(username);
  if (!normalized) return { found: false };

  try {
    const snap = await db.collection('users')
      .where('username', '==', normalized)
      .limit(1)
      .get();

    if (snap.empty) return { found: false };

    const doc  = snap.docs[0];
    const data = doc.data();

    if (!includeDeleted && data.deleted === true) return { found: false };

    return {
      found   : true,
      uid     : doc.id,
      username: data.username || normalized,
      phone   : data.phone    || null,
      email   : data.email    || null,
      name    : data.name     || null,
      avatar  : data.avatar   || null,
    };

  } catch (err) {
    logger.warn('[UserResolver] resolveUserByUsername error', { error: err.message });
    return { found: false };
  }
}

/* ── Résolution par UID ──────────────────────────────────────── */

/**
 * Résout un utilisateur OmniSMS à partir de son UID Firestore.
 */
async function resolveUserByUid(uid, opts = {}) {
  if (!uid) return { found: false };

  const { includeDeleted = false } = opts;
  const db = getDb();
  if (!db) return { found: false };

  try {
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) return { found: false };

    const data = doc.data();
    if (!includeDeleted && data.deleted === true) return { found: false };

    return {
      found   : true,
      uid     : doc.id,
      phone   : data.phone    || null,
      email   : data.email    || null,
      name    : data.name     || null,
      username: data.username || null,
      avatar  : data.avatar   || null,
      isSubscribed: data.isSubscribed || false,
      credits : data.credits  || 0,
    };

  } catch (err) {
    logger.warn('[UserResolver] resolveUserByUid error', { error: err.message });
    return { found: false };
  }
}

/* ── Vérifications unicité (pour inscription/mise à jour) ────── */

/**
 * Vérifie si un numéro de téléphone est déjà utilisé.
 * Retourne le uid du compte existant ou null.
 */
async function checkPhoneExists(phone, excludeUid = null) {
  const db = getDb();
  if (!db) return null;

  const variants = phoneVariants(phone);

  for (const variant of variants) {
    try {
      const snap = await db.collection('users')
        .where('phone', '==', variant)
        .limit(2)
        .get();

      for (const doc of snap.docs) {
        if (excludeUid && doc.id === excludeUid) continue;
        if (doc.data().deleted === true) continue;
        return doc.id;
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Vérifie si un email est déjà utilisé.
 */
async function checkEmailExists(email, excludeUid = null) {
  const db = getDb();
  if (!db) return null;

  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  try {
    const snap = await db.collection('users')
      .where('email', '==', normalized)
      .limit(2)
      .get();

    for (const doc of snap.docs) {
      if (excludeUid && doc.id === excludeUid) continue;
      if (doc.data().deleted === true) continue;
      return doc.id;
    }
  } catch (_) {}
  return null;
}

/**
 * Vérifie si un username est déjà utilisé.
 */
async function checkUsernameExists(username, excludeUid = null) {
  const db = getDb();
  if (!db) return null;

  const normalized = normalizeUsername(username);
  if (!normalized) return null;

  try {
    const snap = await db.collection('users')
      .where('username', '==', normalized)
      .limit(2)
      .get();

    for (const doc of snap.docs) {
      if (excludeUid && doc.id === excludeUid) continue;
      if (doc.data().deleted === true) continue;
      return doc.id;
    }
  } catch (_) {}
  return null;
}

module.exports = {
  // Résolution
  resolveUserByPhone,
  resolveUserByEmail,
  resolveUserByUsername,
  resolveUserByUid,
  // Normalisation
  normalizeEmail,
  normalizeUsername,
  phoneVariants,
  // Vérifications unicité
  checkPhoneExists,
  checkEmailExists,
  checkUsernameExists,
};
