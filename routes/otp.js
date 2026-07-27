'use strict';
/**
 * OmniSMS — Routes OTP
 *
 * Endpoints :
 *   POST /api/auth/send-otp    → Envoyer un OTP au numéro
 *   POST /api/auth/verify-otp  → Valider un OTP et activer le compte
 *
 * Ces routes sont montées DANS authRoutes (via server.js) sous /api/auth
 * Flux complet :
 *   1. POST /api/auth/register   → { userId, requiresOtp: true, phone }
 *   2. POST /api/auth/send-otp   → { success: true }
 *   3. POST /api/auth/verify-otp → { success: true, token, user }
 *   4. Compte activé — JWT délivré
 */

const express  = require('express');
const router   = express.Router();
const { body, validationResult } = require('express-validator');
const { signToken } = require('../middleware/authenticate');
const { sendOtp, verifyOtp } = require('../services/otpService');
const { logger } = require('../middleware/logger');

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
// POST /api/auth/send-otp
// Body : { phone, userId? }
// ─────────────────────────────────────────────────────────────
router.post(
  '/send-otp',
  [
    body('phone')
      .trim()
      .notEmpty()
      .withMessage('Numéro de téléphone requis.')
      .matches(/^\+?[0-9\s\-().]{7,20}$/)
      .withMessage('Numéro de téléphone invalide.'),
    body('userId')
      .optional()
      .trim()
      .isString(),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    const { phone, userId } = req.body;

    const result = await sendOtp(phone.trim(), userId || null);

    if (result.success) {
      const response = {
        success : true,
        message : result.message,
        phone   : phone.trim(),
      };
      // En mode développement uniquement, exposer le code pour les tests
      if (result.devCode) response.devCode = result.devCode;
      return res.status(200).json(response);
    } else {
      return res.status(result.code === 'OTP_COOLDOWN' ? 429 : 400).json({
        success : false,
        error   : result.message,
        code    : result.code || 'OTP_SEND_FAILED',
        cooldown: result.cooldown || undefined,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/verify-otp
// Body : { phone, code, userId? }
// Retourne un JWT si succès → compte activé
// ─────────────────────────────────────────────────────────────
router.post(
  '/verify-otp',
  [
    body('phone')
      .trim()
      .notEmpty()
      .withMessage('Numéro de téléphone requis.'),
    body('code')
      .trim()
      .notEmpty()
      .withMessage('Code OTP requis.')
      .isLength({ min: 4, max: 8 })
      .withMessage('Code OTP invalide.'),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    const { phone, code } = req.body;

    const result = await verifyOtp(phone.trim(), code.trim());

    if (result.success) {
      const user = result.user;
      let token  = null;

      // Générer le JWT maintenant que le compte est vérifié
      if (user) {
        try {
          token = signToken({
            uid  : user.id,
            email: user.email || user.phone,
            name : user.name,
          });
        } catch (e) {
          logger.error('[OTP] Impossible de générer JWT', { error: e.message });
        }
      }

      return res.status(200).json({
        success      : true,
        message      : result.message,
        token,
        phoneVerified: true,
        user         : user ? {
          id           : user.id,
          name         : user.name,
          phone        : user.phone,
          email        : user.email        || null,
          phoneVerified: true,
          isSubscribed : user.isSubscribed || false,
          credits      : user.credits      || 0,
        } : null,
      });
    } else {
      const statusCode = result.code === 'OTP_EXPIRED'   ? 410
                       : result.code === 'OTP_INVALID'   ? 400
                       : result.code === 'OTP_MAX_TRIES'  ? 429
                       : result.code === 'OTP_NOT_FOUND'  ? 404
                       : 400;

      return res.status(statusCode).json({
        success        : false,
        error          : result.message,
        code           : result.code || 'OTP_VERIFY_FAILED',
        triesRemaining : result.triesRemaining,
      });
    }
  }
);

module.exports = router;
