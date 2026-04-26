'use strict';
/**
 * OmniSMS — Modèle Invitation (Firestore)
 *
 * Collection Firestore : "invitations"
 *
 * Quand un utilisateur envoie un message à un destinataire
 * qui n'est pas encore inscrit sur OmniSMS, on enregistre
 * une invitation et on ajoute au SMS : "via OmniSMS. Répondez
 * DÉMARRER pour vous connecter."
 *
 * Structure d'un document :
 * {
 *   inviterPhone  : "+22670000000",   ← qui a envoyé le message
 *   inviterName   : "Jean",           ← nom de l'inviteur (si connu)
 *   inviteePhone  : "+22671000000",   ← destinataire non inscrit
 *   messagePreview: "Bonjour...",     ← début du message envoyé (40 chars max)
 *   status        : "pending",        ← pending | joined
 *   sentAt        : "2026-01-01T...", ← date d'envoi de l'invitation
 *   joinedAt      : null,             ← date d'inscription (si rejoint)
 * }
 *
 * NOUVEAU FICHIER — N'interagit pas avec les collections existantes.
 */

const db = require('../config/firebase');
const { normalizePhone } = require('../config/db');

const COLLECTION = 'invitations';

// ─────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────

/**
 * Enregistrer une invitation.
 * Si une invitation identique (même inviter + invitee) existe déjà,
 * on la met à jour (updatedAt + incrémente sendCount) pour éviter les doublons.
 *
 * @param {object} params
 * @param {string} params.inviterPhone   - Numéro de l'inviteur
 * @param {string} params.inviterName    - Nom de l'inviteur (peut être null)
 * @param {string} params.inviteePhone   - Numéro du destinataire
 * @param {string} params.messagePreview - Aperçu du message (max 40 chars)
 * @returns {Promise<{created:boolean, invitation:object}>}
 */
async function recordInvitation({ inviterPhone, inviterName, inviteePhone, messagePreview }) {
  const inviter = normalizePhone(inviterPhone);
  const invitee = normalizePhone(inviteePhone);
  const now     = new Date().toISOString();

  // Clé de déduplication : inviter::invitee
  const docId = `${inviter}::${invitee}`;
  const ref   = db.collection(COLLECTION).doc(docId);
  const snap  = await ref.get();
  const created = !snap.exists;

  if (created) {
    const data = {
      inviterPhone  : inviter,
      inviterName   : inviterName ? String(inviterName).trim() : null,
      inviteePhone  : invitee,
      messagePreview: String(messagePreview || '').slice(0, 40),
      status        : 'pending',
      sentAt        : now,
      sendCount     : 1,
      joinedAt      : null,
    };
    await ref.set(data);
    return { created: true, invitation: { id: docId, ...data } };
  }

  // Déjà invité — incrémenter sendCount
  await ref.update({
    sendCount     : (snap.data().sendCount || 1) + 1,
    messagePreview: String(messagePreview || '').slice(0, 40),
    updatedAt     : now,
  });

  return {
    created   : false,
    invitation: { id: docId, ...snap.data(), updatedAt: now },
  };
}

/**
 * Marquer une invitation comme "rejoint" quand le destinataire s'inscrit.
 *
 * @param {string} inviteePhone - Numéro qui vient de s'inscrire
 * @returns {Promise<number>} Nombre d'invitations mises à jour
 */
async function markAsJoined(inviteePhone) {
  const invitee = normalizePhone(inviteePhone);
  const now     = new Date().toISOString();

  const snap = await db.collection(COLLECTION)
    .where('inviteePhone', '==', invitee)
    .where('status', '==', 'pending')
    .get();

  if (snap.empty) return 0;

  const batch = db.batch();
  snap.docs.forEach(d => {
    batch.update(d.ref, { status: 'joined', joinedAt: now });
  });
  await batch.commit();

  return snap.docs.length;
}

/**
 * Vérifier si un numéro a déjà été invité par quelqu'un.
 *
 * @param {string} inviteePhone
 * @returns {Promise<boolean>}
 */
async function hasBeenInvited(inviteePhone) {
  const invitee = normalizePhone(inviteePhone);
  const snap = await db.collection(COLLECTION)
    .where('inviteePhone', '==', invitee)
    .limit(1)
    .get();
  return !snap.empty;
}

module.exports = {
  recordInvitation,
  markAsJoined,
  hasBeenInvited,
  COLLECTION,
};
