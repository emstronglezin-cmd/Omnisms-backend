'use strict';
/**
 * OmniSMS — Routes Authentification
 *
 * Utilise Firebase Admin SDK (Firestore + JWT personnalisé).
 * Validation des entrées via express-validator.
 * Aucune dépendance Parse.
 *
 * Endpoints :
 *  POST /api/auth/register  → Créer un compte
 *  POST /api/auth/login     → Connexion
 *  PUT  /api/auth/profile   → Mettre à jour le profil (auth requise)
 *  GET  /api/auth/me        → Récupérer son profil (auth requise)
 */

const express  = require('express');
const bcrypt   = require('bcrypt');
const router   = express.Router();

const { body, validationResult } = require('express-validator');

const db           = require('../config/firebase');
const authenticate = require('../middleware/authenticate');
const { signToken } = require('../middleware/authenticate');
const { logger }   = require('../middleware/logger');

const SALT_ROUNDS = 12;

// ─────────────────────────────────────────────────────────────
// Helper : retourner les erreurs de validation
// ─────────────────────────────────────────────────────────────
function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error : 'Données invalides.',
      code  : 'VALIDATION_ERROR',
      fields: errors.array().map(e => ({ field: e.path, msg: e.msg })),
    });
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────
router.post(
  '/register',
  [
    body('name')
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage('Le nom doit contenir entre 2 et 100 caractères.'),
    body('email')
      .trim()
      .isEmail()
      .normalizeEmail()
      .withMessage('Adresse email invalide.'),
    body('password')
      .isLength({ min: 8, max: 128 })
      .withMessage('Le mot de passe doit contenir entre 8 et 128 caractères.'),
    body('phone')
      .optional()
      .trim()
      .matches(/^\+?[0-9\s\-().]{7,20}$/)
      .withMessage('Numéro de téléphone invalide.'),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    const { name, email, password, phone } = req.body;

    try {
      // Vérifier si l'email existe déjà
      const existing = await db
        .collection('users')
        .where('email', '==', email.toLowerCase())
        .limit(1)
        .get();

      if (!existing.empty) {
        return res.status(409).json({
          error: 'Un compte avec cet email existe déjà.',
          code : 'EMAIL_EXISTS',
        });
      }

      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
      const now = new Date().toISOString();

      const userData = {
        name        : name.trim(),
        email       : email.toLowerCase().trim(),
        password    : hashedPassword,
        phone       : phone ? phone.trim() : null,
        isSubscribed: false,
        credits     : 0,
        createdAt   : now,
        updatedAt   : now,
      };

      const docRef = await db.collection('users').add(userData);

      logger.info('Utilisateur créé', { uid: docRef.id, email: userData.email });

      return res.status(201).json({
        message: 'Compte créé avec succès.',
        userId : docRef.id,
      });
    } catch (err) {
      logger.error('Erreur register', { error: err.message });
      return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────
router.post(
  '/login',
  [
    body('email')
      .optional()
      .trim()
      .isEmail()
      .normalizeEmail()
      .withMessage('Adresse email invalide.'),
    body('phone')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Numéro de téléphone requis si email absent.'),
    body('password')
      .notEmpty()
      .withMessage('Le mot de passe est requis.')
      .isLength({ max: 128 })
      .withMessage('Mot de passe trop long.'),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    const { email, password, phone } = req.body;

    if (!email && !phone) {
      return res.status(400).json({
        error: 'Email ou numéro de téléphone requis.',
        code : 'MISSING_IDENTIFIER',
      });
    }

    try {
      // Chercher par email ou téléphone
      let snap;
      if (email) {
        snap = await db
          .collection('users')
          .where('email', '==', email.toLowerCase())
          .limit(1)
          .get();
      } else {
        snap = await db
          .collection('users')
          .where('phone', '==', phone)
          .limit(1)
          .get();
      }

      if (snap.empty) {
        return res.status(401).json({
          error: 'Identifiants invalides.',
          code : 'INVALID_CREDENTIALS',
        });
      }

      const doc  = snap.docs[0];
      const user = { id: doc.id, ...doc.data() };

      const passwordMatch = await bcrypt.compare(password, user.password);
      if (!passwordMatch) {
        return res.status(401).json({
          error: 'Identifiants invalides.',
          code : 'INVALID_CREDENTIALS',
        });
      }

      // Générer un JWT signé
      const token = signToken({
        uid  : user.id,
        email: user.email,
        name : user.name,
      });

      // Mettre à jour la dernière connexion
      await db.collection('users').doc(user.id).update({
        lastLoginAt: new Date().toISOString(),
      });

      logger.info('Login réussi', { uid: user.id });

      return res.status(200).json({
        message : 'Connexion réussie.',
        token,
        user: {
          id          : user.id,
          name        : user.name,
          email       : user.email,
          isSubscribed: user.isSubscribed || false,
          credits     : user.credits      || 0,
        },
      });
    } catch (err) {
      logger.error('Erreur login', { error: err.message });
      return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET /api/auth/me  — profil de l'utilisateur connecté
// ─────────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'USER_NOT_FOUND' });
    }

    const user = doc.data();
    // Ne jamais renvoyer le hash du mot de passe
    const { password: _pw, ...safeUser } = user;

    return res.status(200).json({ id: doc.id, ...safeUser });
  } catch (err) {
    logger.error('Erreur GET /me', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/auth/profile  — mise à jour du profil
// ─────────────────────────────────────────────────────────────
router.put(
  '/profile',
  authenticate,
  [
    body('name')
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage('Le nom doit contenir entre 2 et 100 caractères.'),
    body('country')
      .optional()
      .trim()
      .isLength({ min: 2, max: 60 })
      .withMessage('Pays invalide.'),
    body('phone')
      .optional()
      .trim()
      .matches(/^\+?[0-9\s\-().]{7,20}$/)
      .withMessage('Numéro de téléphone invalide.'),
    body('password')
      .optional()
      .isLength({ min: 8, max: 128 })
      .withMessage('Le mot de passe doit contenir entre 8 et 128 caractères.'),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    const { name, country, phone, password } = req.body;

    try {
      const updates = { updatedAt: new Date().toISOString() };

      if (name)    updates.name    = name.trim();
      if (country) updates.country = country.trim();
      if (phone)   updates.phone   = phone.trim();

      if (password) {
        updates.password = await bcrypt.hash(password, SALT_ROUNDS);
      }

      await db.collection('users').doc(req.user.uid).update(updates);

      logger.info('Profil mis à jour', { uid: req.user.uid });
      return res.status(200).json({ message: 'Profil mis à jour avec succès.' });
    } catch (err) {
      logger.error('Erreur PUT /profile', { error: err.message });
      return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
    }
  }
);

module.exports = router;
