'use strict';
/**
 * OmniSMS — Bloque les fonctionnalités protégées pour un compte EN ATTENTE
 * de vérification de numéro (politique PHONE_VERIFICATION_REQUIRED=true).
 *
 * S'appuie sur le claim JWT `verificationRequired` émis à la création des
 * comptes pending : AUCUNE lecture Firestore par requête. Les JWT sans le
 * claim (comptes historiques, sessions antérieures) ne sont JAMAIS bloqués —
 * pas de migration, pas de re-vérification forcée.
 *
 * Seul le backend peut lever le blocage : le claim est retiré du token complet
 * émis après validation du code OTP (routes/otp.js).
 */
const { logger } = require('./logger');

module.exports = function requirePhoneVerified(req, res, next) {
  let u = req.user;
  // Ce garde peut être monté AVANT le middleware d'auth de la route : il décode
  // donc lui-même le JWT (claims uniquement — aucune lecture Firestore).
  if (!u) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (token && process.env.JWT_SECRET) {
      try { u = require('jsonwebtoken').verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }); } catch (_) {}
    }
  }
  if (u && u.verificationRequired === true && u.phoneVerified !== true) {
    logger.info('[AUTH] Action refusée — vérification du numéro en attente', { uid: u.uid });
    return res.status(403).json({
      error: 'Vérifie ton numéro de téléphone pour utiliser cette fonctionnalité.',
      code: 'PHONE_VERIFICATION_REQUIRED',
      phoneVerificationRequired: true,
    });
  }
  return next();
};
