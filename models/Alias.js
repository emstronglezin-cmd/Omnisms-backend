'use strict';
/**
 * OmniSMS — Modèle Alias (Firestore)
 *
 * Collection Firestore : "aliases"
 *
 * Un alias est TOUJOURS scopé à un expéditeur :
 *   (ownerPhone, alias) → targetPhone
 *
 * Un même alias "@MAMAN" peut exister pour deux utilisateurs différents
 * sans collision. L'identifiant du document est composé :
 *   `${ownerPhone}::${aliasNorm}`
 *
 * Structure d'un document :
 * {
 *   ownerPhone  : "+22670000000",   ← propriétaire de l'alias
 *   alias       : "MAMAN",          ← alias normalisé (MAJUSCULES, sans @)
 *   targetPhone : "+22671000000",   ← numéro cible
 *   targetName  : "Maman",          ← nom tel que saisi (casse originale)
 *   createdAt   : "2026-01-01T00:00:00.000Z",
 *   updatedAt   : "2026-01-01T00:00:00.000Z",
 * }
 *
 * NOUVEAU FICHIER — N'interagit pas avec les collections existantes.
 */

const db = require('../config/firebase');
const { normalizePhone } = require('../config/db');

const COLLECTION = 'aliases';

// ─────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────

/** Normaliser un alias : MAJUSCULES, sans @, trim */
function normalizeAlias(alias) {
  return String(alias).replace(/^@/, '').trim().toUpperCase();
}

/** Identifiant de document : ownerPhone::ALIAS */
function docId(ownerPhone, alias) {
  return `${normalizePhone(ownerPhone)}::${normalizeAlias(alias)}`;
}

/** Référence au document */
function docRef(ownerPhone, alias) {
  return db.collection(COLLECTION).doc(docId(ownerPhone, alias));
}

// ─────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────

/**
 * Créer ou mettre à jour un alias.
 * Si l'alias existe déjà pour cet ownerPhone, le targetPhone est mis à jour.
 *
 * @param {string} ownerPhone  - Numéro de l'expéditeur (propriétaire)
 * @param {string} alias       - Alias à enregistrer (ex: "MAMAN" ou "@MAMAN")
 * @param {string} targetPhone - Numéro cible (ex: "+22671000000")
 * @param {string} targetName  - Nom affiché (casse originale)
 * @returns {Promise<{created:boolean, alias:object}>}
 */
async function upsertAlias(ownerPhone, alias, targetPhone, targetName) {
  const owner      = normalizePhone(ownerPhone);
  const target     = normalizePhone(targetPhone);
  const aliasNorm  = normalizeAlias(alias);
  const now        = new Date().toISOString();

  const ref      = docRef(owner, aliasNorm);
  const existing = await ref.get();
  const created  = !existing.exists;

  const data = {
    ownerPhone : owner,
    alias      : aliasNorm,
    targetPhone: target,
    targetName : String(targetName).trim(),
    updatedAt  : now,
    ...(created ? { createdAt: now } : {}),
  };

  await ref.set(data, { merge: true });

  return { created, alias: { ...data, id: ref.id } };
}

/**
 * Résoudre un alias pour un expéditeur donné.
 *
 * @param {string} ownerPhone - Numéro de l'expéditeur
 * @param {string} alias      - Alias à résoudre (ex: "MAMAN" ou "@MAMAN")
 * @returns {Promise<{targetPhone:string, targetName:string}|null>}
 */
async function resolveAlias(ownerPhone, alias) {
  const snap = await docRef(ownerPhone, alias).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return { targetPhone: data.targetPhone, targetName: data.targetName };
}

/**
 * Lister tous les alias d'un expéditeur.
 *
 * @param {string} ownerPhone
 * @returns {Promise<Array>}
 */
async function listAliases(ownerPhone) {
  const owner = normalizePhone(ownerPhone);
  const snap  = await db.collection(COLLECTION)
    .where('ownerPhone', '==', owner)
    .orderBy('alias', 'asc')
    .get();

  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Supprimer un alias.
 *
 * @param {string} ownerPhone
 * @param {string} alias
 * @returns {Promise<boolean>} true si le document existait
 */
async function deleteAlias(ownerPhone, alias) {
  const ref  = docRef(ownerPhone, alias);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}

/**
 * Normaliser un alias (exposé pour les services qui en ont besoin).
 */
module.exports = {
  upsertAlias,
  resolveAlias,
  listAliases,
  deleteAlias,
  normalizeAlias,
  COLLECTION,
};
