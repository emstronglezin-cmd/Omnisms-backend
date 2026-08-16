'use strict';
/**
 * OmniSMS — Route /me
 *
 * GET    /me             → profil complet
 * PUT    /me/profile     → mettre à jour nom, email, phone, bio, username
 * POST   /me/avatar      → upload photo de profil (multipart OU base64)
 * DELETE /me             → soft-delete du compte
 */

const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcrypt');
const db           = require('../config/firebase');
const firebaseAuth = require('../middleware/firebaseAuth');
const { logger }   = require('../middleware/logger');
const { normalizePhone } = require('../services/phoneNormalizer');

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
    if (phone !== undefined && phone !== null) {
      // Stocker en format E.164 canonique pour des recherches cohérentes
      const rawPhone  = String(phone).trim();
      const e164Phone = normalizePhone(rawPhone) || rawPhone;
      updates.phone = e164Phone;
      if (e164Phone !== rawPhone) updates.phoneRaw = rawPhone;
    }
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
// Stratégie dual:
//   1. Essaie l'upload multipart (multer) → stocke base64 dans Firestore (pas de dépendance FS)
//   2. Accepte aussi body JSON { avatarBase64: "data:image/png;base64,..." }
// Stocker en base64 dans Firestore résout l'ephemeral FS de Render (pas de 404 après redeploy).
// Limite: 800 KB en base64 (≈ 600 KB fichier original) — suffisant pour photos de profil compressées.

const MAX_AVATAR_B64 = 800 * 1024; // 800 KB en base64

// Essayer de charger multer/uploadService (optionnel — on peut aussi recevoir base64 directement)
let imageUpload = null;
let multerErrorHandler = null;
try {
  const uploadService = require('../services/uploadService');
  imageUpload         = uploadService.imageUpload;
  multerErrorHandler  = uploadService.multerErrorHandler;
} catch (_) {}

router.post('/avatar', auth, (req, res, next) => {
  // Cas 1: body JSON avec avatarBase64 (envoyé par le frontend si multipart non disponible)
  if (req.is('application/json') || req.body?.avatarBase64) {
    return next();
  }

  // Cas 2: multipart/form-data — on wrap multer dans un callback pour capturer les erreurs
  if (imageUpload) {
    imageUpload.single('avatar')(req, res, (err) => {
      if (err) {
        logger.warn('[Me] Multer error on avatar upload', { error: err.message, code: err.code });
        if (multerErrorHandler) return multerErrorHandler(err, req, res, next);
        // Fallback manuel si multerErrorHandler non disponible
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Fichier trop volumineux (max 10 MB).', code: 'FILE_TOO_LARGE' });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: 'Champ inattendu. Utilisez le champ "avatar".', code: 'UNEXPECTED_FIELD' });
        }
        if (err.message && (err.message.includes('Format non autorisé') || err.message.includes('non autorisé'))) {
          return res.status(415).json({ error: err.message, code: 'UNSUPPORTED_MEDIA_TYPE' });
        }
        return res.status(400).json({ error: err.message || 'Erreur upload.', code: 'UPLOAD_ERROR' });
      }
      next();
    });
  } else {
    // multer non disponible — on passe au handler qui accepte le JSON base64
    next();
  }
}, async (req, res) => {
  const uid = req.user.uid;

  try {
    let avatarBase64 = null;

    // A) Fichier uploadé via multer
    if (req.file) {
      const fs     = require('fs');
      const path   = require('path');
      const mime   = req.file.mimetype || 'image/jpeg';
      const buffer = fs.readFileSync(req.file.path);

      // Vérifier taille base64 avant stockage Firestore
      const b64 = buffer.toString('base64');
      if (b64.length > MAX_AVATAR_B64) {
        // Nettoyage disque
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(413).json({
          error: 'Image trop grande pour le stockage (max ~600 KB). Compressez l\'image et réessayez.',
          code : 'IMAGE_TOO_LARGE',
        });
      }

      avatarBase64 = `data:${mime};base64,${b64}`;

      // Nettoyage disque après conversion (pas besoin de garder le fichier)
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      logger.info('[Me] Avatar: file converted to base64', { uid, size: b64.length });
    }

    // B) Base64 directement dans le body JSON
    else if (req.body?.avatarBase64) {
      const raw = req.body.avatarBase64;
      if (!raw.startsWith('data:image/')) {
        return res.status(400).json({ error: 'avatarBase64 doit être un data URI image.', code: 'INVALID_DATA_URI' });
      }
      if (raw.length > MAX_AVATAR_B64) {
        return res.status(413).json({ error: 'Image trop grande.', code: 'IMAGE_TOO_LARGE' });
      }
      avatarBase64 = raw;
      logger.info('[Me] Avatar: base64 JSON received', { uid, size: raw.length });
    }

    else {
      return res.status(400).json({ error: 'Aucun fichier fourni. Champ multipart: "avatar" ou body JSON: "avatarBase64".', code: 'NO_FILE' });
    }

    // Stocker le base64 directement dans Firestore (résout ephemeral FS Render)
    await db.collection('users').doc(uid).set(
      { avatar: avatarBase64, updatedAt: new Date().toISOString() },
      { merge: true }
    );

    logger.info('[Me] Avatar updated (base64 in Firestore)', { uid });

    return res.status(200).json({
      success  : true,
      avatarUrl: avatarBase64,
      message  : 'Photo de profil mise à jour.',
    });

  } catch (err) {
    logger.error('Erreur POST /me/avatar', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
