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

/* ── SESSION 13 — Détection des références #username / @username ──────────
 *
 * Règles (identiques à l'inscription routes/auth.js et PUT /me/profile) :
 *   - username : [a-zA-Z0-9_.-], 2 à 50 caractères, stocké en minuscules
 *     dans le champ Firestore `users.username`.
 *   - Un numéro de téléphone (+226…, 226…, 70…) n'est JAMAIS un username :
 *     la résolution téléphone reste prioritaire et inchangée.
 * ─────────────────────────────────────────────────────────────────────── */

// Tirets Unicode (‐ ‑ ‒ – — ― − ﹘ ﹣ －) insérés par certains claviers mobiles.
const UNICODE_DASHES_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
// Caractères invisibles (zero-width space/joiner, BOM) parfois collés au texte.
const ZERO_WIDTH_RE     = /[\u200B-\u200D\u2060\uFEFF]/g;
// Charset username officiel (auth.js : /^[a-zA-Z0-9_.-]+$/, longueur 2–50).
const USERNAME_REF_RE   = /^[a-zA-Z0-9_.-]{2,50}$/;
// Forme "numéro de téléphone" : chiffres + séparateurs usuels, sans lettre.
const PHONE_LIKE_RE     = /^\+?[\d\s\-().]{6,24}$/;

/**
 * Nettoie une saisie d'identifiant (sans modifier sa casse) :
 * normalisation NFKC (＃ → #, ＠ → @), tirets Unicode → '-', suppression des
 * caractères invisibles, trim.
 */
function cleanIdentifierInput(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  try { s = s.normalize('NFKC'); } catch (_) { /* environnement sans ICU */ }
  return s.replace(ZERO_WIDTH_RE, '').replace(UNICODE_DASHES_RE, '-').trim();
}

/**
 * true si la valeur a la forme d'un numéro de téléphone
 * (au moins 6 chiffres, aucune lettre). Ex : +22670123456, 22670123456, 70 12 34 56.
 */
function isPhoneLikeIdentifier(value) {
  if (value === null || value === undefined) return false;
  const s = String(value).trim();
  return PHONE_LIKE_RE.test(s) && s.replace(/\D/g, '').length >= 6;
}

/**
 * Analyse un identifiant destinataire portant un préfixe explicite # ou @.
 *
 *   '#petit-test' | '@petit-test' | '#@petit-test'
 *       → { kind: 'username', prefix, username: 'petit-test' }
 *   '#+22670123456' | '#22670123456'
 *       → { kind: 'phone', prefix, value: '+22670123456' | '22670123456',
 *           numericUsername: null | '22670123456' }   (chiffres purs uniquement)
 *   '#' | '#a' | '#hello world'
 *       → { kind: 'invalid', prefix, value }
 *   sans préfixe (#/@) ou vide → null (la logique existante s'applique)
 *
 * @param {string} raw
 * @returns {null|{kind: 'username'|'phone'|'invalid', prefix: string, username?: string, value?: string, numericUsername?: string|null}}
 */
function parseRecipientReference(raw) {
  let s = cleanIdentifierInput(raw);
  if (!s) return null;

  let prefix = null;
  if (s[0] === '#') {
    prefix = '#';
    s = s.slice(1).trim();
    if (s[0] === '@') s = s.slice(1).trim(); // "#@petit-test"
  } else if (s[0] === '@') {
    prefix = '@';
    s = s.slice(1).trim();
  }

  if (!prefix) return null;
  if (!s) return { kind: 'invalid', prefix, value: '' };

  // Un numéro reste un numéro (priorité téléphone, U5).
  if (isPhoneLikeIdentifier(s)) {
    const digitsOnly = /^\d+$/.test(s);
    return {
      kind           : 'phone',
      prefix,
      value          : s,
      // Username purement numérique possible (U7) — utilisé UNIQUEMENT si le
      // numéro ne correspond à aucun compte OmniSMS.
      numericUsername: digitsOnly && USERNAME_REF_RE.test(s) ? s : null,
    };
  }

  if (USERNAME_REF_RE.test(s)) {
    return { kind: 'username', prefix, username: normalizeUsername(s) };
  }

  return { kind: 'invalid', prefix, value: s };
}

/**
 * Raccourci : retourne le username normalisé d'une référence #username /
 * @username, ou null (numéro, saisie invalide ou sans préfixe).
 */
function parseUsernameReference(raw) {
  const ref = parseRecipientReference(raw);
  return ref && ref.kind === 'username' ? ref.username : null;
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
  if (!username || typeof username !== 'string') return { found: false };

  const { includeDeleted = false } = opts;
  const db = getDb();
  if (!db) return { found: false };

  // SESSION 13 : accepter "#petit-test" / "@petit-test" et les tirets Unicode
  // des claviers mobiles. Un username stocké ne peut jamais commencer par # ou @
  // (charset de l'inscription), ce nettoyage ne peut donc pas créer d'ambiguïté.
  const cleaned    = cleanIdentifierInput(username).replace(/^#\s*/, '').replace(/^@\s*/, '');
  const normalized = normalizeUsername(cleaned);
  if (!normalized) return { found: false };

  try {
    let snap = await db.collection('users')
      .where('username', '==', normalized)
      .limit(1)
      .get();

    // SESSION 13 : compatibilité comptes anciens dont le username aurait été
    // enregistré avec sa casse d'origine (avant la normalisation lowercase).
    // Correspondance EXACTE sur la saisie de l'utilisateur uniquement.
    if (snap.empty && cleaned && cleaned !== normalized) {
      snap = await db.collection('users')
        .where('username', '==', cleaned)
        .limit(1)
        .get();
    }

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

/* ── SESSION 13 — Destinataire saisi par username (#username) ─────────────── */

// UID Firestore auto-généré (users.add() → 20 caractères) ou UID Firebase Auth (28).
const GENERATED_UID_RE = /^[A-Za-z0-9]{20}$|^[A-Za-z0-9]{28}$/;

function maskPhoneForLog(phone) {
  return phone ? String(phone).replace(/\d{4}$/, '****') : null;
}

/**
 * Résout un destinataire saisi dans l'application lorsqu'il désigne un username.
 * Utilisé par POST /api/messages/send et Socket.IO `message:send` AVANT le
 * routage (messageRouter), afin que la chaîne soit :
 *   saisie brute → parse → username → UID → (routeMessage : profil → téléphone
 *   réel → présence → ONLINE Socket.IO / OFFLINE SMS).
 *
 * Statuts retournés :
 *   'resolved'     → { uid, username, phone, user }        username trouvé
 *   'not_found'    → { username }                          #username inconnu ou invalide
 *   'phone'        → { phoneValue }                        "#+226…" : numéro explicite
 *   'not_username' → logique existante inchangée (numéro, UID, saisie inconnue sans préfixe)
 *
 * @param {string} receiverId
 * @param {object} [opts]
 * @param {string}  [opts.phone]            champ `phone` éventuellement fourni par le client
 * @param {boolean} [opts.allowBare=true]   tenter un username SANS préfixe (jamais pour un
 *                                          numéro, un UID généré ou un UID existant)
 * @param {string}  [opts.source]           libellé pour les logs
 * @param {string}  [opts.senderUid]
 */
async function resolveRecipientUsername(receiverId, opts = {}) {
  const { phone = null, allowBare = true, source = 'app', senderUid = null } = opts;
  const ref = parseRecipientReference(receiverId);

  /* ── 1. Préfixe explicite # / @ ──────────────────────────────── */
  if (ref) {
    logger.info('[USERNAME] raw input received', {
      source,
      senderUid,
      rawInput: ref.kind === 'phone' ? maskPhoneForLog(cleanIdentifierInput(receiverId)) : cleanIdentifierInput(receiverId),
      kind    : ref.kind,
    });

    if (ref.kind === 'phone') {
      // "#+22670123456" → numéro explicite : la résolution téléphone existante
      // s'applique (priorité absolue au téléphone).
      if (ref.numericUsername) {
        const byPhone = await resolveUserByPhone(ref.value);
        if (!byPhone.found) {
          // U7 : username purement numérique, uniquement si le numéro n'est pas OmniSMS.
          const byUsername = await resolveUserByUsername(ref.numericUsername);
          if (byUsername.found) {
            logger.info('[USERNAME] resolved uid (username numérique, aucun compte avec ce numéro)', {
              source, username: ref.numericUsername, resolvedUid: byUsername.uid,
              resolvedPhone: maskPhoneForLog(byUsername.phone),
            });
            return {
              status  : 'resolved',
              username: ref.numericUsername,
              uid     : byUsername.uid,
              phone   : byUsername.phone || null,
              user    : byUsername,
              prefix  : ref.prefix,
            };
          }
        }
      }
      logger.info('[USERNAME] input is a phone number → résolution téléphone existante', {
        source, phone: maskPhoneForLog(ref.value),
      });
      return { status: 'phone', phoneValue: ref.value, prefix: ref.prefix };
    }

    if (ref.kind === 'invalid') {
      logger.warn('[USERNAME] username invalide → aucun envoi', {
        source, senderUid, rawInput: cleanIdentifierInput(receiverId).slice(0, 60),
      });
      return { status: 'not_found', username: ref.value || '', invalid: true, prefix: ref.prefix };
    }

    logger.info(`[USERNAME] parsed username=${ref.username}`, { source, senderUid });
    logger.info(`[USERNAME] resolving username=${ref.username}`, { source });
    const r = await resolveUserByUsername(ref.username);
    if (!r.found) {
      logger.warn(`[USERNAME] username not found=${ref.username} → aucun message, aucun SMS`, { source, senderUid });
      return { status: 'not_found', username: ref.username, prefix: ref.prefix };
    }
    logger.info(`[USERNAME] resolved uid=${r.uid}`, { source, username: ref.username });
    logger.info(`[USERNAME] resolved phone=${maskPhoneForLog(r.phone) || '(aucun numéro dans le profil)'}`, {
      source, username: ref.username, resolvedUid: r.uid,
    });
    return { status: 'resolved', username: ref.username, uid: r.uid, phone: r.phone || null, user: r, prefix: ref.prefix };
  }

  /* ── 2. Sans préfixe : username « nu » (ex. le client a retiré le #) ── */
  if (!allowBare || receiverId === null || receiverId === undefined) return { status: 'not_username' };
  const bare = cleanIdentifierInput(receiverId);
  if (!bare || !USERNAME_REF_RE.test(bare))  return { status: 'not_username' };
  if (isPhoneLikeIdentifier(bare))            return { status: 'not_username' }; // numéro → inchangé
  if (GENERATED_UID_RE.test(bare))            return { status: 'not_username' }; // UID → inchangé (0 lecture)
  if (phone && isPhoneLikeIdentifier(cleanIdentifierInput(phone))) {
    return { status: 'not_username' };  // compat : numéro fourni explicitement par le client
  }

  const byUid = await resolveUserByUid(bare);
  if (byUid.found) return { status: 'not_username' };                         // UID existant → inchangé

  const r = await resolveUserByUsername(bare);
  if (!r.found) return { status: 'not_username' };                            // comportement existant conservé

  logger.info(`[USERNAME] raw input received (sans préfixe) → parsed username=${normalizeUsername(bare)}`, { source, senderUid });
  logger.info(`[USERNAME] resolved uid=${r.uid}`, { source, username: normalizeUsername(bare) });
  logger.info(`[USERNAME] resolved phone=${maskPhoneForLog(r.phone) || '(aucun numéro dans le profil)'}`, {
    source, resolvedUid: r.uid,
  });
  return { status: 'resolved', username: normalizeUsername(bare), uid: r.uid, phone: r.phone || null, user: r, prefix: null };
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
  // Session 13 — références #username / @username
  cleanIdentifierInput,
  isPhoneLikeIdentifier,
  parseRecipientReference,
  parseUsernameReference,
  resolveRecipientUsername,
  // Vérifications unicité
  checkPhoneExists,
  checkEmailExists,
  checkUsernameExists,
};
