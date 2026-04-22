'use strict';
/**
 * OmniSMS — Route /me
 *
 * Retourne le statut premium et les infos du compte connecté.
 * Utilise Firestore comme source de vérité.
 */

const express      = require('express');
const router       = express.Router();
const db           = require('../config/firebase');
const authenticate = require('../middleware/authenticate');
const { logger }   = require('../middleware/logger');

// ── GET /me ──────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'USER_NOT_FOUND' });
    }

    const user = snap.data();
    const { password: _pw, ...safeUser } = user;

    return res.status(200).json({
      id          : snap.id,
      premium     : user.isSubscribed || false,
      isSubscribed: user.isSubscribed || false,
      credits     : user.credits || 0,
      ...safeUser,
    });
  } catch (err) {
    logger.error('Erreur GET /me', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
