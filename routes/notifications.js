'use strict';
/**
 * OmniSMS — Routes Notifications
 *
 * Gère les préférences de notifications utilisateur.
 * Utilise Firestore comme base de données.
 */

const express      = require('express');
const router       = express.Router();
const db           = require('../config/firebase');
const authenticate = require('../middleware/authenticate');
const { logger }   = require('../middleware/logger');

// ── PUT /notifications/toggle — Activer/désactiver ──────────
router.put('/toggle', authenticate, async (req, res) => {
  const { notificationsEnabled } = req.body;

  if (typeof notificationsEnabled !== 'boolean') {
    return res.status(400).json({
      error: 'notificationsEnabled (boolean) est requis.',
      code : 'MISSING_FIELDS',
    });
  }

  try {
    await db.collection('users').doc(req.user.uid).update({
      notificationsEnabled,
      updatedAt: new Date().toISOString(),
    });

    logger.info('Notifications mises à jour', { uid: req.user.uid, notificationsEnabled });
    return res.status(200).json({ message: 'Préférences de notifications mises à jour.' });
  } catch (err) {
    logger.error('Erreur toggle notifications', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── PUT /notifications/preferences — Sons et alertes ────────
router.put('/preferences', authenticate, async (req, res) => {
  const { alertSettings, soundSettings } = req.body;

  if (!alertSettings && !soundSettings) {
    return res.status(400).json({
      error: 'alertSettings ou soundSettings requis.',
      code : 'MISSING_FIELDS',
    });
  }

  try {
    const updates = { updatedAt: new Date().toISOString() };
    if (alertSettings) updates.alertSettings = alertSettings;
    if (soundSettings) updates.soundSettings = soundSettings;

    await db.collection('users').doc(req.user.uid).update(updates);

    logger.info('Préférences notifications mises à jour', { uid: req.user.uid });
    return res.status(200).json({ message: 'Préférences de sons et alertes mises à jour.' });
  } catch (err) {
    logger.error('Erreur préférences notifications', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── GET /notifications/preferences — Lire les préférences ───
router.get('/preferences', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'USER_NOT_FOUND' });
    }

    const user = snap.data();
    return res.status(200).json({
      notificationsEnabled: user.notificationsEnabled ?? true,
      alertSettings       : user.alertSettings || {},
      soundSettings       : user.soundSettings || {},
    });
  } catch (err) {
    logger.error('Erreur GET préférences notifications', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
