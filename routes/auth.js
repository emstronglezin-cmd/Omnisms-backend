'use strict';
/**
 * OmniSMS — Routes Authentification
 *
 * Endpoints :
 *  POST /api/auth/register  → Créer un compte (email + password)
 *  POST /api/auth/login     → Connexion (email ou phone + password)
 *  POST /api/auth/google    → Google Sign-In (Firebase ID token)
 *  GET  /api/auth/me        → Récupérer son profil (auth requise)
 *  PUT  /api/auth/profile   → Mettre à jour le profil (auth requise)
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
// Identité principale : numéro de téléphone (email optionnel)
// ─────────────────────────────────────────────────────────────
router.post(
  '/register',
  [
    body('name')
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage('Le nom doit contenir entre 2 et 100 caractères.'),
    body('phone')
      .trim()
      .notEmpty()
      .withMessage('Le numéro de téléphone est requis.')
      .matches(/^\+?[0-9\s\-().]{7,20}$/)
      .withMessage('Numéro de téléphone invalide.'),
    body('email')
      .optional({ checkFalsy: true })
      .trim()
      .isEmail()
      .normalizeEmail()
      .withMessage('Adresse email invalide.'),
    body('password')
      .isLength({ min: 8, max: 128 })
      .withMessage('Le mot de passe doit contenir entre 8 et 128 caractères.'),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    const { name, email, password, phone } = req.body;
    const normalizedPhone = phone.trim();
    const normalizedEmail = email ? email.toLowerCase().trim() : null;

    try {
      // Vérifier si le numéro de téléphone existe déjà
      const existingPhone = await db
        .collection('users')
        .where('phone', '==', normalizedPhone)
        .limit(1)
        .get();

      if (!existingPhone.empty) {
        return res.status(409).json({
          error: 'Un compte avec ce numéro de téléphone existe déjà.',
          code : 'PHONE_EXISTS',
        });
      }

      // Vérifier si l'email existe déjà (si fourni)
      if (normalizedEmail) {
        const existingEmail = await db
          .collection('users')
          .where('email', '==', normalizedEmail)
          .limit(1)
          .get();

        if (!existingEmail.empty) {
          return res.status(409).json({
            error: 'Un compte avec cet email existe déjà.',
            code : 'EMAIL_EXISTS',
          });
        }
      }

      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
      const now = new Date().toISOString();

      const userData = {
        name          : name.trim(),
        phone         : normalizedPhone,
        email         : normalizedEmail,
        password      : hashedPassword,
        phoneVerified : false,   // Doit être vérifié via OTP avant utilisation complète
        isSubscribed  : false,
        credits       : 0,
        provider      : 'phone',
        createdAt     : now,
        updatedAt     : now,
      };

      const docRef = await db.collection('users').add(userData);

      logger.info('Utilisateur créé (en attente OTP)', { uid: docRef.id, phone: normalizedPhone });

      // Ne pas générer de JWT avant la vérification OTP
      // Le frontend doit envoyer un OTP et valider avant d'obtenir un token
      return res.status(201).json({
        message      : 'Compte créé. Vérifiez votre numéro via OTP.',
        userId       : docRef.id,
        requiresOtp  : true,
        phone        : normalizedPhone,
        user: {
          id           : docRef.id,
          name         : userData.name,
          phone        : normalizedPhone,
          email        : normalizedEmail,
          phoneVerified: false,
          isSubscribed : false,
          credits      : 0,
        },
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

      // Les comptes Google n'ont pas de mot de passe hashé
      if (!user.password) {
        return res.status(401).json({
          error: 'Ce compte utilise Google Sign-In. Connectez-vous avec Google.',
          code : 'USE_GOOGLE_SIGNIN',
        });
      }

      const passwordMatch = await bcrypt.compare(password, user.password);
      if (!passwordMatch) {
        return res.status(401).json({
          error: 'Identifiants invalides.',
          code : 'INVALID_CREDENTIALS',
        });
      }

      // Bloquer la connexion si le numéro n'est pas vérifié
      // Exception : comptes Google et comptes legacy (sans flag phoneVerified)
      if (user.provider !== 'google' && user.phoneVerified === false) {
        return res.status(403).json({
          error        : 'Numéro de téléphone non vérifié. Validez votre OTP pour activer votre compte.',
          code         : 'PHONE_NOT_VERIFIED',
          requiresOtp  : true,
          phone        : user.phone || null,
          userId       : user.id,
        });
      }

      const token = signToken({
        uid  : user.id,
        email: user.email || user.phone,
        name : user.name,
      });

      await db.collection('users').doc(user.id).update({
        lastLoginAt: new Date().toISOString(),
      });

      logger.info('Login réussi', { uid: user.id });

      return res.status(200).json({
        message : 'Connexion réussie.',
        token,
        user: {
          id           : user.id,
          name         : user.name,
          email        : user.email        || null,
          phone        : user.phone        || null,
          phoneVerified: user.phoneVerified !== false,
          isSubscribed : user.isSubscribed || false,
          credits      : user.credits      || 0,
        },
      });
    } catch (err) {
      logger.error('Erreur login', { error: err.message });
      return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/google  — Google Sign-In via Firebase ID Token
// ─────────────────────────────────────────────────────────────
/**
 * Le frontend obtient un idToken Firebase après Google Sign-In,
 * puis l'envoie ici. On le vérifie côté serveur via Firebase Admin SDK,
 * on crée le compte Firestore s'il n'existe pas, et on retourne un JWT.
 *
 * Body : { idToken: "firebase_id_token_string" }
 */
router.post(
  '/google',
  [
    body('idToken')
      .notEmpty()
      .withMessage('Le token Firebase est requis.')
      .isString()
      .isLength({ min: 10 })
      .withMessage('Token invalide.'),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    const { idToken } = req.body;

    try {
      // Vérifier le token Firebase ID avec Firebase Admin SDK
      let decodedToken;
      try {
        const admin = require('../firebase-admin/index');
        decodedToken = await admin.auth().verifyIdToken(idToken);
      } catch (verifyErr) {
        logger.warn('Google Sign-In — token invalide', { error: verifyErr.message });
        return res.status(401).json({
          error: 'Token Google invalide ou expiré. Reconnectez-vous.',
          code : 'INVALID_GOOGLE_TOKEN',
        });
      }

      const { uid: googleUid, email, name: googleName, picture } = decodedToken;

      if (!email) {
        return res.status(400).json({
          error: 'Email absent dans le token Google.',
          code : 'MISSING_EMAIL',
        });
      }

      const normalizedEmail = email.toLowerCase().trim();
      const now = new Date().toISOString();

      // Chercher si l'utilisateur existe déjà (par email ou googleUid)
      let userId;
      let userData;

      const existingSnap = await db
        .collection('users')
        .where('email', '==', normalizedEmail)
        .limit(1)
        .get();

      if (!existingSnap.empty) {
        // Utilisateur existant — mettre à jour les infos Google
        const existingDoc = existingSnap.docs[0];
        userId   = existingDoc.id;
        userData = existingDoc.data();

        await db.collection('users').doc(userId).update({
          googleUid  : googleUid,
          provider   : 'google',
          name       : userData.name || googleName || normalizedEmail.split('@')[0],
          avatar     : picture || userData.avatar || null,
          lastLoginAt: now,
          updatedAt  : now,
        });

        userData = { ...userData, googleUid, provider: 'google' };
        logger.info('Google Sign-In — compte existant mis à jour', { uid: userId });

      } else {
        // Nouvel utilisateur — créer le compte
        const newUser = {
          name        : googleName || normalizedEmail.split('@')[0],
          email       : normalizedEmail,
          googleUid   : googleUid,
          avatar      : picture || null,
          phone       : null,
          password    : null,   // Pas de mot de passe pour les comptes Google
          provider    : 'google',
          isSubscribed: false,
          credits     : 0,
          createdAt   : now,
          updatedAt   : now,
          lastLoginAt : now,
        };

        const docRef = await db.collection('users').add(newUser);
        userId   = docRef.id;
        userData = newUser;

        logger.info('Google Sign-In — nouveau compte créé', { uid: userId, email: normalizedEmail });
      }

      // Générer le JWT OmniSMS
      const token = signToken({
        uid  : userId,
        email: normalizedEmail,
        name : userData.name || googleName,
      });

      return res.status(200).json({
        message : 'Connexion Google réussie.',
        token,
        user: {
          id          : userId,
          name        : userData.name || googleName,
          email       : normalizedEmail,
          avatar      : picture || userData.avatar || null,
          isSubscribed: userData.isSubscribed || false,
          credits     : userData.credits      || 0,
          provider    : 'google',
        },
      });

    } catch (err) {
      logger.error('Erreur Google Sign-In', { error: err.message });
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
