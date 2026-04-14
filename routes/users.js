'use strict';
/**
 * OmniSMS — Routes Utilisateurs
 *
 * Utilise Firestore comme base de données.
 * Aucune dépendance Mongoose/Parse.
 */

const express      = require('express');
const router       = express.Router();
const db           = require('../config/firebase');
const authenticate = require('../middleware/authenticate');
const { logger }   = require('../middleware/logger');

// ── POST /users/link — associer phone / publicId ─────────────
router.post('/link', authenticate, async (req, res) => {
  const { phone, publicId } = req.body;

  if (!phone && !publicId) {
    return res.status(400).json({ error: 'phone ou publicId requis.', code: 'MISSING_FIELDS' });
  }

  try {
    const ref  = db.collection('users').doc(req.user.uid);
    const snap = await ref.get();

    const now = new Date().toISOString();

    if (!snap.exists) {
      // Créer l'utilisateur s'il n'existe pas (premier accès)
      const newUser = {
        uid      : req.user.uid,
        phone    : phone  || null,
        publicId : publicId || null,
        channel  : 'online',
        lastSeen : now,
        createdAt: now,
        updatedAt: now,
      };
      await ref.set(newUser);
      return res.status(201).json({ id: req.user.uid, ...newUser });
    }

    const updates = { lastSeen: now, updatedAt: now, channel: 'online' };
    if (phone)    updates.phone    = phone;
    if (publicId) updates.publicId = publicId;

    await ref.update(updates);

    const updated = await ref.get();
    return res.status(200).json({ id: updated.id, ...updated.data() });
  } catch (err) {
    logger.error('Erreur /users/link', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── GET /users/:userId — récupérer un utilisateur ───────────
router.get('/:userId', authenticate, async (req, res) => {
  const { userId } = req.params;

  // Sécurité : un utilisateur ne peut voir que son propre profil
  if (req.user.uid !== userId) {
    return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
  }

  try {
    const snap = await db.collection('users').doc(userId).get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'NOT_FOUND' });
    }

    const { password: _pw, ...safeUser } = snap.data();
    return res.status(200).json({ id: snap.id, ...safeUser });
  } catch (err) {
    logger.error('Erreur GET /users/:userId', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

/**
 * Helper exporté — mettre à jour le canal de communication d'un utilisateur.
 * @param {FirebaseFirestore.DocumentReference} userRef
 * @param {'online'|'offline'} channel
 */
async function setUserChannel(userRef, channel) {
  const now = new Date().toISOString();
  await userRef.update({ channel, lastSeen: now, updatedAt: now });
}

module.exports = router;
module.exports.setUserChannel = setUserChannel;
