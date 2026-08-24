'use strict';
/**
 * OmniSMS — Modèle Utilisateur SMS (Firestore)
 *
 * Collection Firestore : "users"
 * Clé du document      : numéro de téléphone normalisé (E.164)
 *
 * Structure d'un document :
 * {
 *   phone        : "+22670000000",
 *   name         : "Jean Dupont",
 *   createdAt    : "2026-01-01T00:00:00.000Z",
 *   updatedAt    : "2026-01-01T00:00:00.000Z",
 *   smsQuota     : 5,           ← crédits SMS restants
 *   isSubscribed : false,       ← abonnement premium actif
 *   subscribedAt : null,        ← date d'activation premium
 *   contacts     : [            ← carnet d'adresses
 *     { name: "Marie", phone: "+22671000000", addedAt: "..." },
 *   ]
 * }
 */

const db = require('../config/firebase');
const { normalizePhone } = require('../config/db');

const COLLECTION = 'users';
const DEFAULT_QUOTA = 5; // SMS gratuits par défaut

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function docRef(phone) {
  return db.collection(COLLECTION).doc(normalizePhone(phone));
}

// ─────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────

/**
 * Récupérer un utilisateur par son numéro de téléphone.
 * @returns {Promise<object|null>}
 */
async function getByPhone(phone) {
  const snap = await docRef(phone).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Créer un utilisateur (inscription via SMS).
 * @param {string} phone  - Numéro normalisé
 * @param {string} name   - Prénom / nom choisi
 * @returns {Promise<object>}
 */
async function create(phone, name) {
  const key = normalizePhone(phone);
  const now = new Date().toISOString();

  const data = {
    phone       : key,
    name        : name.trim(),
    createdAt   : now,
    updatedAt   : now,
    smsQuota    : DEFAULT_QUOTA,
    isSubscribed: false,
    subscribedAt: null,
    contacts    : [],
  };

  await db.collection(COLLECTION).doc(key).set(data);
  return { id: key, ...data };
}

/**
 * Obtenir ou créer un utilisateur (upsert léger).
 * Utilisé quand un inconnu envoie son premier SMS.
 */
async function getOrCreate(phone) {
  const user = await getByPhone(phone);
  if (user) return user;

  const key = normalizePhone(phone);
  const now = new Date().toISOString();
  const data = {
    phone       : key,
    name        : null,
    createdAt   : now,
    updatedAt   : now,
    smsQuota    : DEFAULT_QUOTA,
    isSubscribed: false,
    subscribedAt: null,
    contacts    : [],
  };
  await db.collection(COLLECTION).doc(key).set(data, { merge: true });
  return { id: key, ...data };
}

/**
 * Mettre à jour des champs d'un utilisateur.
 * @param {string} phone
 * @param {object} updates
 */
async function update(phone, updates) {
  await docRef(phone).update({ ...updates, updatedAt: new Date().toISOString() });
}

/**
 * Ajouter un contact à un utilisateur.
 * @param {string} ownerPhone    - Propriétaire du carnet
 * @param {string} contactName   - Nom du contact
 * @param {string} contactPhone  - Numéro du contact
 * @returns {Promise<{added:boolean, contact:object}>}
 */
async function addContact(ownerPhone, contactName, contactPhone) {
  const user = await getByPhone(ownerPhone);
  if (!user) throw new Error('Utilisateur non trouvé');

  const normalizedContact = normalizePhone(contactPhone);
  const contacts = user.contacts || [];

  // Vérifier si le contact existe déjà (par téléphone)
  const exists = contacts.some(c => c.phone === normalizedContact);
  if (exists) {
    return { added: false, contact: contacts.find(c => c.phone === normalizedContact) };
  }

  const newContact = {
    name   : contactName.trim(),
    phone  : normalizedContact,
    addedAt: new Date().toISOString(),
  };

  contacts.push(newContact);
  await update(ownerPhone, { contacts });

  return { added: true, contact: newContact };
}

/**
 * Supprimer un contact.
 * @param {string} ownerPhone
 * @param {string} contactPhone
 */
async function removeContact(ownerPhone, contactPhone) {
  const user = await getByPhone(ownerPhone);
  if (!user) throw new Error('Utilisateur non trouvé');

  const normalizedContact = normalizePhone(contactPhone);
  const contacts = (user.contacts || []).filter(c => c.phone !== normalizedContact);
  await update(ownerPhone, { contacts });
}

/**
 * Résoudre un destinataire (@nom ou numéro) depuis les contacts.
 * @param {string} ownerPhone - Numéro de l'expéditeur
 * @param {string} target     - "@Jean" ou "+22670000000" ou "70000000"
 * @returns {Promise<{phone:string, name:string|null}|null>}
 */
async function resolveTarget(ownerPhone, target) {
  const t = target.trim();

  // Numéro brut — normaliser et retourner
  // (testé en premier pour éviter de chercher "+2267..." dans les contacts)
  if (/^\+?\d[\d\s]*$/.test(t)) {
    try {
      const phone = normalizePhone(t);
      return { phone, name: null };
    } catch {
      return null;
    }
  }

  // Nom (avec ou sans @) — chercher dans les contacts.
  // Le préfixe d'envoi (* #) est retiré en amont par smsHandler,
  // donc "*Marie" arrive ici sous forme "Marie".
  {
    const name = t.replace(/^@/, '').toLowerCase();
    const user = await getByPhone(ownerPhone);
    if (!user) return null;

    const contact = (user.contacts || []).find(
      c => c.name.toLowerCase() === name || c.name.toLowerCase().startsWith(name)
    );
    if (contact) return { phone: contact.phone, name: contact.name };
    return null;
  }
}

/**
 * Activer l'abonnement premium pour un utilisateur.
 */
async function activatePremium(phone) {
  const now = new Date().toISOString();
  await update(phone, {
    isSubscribed: true,
    subscribedAt: now,
  });
}

/**
 * Décrémenter le quota SMS (pour non-abonnés).
 * @returns {Promise<{allowed:boolean, remaining:number}>}
 */
async function decrementQuota(phone) {
  const user = await getByPhone(phone);
  if (!user) return { allowed: false, remaining: 0 };

  if (user.isSubscribed) return { allowed: true, remaining: Infinity };

  const current = user.smsQuota || 0;
  if (current <= 0) return { allowed: false, remaining: 0 };

  await update(phone, { smsQuota: current - 1 });
  return { allowed: true, remaining: current - 1 };
}

module.exports = {
  getByPhone,
  create,
  getOrCreate,
  update,
  addContact,
  removeContact,
  resolveTarget,
  activatePremium,
  decrementQuota,
  DEFAULT_QUOTA,
  COLLECTION,
};
