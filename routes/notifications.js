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

/* ══════════════════════════════════════════════════════════════════
 * V3 — Registre des tokens de notifications PUSH distantes (FCM/APNs).
 * Coexiste avec les préférences ci-dessus et avec Socket.IO (temps réel).
 *  POST /notifications/register   {token, platform: android|ios|web, deviceId?}
 *  POST /notifications/unregister {token}
 *  GET  /notifications/devices    → appareils du compte (tokens masqués)
 * Le push distant ne remplace pas Socket.IO : il cible les appareils
 * SANS socket (app en arrière-plan ou fermée).
 * ══════════════════════════════════════════════════════════════════ */
const pushService = require('../services/pushService');

function validPushToken(t) {
  return typeof t === 'string' && t.length >= 20 && t.length <= 4096;
}

// POST /notifications/register — enregistrement / rafraîchissement du token
router.post('/register', authenticate, async (req, res) => {
  const { token, platform, deviceId } = req.body || {};
  if (!validPushToken(token)) {
    return res.status(400).json({ error: 'Token invalide (20 à 4096 caractères).', code: 'INVALID_TOKEN' });
  }
  if (platform && !['android', 'ios', 'web'].includes(platform)) {
    return res.status(400).json({ error: 'platform doit être android, ios ou web.', code: 'INVALID_PLATFORM' });
  }
  const r = await pushService.registerToken({
    uid: req.user.uid,
    token,
    platform: platform || 'android',
    deviceId,
  });
  if (!r.ok) {
    return res.status(500).json({ error: 'Enregistrement impossible.', code: r.code || 'SERVER_ERROR' });
  }
  const devices = await pushService.listDevices(req.user.uid);
  return res.status(201).json({ ok: true, created: !!r.created, platform: r.platform, devices });
});

// POST /notifications/unregister — suppression (logout de l'appareil)
router.post('/unregister', authenticate, async (req, res) => {
  const { token } = req.body || {};
  if (!validPushToken(token)) {
    return res.status(400).json({ error: 'Token invalide.', code: 'INVALID_TOKEN' });
  }
  const r = await pushService.unregisterToken({ uid: req.user.uid, token });
  if (!r.ok) {
    const map = { FORBIDDEN: 403 };
    return res.status(map[r.code] || 500).json({ error: r.code, code: r.code });
  }
  return res.status(200).json({ ok: true, removed: r.removed });
});

// GET /notifications/devices — appareils enregistrés (jamais de token en clair)
router.get('/devices', authenticate, async (req, res) => {
  const devices = await pushService.listDevices(req.user.uid);
  return res.status(200).json({ devices });
});

module.exports = router;
