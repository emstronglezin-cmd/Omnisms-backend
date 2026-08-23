'use strict';
/**
 * OmniSMS — Routes Authentification
 *
 * Endpoints :
 *  POST /api/auth/register  → Créer un compte (phone obligatoire, email optionnel)
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
const { normalizePhone } = require('../services/phoneNormalizer');

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
    body('username')
      .trim()
      .notEmpty()
      .withMessage('Le nom d\'utilisateur est requis.')
      .isLength({ min: 2, max: 50 })
      .withMessage('Le nom d\'utilisateur doit contenir entre 2 et 50 caractères.')
      .matches(/^[a-zA-Z0-9_.-]+$/)
      .withMessage('Le nom d\'utilisateur ne peut contenir que des lettres, chiffres, _ . -'),
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

    const { name, email, password, phone, username } = req.body;

    // ── Normalisation des identifiants ─────────────────────────────────────
    // Téléphone : normalisation E.164 canonique (ex: "+22670000000")
    // Conserver aussi la version brute pour affichage, mais stocker E.164 pour comparaisons
    const rawPhone           = phone.trim();
    const e164Phone          = normalizePhone(rawPhone) || rawPhone;  // E.164 ou brut si échec
    const normalizedEmail    = email ? email.toLowerCase().trim() : null;
    const normalizedUsername = username.trim().toLowerCase();

    try {
      // ── Vérification unicité AVANT toute création ────────────────────────
      // On fait toutes les vérifications en parallèle pour être rapide.
      // IMPORTANT : on vérifie AUSSI les variantes du numéro pour éviter les doublons
      // de format (+226XXXXXXXX vs 226XXXXXXXX vs 0XXXXXXXX).
      const checks = [
        // Phone : vérifier le format E.164 normalisé ET le format brut (en cas de stocks anciens)
        db.collection('users').where('phone', '==', e164Phone).limit(1).get(),
        // Username
        db.collection('users').where('username', '==', normalizedUsername).limit(1).get(),
      ];
      if (normalizedEmail) {
        checks.push(db.collection('users').where('email', '==', normalizedEmail).limit(1).get());
      }
      // Si e164Phone ≠ rawPhone, vérifier aussi le format brut
      if (e164Phone !== rawPhone) {
        checks.push(db.collection('users').where('phone', '==', rawPhone).limit(1).get());
      }

      const results = await Promise.all(checks);
      const [phoneSnap, usernameSnap, ...rest] = results;

      if (!phoneSnap.empty) {
        return res.status(409).json({
          error: 'Un compte avec ce numéro de téléphone existe déjà.',
          code : 'PHONE_ALREADY_EXISTS',
        });
      }

      if (!usernameSnap.empty) {
        return res.status(409).json({
          error: `Le nom d'utilisateur "@${normalizedUsername}" est déjà utilisé. Choisissez-en un autre.`,
          code : 'USERNAME_ALREADY_EXISTS',
        });
      }

      // Vérifier email (3ème résultat si email fourni)
      if (normalizedEmail && rest.length > 0 && !rest[0].empty) {
        return res.status(409).json({
          error: 'Un compte avec cette adresse email existe déjà.',
          code : 'EMAIL_ALREADY_EXISTS',
        });
      }

      // Vérifier format brut si différent de E.164 (dernier résultat)
      const rawPhoneSnap = (!normalizedEmail && e164Phone !== rawPhone && rest[0])
        || (normalizedEmail && e164Phone !== rawPhone && rest[1]);
      if (rawPhoneSnap && !rawPhoneSnap.empty) {
        return res.status(409).json({
          error: 'Un compte avec ce numéro de téléphone existe déjà.',
          code : 'PHONE_ALREADY_EXISTS',
        });
      }

      // ── Création du compte ───────────────────────────────────────────────
      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
      const now = new Date().toISOString();

      const userData = {
        name          : name.trim(),
        username      : normalizedUsername,
        // Stocker le numéro en format E.164 canonique pour des comparaisons fiables
        phone         : e164Phone,
        // Conserver aussi le format original pour affichage
        phoneRaw      : rawPhone !== e164Phone ? rawPhone : null,
        email         : normalizedEmail,
        password      : hashedPassword,
        phoneVerified : true,    // Activé directement — pas d'OTP requis
        isSubscribed  : false,
        credits       : 0,
        provider      : 'phone',
        createdAt     : now,
        updatedAt     : now,
      };

      const docRef = await db.collection('users').add(userData);
      const userId = docRef.id;

      logger.info('Utilisateur créé', { uid: userId, phone: e164Phone, username: normalizedUsername });

      // ── Notifier les utilisateurs existants qui ont ce numéro en contact ──
      // Opération ASYNCHRONE non-bloquante : ne ralentit pas la réponse.
      // Cherche tous les utilisateurs dont contacts_manual ou contacts_synced
      // contient ce numéro, et met à jour le flag isOnOmniSms sans bloquer.
      setImmediate(async () => {
        try {
          const { broadcast } = require('../services/socketService');
          // Diffuser à TOUS les sockets connectés qu'un nouveau utilisateur OmniSMS
          // vient de s'inscrire avec ce numéro.
          // Les clients frontend écoutent 'contact:omnisms' et mettent à jour
          // le statut isOnOmniSms pour ce numéro dans leurs contacts.
          broadcast('contact:omnisms', {
            phone   : e164Phone,
            uid     : userId,
            name    : userData.name,
            username: normalizedUsername,
          });
          logger.info('[AUTH] New OmniSMS user registered — contact:omnisms broadcast', {
            uid: userId, phone: e164Phone.replace(/\d{4}$/, '****'),
          });
        } catch (broadcastErr) {
          logger.warn('[AUTH] setImmediate broadcast error', { error: broadcastErr.message });
        }

        // ── TRANSITION SMS → OMNISMS ──────────────────────────────────────────
        // Si ce numéro avait des conversations SMS externes (avant inscription),
        // les rattacher au nouveau UID OmniSMS :
        //   1. Trouver toutes les external_conversations où externalPhone === e164Phone
        //      (ce numéro était l'expéditeur SMS externe d'un autre utilisateur OmniSMS)
        //   2. Créer des conversations OmniSMS réelles (IDs déterministes) pour les remplacer
        //   3. Notifier les propriétaires concernés
        //
        // IMPORTANT : on NE supprime PAS les external_conversations — elles restent
        // pour l'historique et pour le cas où le numéro correspondrait à plusieurs owners.
        // On ajoute simplement `linkedOmniSmsUid` pour indiquer la transition.
        try {
          const extSnap = await db.collection('external_conversations')
            .where('externalPhone', '==', e164Phone)
            .limit(50)
            .get();

          if (!extSnap.empty) {
            logger.info('[AUTH] SMS→OmniSMS transition: conversations externes trouvées', {
              count   : extSnap.size,
              phone   : e164Phone.replace(/\d{4}$/, '****'),
              newUid  : userId,
            });

            const { emitToUser } = require('../services/socketService');
            const batch          = db.batch();
            const now            = new Date().toISOString();

            for (const doc of extSnap.docs) {
              const conv     = doc.data();
              const ownerUid = conv.ownerUid;
              if (!ownerUid || ownerUid === userId) continue;

              // Marquer la conversation externe comme liée au nouveau UID
              batch.update(doc.ref, {
                linkedOmniSmsUid : userId,
                linkedOmniSmsName: userData.name,
                linkedAt         : now,
                updatedAt        : now,
              });

              // Créer/confirmer la conversation OmniSMS entre les deux utilisateurs
              // Le conversationId déterministe est le même que celui qu'utiliserait routeMessage()
              const omniConvId = [ownerUid, userId].sort().join('-');

              // Notifier le propriétaire OmniSMS que son contact SMS vient de s'inscrire
              emitToUser(ownerUid, 'contact:omnisms', {
                phone           : e164Phone,
                uid             : userId,
                name            : userData.name,
                username        : normalizedUsername,
                previousConvId  : doc.id,      // ancien ID externe
                newConvId       : omniConvId,  // nouvel ID OmniSMS
                transition      : true,
              });

              logger.info('[AUTH] SMS→OmniSMS: owner notifié', {
                ownerUid,
                newUid    : userId,
                oldConvId : doc.id,
                newConvId : omniConvId,
              });
            }

            await batch.commit().catch(batchErr =>
              logger.warn('[AUTH] SMS→OmniSMS batch.commit error', { error: batchErr.message })
            );

            logger.info('[AUTH] SMS→OmniSMS transition terminée', {
              uid  : userId,
              phone: e164Phone.replace(/\d{4}$/, '****'),
              count: extSnap.size,
            });
          }
        } catch (transitionErr) {
          // Non-bloquant : ne jamais faire échouer l'inscription à cause de la transition
          logger.warn('[AUTH] SMS→OmniSMS transition error (non-bloquant)', {
            error: transitionErr.message,
            uid  : userId,
            phone: e164Phone.replace(/\d{4}$/, '****'),
          });
        }
      });

      // Générer le JWT immédiatement — pas d'OTP
      const token = signToken({
        uid  : userId,
        email: normalizedEmail || e164Phone,
        name : userData.name,
      });

      return res.status(201).json({
        message : 'Compte créé avec succès.',
        token,
        user: {
          id           : userId,
          name         : userData.name,
          username     : normalizedUsername,
          phone        : e164Phone,
          email        : normalizedEmail,
          phoneVerified: true,
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
          .where('email', '==', email.toLowerCase().trim())
          .limit(1)
          .get();
      } else {
        // Téléphone : essayer le format E.164 normalisé ET le format brut
        // pour les comptes anciens stockés dans un format différent
        const rawPhone  = phone.trim();
        const e164Phone = normalizePhone(rawPhone) || rawPhone;

        // Essayer E.164 d'abord
        snap = await db.collection('users').where('phone', '==', e164Phone).limit(1).get();

        // Si non trouvé et format différent, essayer le format brut
        if (snap.empty && e164Phone !== rawPhone) {
          snap = await db.collection('users').where('phone', '==', rawPhone).limit(1).get();
        }

        // Essayer aussi avec le format complet (ex: "+22670000000" ↔ "0022670000000")
        if (snap.empty) {
          const variants = [
            rawPhone.replace(/^\+/, '00'),   // +226... → 00226...
            rawPhone.replace(/^00/, '+'),     // 00226... → +226...
            rawPhone.replace(/\s/g, ''),      // sans espaces
          ].filter(v => v !== rawPhone && v !== e164Phone);
          for (const variant of variants) {
            if (snap.empty) {
              snap = await db.collection('users').where('phone', '==', variant).limit(1).get();
            }
          }
        }
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

      // Plus de blocage OTP — tous les comptes sont autorisés à se connecter
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
          username     : user.username     || null,
          email        : user.email        || null,
          phone        : user.phone        || null,
          avatar       : user.avatar       || null,
          phoneVerified: user.phoneVerified !== false,
          isSubscribed : user.isSubscribed || false,
          credits      : user.credits      || 0,
          needsPhone   : !user.phone,   // flag pour forcer la saisie du téléphone
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

      if (phone) {
        // Normaliser le téléphone en E.164 — CRITIQUE pour la résolution cohérente
        const e164Updated = normalizePhone(phone.trim()) || phone.trim();
        // Vérifier unicité du nouveau numéro (exclure l'utilisateur courant)
        const phoneSnap = await db.collection('users')
          .where('phone', '==', e164Updated)
          .limit(2)
          .get();
        const conflict = phoneSnap.docs.find(d => d.id !== req.user.uid && !d.data().deleted);
        if (conflict) {
          return res.status(409).json({
            error: 'Ce numéro est déjà associé à un autre compte.',
            code : 'PHONE_ALREADY_EXISTS',
          });
        }
        updates.phone    = e164Updated;
        updates.phoneRaw = phone.trim() !== e164Updated ? phone.trim() : null;
      }

      if (password) {
        updates.password = await bcrypt.hash(password, SALT_ROUNDS);
      }

      await db.collection('users').doc(req.user.uid).update(updates);

      logger.info('Profil mis à jour', { uid: req.user.uid, fields: Object.keys(updates).filter(k => k !== 'password') });
      return res.status(200).json({ message: 'Profil mis à jour avec succès.' });
    } catch (err) {
      logger.error('Erreur PUT /profile', { error: err.message });
      return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
    }
  }
);

module.exports = router;
