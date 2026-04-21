'use strict';
/**
 * OmniSMS — Routes Statistiques
 *
 * Utilise Firestore comme source de vérité.
 */

const express      = require('express');
const router       = express.Router();
const db           = require('../config/firebase');
const authenticate = require('../middleware/authenticate');
const { logger }   = require('../middleware/logger');

// ── GET /statistics — Statistiques de l'utilisateur ─────────
router.get('/', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;

    const [sentSnap, receivedSnap] = await Promise.all([
      db.collection('messages').where('senderId', '==', uid).select().get(),
      db.collection('messages').where('receiverId', '==', uid).select().get(),
    ]);

    return res.status(200).json({
      messagesSent    : sentSnap.size,
      messagesReceived: receivedSnap.size,
      userId          : uid,
    });
  } catch (err) {
    logger.error('Erreur statistics', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
