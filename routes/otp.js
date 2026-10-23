'use strict';
/**
 * OmniSMS — Routes de vérification du numéro de téléphone (inscription).
 *
 * Authentification : jeton TEMPORAIRE « pendingToken » (JWT purpose=
 * 'phone_verification', 15 min) délivré à l'inscription/connexion d'un compte
 * en attente, OU JWT de session complet. Jamais anonyme.
 *
 *   POST /api/auth/send-otp    → demande (ou renvoi) du code (cooldown intégré)
 *   POST /api/auth/verify-otp  → vérifie le code ; sur succès : compte activé
 *                                + JWT de session COMPLET (fin du parcours)
 *   GET  /api/auth/phone/verify/status → état de vérification du compte
 *   POST /api/auth/phone/change → change le numéro d'un compte en attente
 *                                 (unicité vérifiée, ancien code invalidé)
 *
 * Sécurité : seul le backend passe phoneVerified à true (après code validé) ;
 * réponses neutres ; aucun code/secret dans les journaux.
 */

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { signToken } = require('../middleware/authenticate');
const { sendOtp, verifyOtp } = require('../services/otpService');
const { logger } = require('../middleware/logger');
const { normalizePhone } = require('../services/phoneNormalizer');

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

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw Object.assign(new Error('JWT_SECRET manquant'), { code: 'NO_SECRET' });
  return secret;
}

/**
 * Résout l'appelant : pendingToken (purpose='phone_verification') OU JWT de
 * session. → { uid, phone (du token si pending), via }
 */
function resolveVerifier(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    if (decoded.purpose === 'phone_verification') {
      return { uid: decoded.uid, tokenPhone: decoded.phone || null, via: 'pending' };
    }
    if (decoded.uid || decoded.userId || decoded.sub) {
      return { uid: decoded.uid || decoded.userId || decoded.sub, tokenPhone: null, via: 'session' };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** Charge l'utilisateur et vérifie qu'il est bien EN ATTENTE (jamais un compte déjà vérifié ni historique bloqué). */
async function loadPendingUser(db, uid) {
  const snap = await db.collection('users').doc(String(uid)).get();
  if (!snap.exists) return null;
  const u = { id: snap.id, ...snap.data() };
  if (u.verificationRequired === true && u.phoneVerified !== true) return u;
  return null; // déjà vérifié ou compte historique → parcours OTP inutile/refusé
}

function mask(phone) { return phone ? String(phone).replace(/\d{4}$/, '****') : null; }

// ─────────────────────────────────────────────────────────────
// POST /api/auth/send-otp   { phone? }   (pendingToken ou session)
// Renvoi = même endpoint (cooldown 60 s + limites h/numéro et h/IP).
// ─────────────────────────────────────────────────────────────
router.post(
  '/send-otp',
  [ body('phone').optional().trim().matches(/^\+?[0-9\s\-().]{7,20}$/).withMessage('Numéro de téléphone invalide.') ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    let verifier;
    try { verifier = resolveVerifier(req); } catch (e) { return res.status(503).json({ success: false, error: 'Service de vérification non configuré.', code: 'OTP_NOT_CONFIGURED' }); }
    if (!verifier) return res.status(401).json({ success: false, error: 'Jeton de vérification requis.', code: 'VERIFICATION_TOKEN_REQUIRED' });

    const db = (() => { try { const d = require('../config/firebase'); return d && !d._stub ? d : null; } catch (_) { return null; } })();
    if (!db) return res.status(503).json({ success: false, error: 'Service indisponible.', code: 'DB_UNAVAILABLE' });

    const pendingUser = await loadPendingUser(db, verifier.uid);
    if (!pendingUser) {
      // Réponse neutre : pas d'énumération (compte déjà vérifié / inconnu / historique)
      return res.status(409).json({ success: false, error: 'Ce compte n\'est pas en attente de vérification.', code: 'NOT_PENDING' });
    }

    // Numéro vérifié = celui du COMPTE (source de vérité backend).
    // Un compte sans numéro (ex : première inscription Google) le fournit ici
    // une seule fois ; un compte avec numéro NE PEUT PAS en changer par cet
    // endpoint (→ POST /api/auth/phone/change).
    let targetPhone = pendingUser.phone ? normalizePhone(pendingUser.phone) || pendingUser.phone : null;
    const requested = req.body && req.body.phone ? (normalizePhone(req.body.phone) || String(req.body.phone).trim()) : null;
    if (!targetPhone && requested) {
      // Première définition du numéro : unicité obligatoire (anti double-inscription)
      const existing = await db.collection('users').where('phone', '==', requested).limit(1).get();
      if (!existing.empty && existing.docs[0].id !== pendingUser.id) {
        return res.status(409).json({ success: false, error: 'Un compte avec ce numéro de téléphone existe déjà.', code: 'PHONE_ALREADY_USED' });
      }
      await db.collection('users').doc(pendingUser.id).set({ phone: requested, updatedAt: new Date().toISOString() }, { merge: true });
      targetPhone = requested;
      logger.info('[OTP] Numéro défini pour un compte en attente', { uid: pendingUser.id, phone: mask(requested) });
    }
    if (!targetPhone) {
      return res.status(400).json({ success: false, error: 'Numéro de téléphone requis.', code: 'PHONE_REQUIRED' });
    }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
    const result = await sendOtp(targetPhone, { userId: pendingUser.id, ip });

    if (result.success) {
      return res.status(200).json({ success: true, message: result.message, phone: targetPhone });
    }
    const status = result.code === 'OTP_COOLDOWN' || result.code === 'OTP_RATE_LIMITED' ? 429
      : result.code === 'OTP_PROVIDER_UNAVAILABLE' || result.code === 'SMS_SEND_FAILED' || result.code === 'SMS_ERROR' ? 503 : 400;
    return res.status(status).json({
      success: false,
      error  : result.message,
      code   : result.code || 'OTP_SEND_FAILED',
      cooldown: result.cooldown || undefined,
    });
  }
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/verify-otp   { code }   (pendingToken ou session)
// Succès → users.phoneVerified=true, verificationRequired=false, status=active
//        + JWT de session COMPLET (fin du parcours).
// ─────────────────────────────────────────────────────────────
router.post(
  '/verify-otp',
  [ body('code').trim().notEmpty().withMessage('Code OTP requis.').isLength({ min: 4, max: 8 }).withMessage('Code OTP invalide.') ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    let verifier;
    try { verifier = resolveVerifier(req); } catch (e) { return res.status(503).json({ success: false, error: 'Service de vérification non configuré.', code: 'OTP_NOT_CONFIGURED' }); }
    if (!verifier) return res.status(401).json({ success: false, error: 'Jeton de vérification requis.', code: 'VERIFICATION_TOKEN_REQUIRED' });

    const db = (() => { try { const d = require('../config/firebase'); return d && !d._stub ? d : null; } catch (_) { return null; } })();
    if (!db) return res.status(503).json({ success: false, error: 'Service indisponible.', code: 'DB_UNAVAILABLE' });

    const pendingUser = await loadPendingUser(db, verifier.uid);
    if (!pendingUser) {
      return res.status(409).json({ success: false, error: 'Ce compte n\'est pas en attente de vérification.', code: 'NOT_PENDING' });
    }
    if (!pendingUser.phone) {
      return res.status(400).json({ success: false, error: 'Définis d\'abord ton numéro (send-otp).', code: 'PHONE_REQUIRED' });
    }

    const targetPhone = normalizePhone(pendingUser.phone) || pendingUser.phone;
    const result = await verifyOtp(targetPhone, req.body.code);

    if (!result.success) {
      const statusCode = result.code === 'OTP_EXPIRED' ? 410
        : result.code === 'OTP_MAX_TRIES' ? 429
        : result.code === 'OTP_NOT_FOUND' || result.code === 'OTP_CONSUMED' ? 404 : 400;
      return res.status(statusCode).json({
        success: false,
        error  : result.message,
        code   : result.code || 'OTP_VERIFY_FAILED',
        triesRemaining: result.triesRemaining,
      });
    }

    // SEUL le backend marque « vérifié » — après validation du code.
    const now = new Date().toISOString();
    await db.collection('users').doc(pendingUser.id).set({
      phoneVerified: true,
      verificationRequired: false,
      status: 'active',
      phoneVerifiedAt: now,
      updatedAt: now,
    }, { merge: true });

    const token = signToken({
      uid  : pendingUser.id,
      email: pendingUser.email || pendingUser.phone,
      name : pendingUser.name,
      verificationRequired: false,
    });

    logger.info('[OTP] Compte activé (numéro vérifié)', { uid: pendingUser.id, phone: mask(targetPhone) });

    return res.status(200).json({
      success: true,
      message: 'Numéro vérifié. Ton compte est activé.',
      token,
      phoneVerified: true,
      user: {
        id           : pendingUser.id,
        name         : pendingUser.name || null,
        username     : pendingUser.username || null,
        phone        : targetPhone,
        email        : pendingUser.email || null,
        phoneVerified: true,
        isSubscribed : pendingUser.isSubscribed || false,
        credits      : pendingUser.credits || 0,
      },
    });
  }
);

// ─────────────────────────────────────────────────────────────
// GET /api/auth/phone/verify/status   (pendingToken ou session)
// ─────────────────────────────────────────────────────────────
router.get('/phone/verify/status', async (req, res) => {
  let verifier;
  try { verifier = resolveVerifier(req); } catch (e) { return res.status(503).json({ success: false, error: 'Service de vérification non configuré.', code: 'OTP_NOT_CONFIGURED' }); }
  if (!verifier) return res.status(401).json({ success: false, error: 'Authentification requise.', code: 'UNAUTHENTICATED' });

  const db = (() => { try { const d = require('../config/firebase'); return d && !d._stub ? d : null; } catch (_) { return null; } })();
  if (!db) return res.status(503).json({ success: false, error: 'Service indisponible.', code: 'DB_UNAVAILABLE' });

  try {
    const snap = await db.collection('users').doc(String(verifier.uid)).get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Utilisateur introuvable.', code: 'USER_NOT_FOUND' });
    const u = snap.data();
    const pending = u.verificationRequired === true && u.phoneVerified !== true;
    return res.status(200).json({
      success: true,
      phoneVerified: u.phoneVerified === true,
      verificationRequired: pending,
      status: pending ? 'pending_verification' : 'active',
      phone: mask(u.phone),
      needsPhone: pending && !u.phone,
    });
  } catch (err) {
    logger.error('[OTP] Statut vérification impossible', { error: err.message });
    return res.status(500).json({ success: false, error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/phone/change   { phone }   (pendingToken ou session)
// Change le numéro d'un compte EN ATTENTE (unicité + invalidation de l'ancien
// code par le cooldown/uniqueness du doc otp_codes hashé par numéro).
// ─────────────────────────────────────────────────────────────
router.post(
  '/phone/change',
  [ body('phone').trim().notEmpty().withMessage('Numéro de téléphone requis.').matches(/^\+?[0-9\s\-().]{7,20}$/).withMessage('Numéro de téléphone invalide.') ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    let verifier;
    try { verifier = resolveVerifier(req); } catch (e) { return res.status(503).json({ success: false, error: 'Service de vérification non configuré.', code: 'OTP_NOT_CONFIGURED' }); }
    if (!verifier) return res.status(401).json({ success: false, error: 'Jeton de vérification requis.', code: 'VERIFICATION_TOKEN_REQUIRED' });

    const db = (() => { try { const d = require('../config/firebase'); return d && !d._stub ? d : null; } catch (_) { return null; } })();
    if (!db) return res.status(503).json({ success: false, error: 'Service indisponible.', code: 'DB_UNAVAILABLE' });

    const pendingUser = await loadPendingUser(db, verifier.uid);
    if (!pendingUser) {
      return res.status(409).json({ success: false, error: 'Ce compte n\'est pas en attente de vérification.', code: 'NOT_PENDING' });
    }

    const newPhone = normalizePhone(req.body.phone) || String(req.body.phone).trim();
    const currentPhone = pendingUser.phone ? (normalizePhone(pendingUser.phone) || pendingUser.phone) : null;
    if (currentPhone && newPhone === currentPhone) {
      return res.status(400).json({ success: false, error: 'Ce numéro est déjà celui du compte.', code: 'PHONE_UNCHANGED' });
    }
    const existing = await db.collection('users').where('phone', '==', newPhone).limit(1).get();
    if (!existing.empty && existing.docs[0].id !== pendingUser.id) {
      return res.status(409).json({ success: false, error: 'Un compte avec ce numéro de téléphone existe déjà.', code: 'PHONE_ALREADY_USED' });
    }

    await db.collection('users').doc(pendingUser.id).set({
      phone: newPhone,
      phoneRaw: req.body.phone !== newPhone ? String(req.body.phone).trim() : null,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    logger.info('[OTP] Numéro changé pendant l\'inscription (ancien code invalidé au prochain envoi)', { uid: pendingUser.id, from: mask(currentPhone), to: mask(newPhone) });

    return res.status(200).json({ success: true, message: 'Numéro mis à jour. Demande un nouveau code.', phone: newPhone });
  }
);

module.exports = router;
