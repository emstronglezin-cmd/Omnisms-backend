'use strict';
/**
 * OmniSMS — Route /me
 *
 * GET  /me                → profil complet
 * PUT  /me/profile        → mettre à jour nom, email, phone, bio
 * POST /me/avatar         → upload photo de profil (multipart)
 */

const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcrypt');
const db           = require('../config/firebase');
const authenticate = require('../middleware/authenticate');
const firebaseAuth = require('../middleware/firebaseAuth');
const { logger }   = require('../middleware/logger');

const auth = firebaseAuth;  // accepte Firebase token + JWT

/* ── GET /me ──────────────────────────────────────────────── */
router.get('/', auth, async (req, res) => {
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

/* ── PUT /me/profile ──────────────────────────────────────── */
router.put('/profile', auth, async (req, res) => {
  const uid = req.user.uid;
  const { name, email, phone, bio, password, username } = req.body;

  try {
    const updates = { updatedAt: new Date().toISOString() };

    if (name  !== undefined && name  !== null) updates.name  = String(name).trim();
    if (email !== undefined && email !== null) updates.email = String(email).toLowerCase().trim();
    if (phone !== undefined && phone !== null) updates.phone = String(phone).trim();
    if (bio   !== undefined && bio   !== null) updates.bio   = String(bio).trim();

    // Username: validate format + uniqueness check
    if (username !== undefined && username !== null) {
      const newUsername = String(username).toLowerCase().trim();

      if (!/^[a-zA-Z0-9_.-]{2,50}$/.test(newUsername)) {
        return res.status(400).json({
          error: 'Username invalide (lettres, chiffres, _ . - seulement, 2-50 caractères).',
          code : 'INVALID_USERNAME',
        });
      }

      // Check uniqueness: query users where username == newUsername (excluding self)
      const existing = await db.collection('users')
        .where('username', '==', newUsername)
        .limit(2)
        .get();

      const conflict = existing.docs.find(d => d.id !== uid);
      if (conflict) {
        return res.status(409).json({
          error: `Le nom d'utilisateur "@${newUsername}" est déjà utilisé.`,
          code : 'USERNAME_EXISTS',
        });
      }

      updates.username = newUsername;
    }

    if (password && password.length >= 8) {
      updates.password = await bcrypt.hash(password, 12);
    }

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.', code: 'NO_FIELDS' });
    }

    await db.collection('users').doc(uid).set(updates, { merge: true });
    logger.info('[Me] Profile updated', { uid, fields: Object.keys(updates) });

    // Return updated profile so frontend can refresh in one round-trip
    const snap = await db.collection('users').doc(uid).get();
    const user = snap.data() || {};
    const { password: _pw, ...safeUser } = user;

    return res.status(200).json({
      success: true,
      message: 'Profil mis à jour.',
      user   : { id: uid, ...safeUser },
    });
  } catch (err) {
    logger.error('Erreur PUT /me/profile', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

/* ── DELETE /me — Supprimer le compte ─────────────────────── */
router.delete('/', auth, async (req, res) => {
  const uid = req.user.uid;

  try {
    const now = new Date().toISOString();

    // Soft-delete: mark account as deleted, keep data for potential recovery
    await db.collection('users').doc(uid).set({
      deleted     : true,
      deletedAt   : now,
      updatedAt   : now,
      // Anonymise les données sensibles
      email       : `deleted_${uid}@omnisms.deleted`,
      phone       : null,
      name        : 'Compte supprimé',
      username    : `deleted_${uid.slice(-8)}`,
      avatar      : null,
    }, { merge: true });

    logger.info('[Me] Account deleted (soft)', { uid });

    return res.status(200).json({
      success: true,
      message: 'Compte supprimé avec succès.',
    });
  } catch (err) {
    logger.error('Erreur DELETE /me', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

/* ── POST /me/avatar ──────────────────────────────────────── */
// Upload photo de profil — multipart/form-data champ "avatar"
let imageUpload = null;
let buildFileUrl = null;

try {
  const uploadService = require('../services/uploadService');
  imageUpload  = uploadService.imageUpload;
  buildFileUrl = uploadService.buildFileUrl;
} catch (_) {}

if (imageUpload && buildFileUrl) {
  router.post(
    '/avatar',
    auth,
    imageUpload.single('avatar'),
    async (req, res) => {
      const uid = req.user.uid;

      if (!req.file) {
        return res.status(400).json({ error: 'Aucun fichier fourni. Champ: "avatar".', code: 'NO_FILE' });
      }

      try {
        const fileUrl = buildFileUrl('images', req.file.filename);

        await db.collection('users').doc(uid).set(
          { avatar: fileUrl, updatedAt: new Date().toISOString() },
          { merge: true }
        );

        logger.info('[Me] Avatar updated', { uid, url: fileUrl });

        return res.status(200).json({
          success  : true,
          avatarUrl: fileUrl,
          message  : 'Photo de profil mise à jour.',
        });
      } catch (err) {
        logger.error('Erreur POST /me/avatar', { error: err.message });
        return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
      }
    }
  );
} else {
  // Fallback si uploadService non disponible
  router.post('/avatar', auth, (req, res) => {
    return res.status(501).json({ error: 'Service upload non disponible.', code: 'UPLOAD_UNAVAILABLE' });
  });
}

module.exports = router;
