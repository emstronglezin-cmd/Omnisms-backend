'use strict';
/**
 * OmniSMS — Middleware d'authentification JWT
 *
 * - Attend le header : Authorization: Bearer <token>
 * - Vérifie la signature et l'expiration
 * - Injecte req.user = { uid, email, ... }
 * - Rejette les tokens invalides ou expirés avec des codes clairs
 */

const jwt = require('jsonwebtoken');

// JWT_SECRET is read dynamically so Render env vars are always picked up.
// We never call process.exit() here — missing JWT_SECRET is handled at
// call-time (signToken throws, authenticate returns 503).
function getJwtSecret() {
  return process.env.JWT_SECRET || null;
}

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  [Auth] JWT_SECRET absent — tokens cannot be signed/verified until it is set.');
  console.warn('⚠️  [Auth] Add JWT_SECRET in Render: Settings → Environment Variables.');
}

/**
 * Middleware d'authentification standard (JWT Bearer).
 * Usage : router.get('/route', authenticate, handler)
 */
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';

  if (!authHeader) {
    return res.status(401).json({
      error: 'Authentification requise.',
      code : 'NO_TOKEN',
    });
  }

  // Accepter "Bearer <token>" et le token brut (rétrocompatibilité)
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  if (!token || token.length < 10) {
    return res.status(401).json({
      error: 'Token manquant ou invalide.',
      code : 'INVALID_TOKEN_FORMAT',
    });
  }

  const secret = getJwtSecret();
  if (!secret) {
    return res.status(503).json({
      error: 'Service d\'authentification non configuré (JWT_SECRET manquant).',
      code : 'AUTH_NOT_CONFIGURED',
    });
  }

  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],   // Forcer l'algorithme — évite les attaques "none" et RSA-to-HMAC
    });

    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error   : 'Session expirée. Reconnectez-vous.',
        code    : 'TOKEN_EXPIRED',
        expiredAt: err.expiredAt,
      });
    }

    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Token invalide.',
        code : 'INVALID_TOKEN',
      });
    }

    // Autre erreur (inattendue)
    console.error('❌ [Auth] Erreur JWT inattendue:', err.message);
    return res.status(500).json({
      error: 'Erreur d\'authentification.',
      code : 'AUTH_ERROR',
    });
  }
}

/**
 * Middleware optionnel — charge req.user si un token est présent,
 * sans bloquer la requête si absent.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader) return next();

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  try {
    const secret = getJwtSecret();
    if (!secret) { req.user = null; return next(); }
    req.user = jwt.verify(token, secret, {
      algorithms: ['HS256'],
    });
  } catch {
    // Ignoré volontairement — token invalide = pas d'utilisateur
    req.user = null;
  }
  next();
}

/**
 * Générer un JWT signé pour un utilisateur.
 * @param {object} payload  - Données à inclure (uid, email, etc.)
 * @param {string} [expiresIn='7d']  - Durée de validité
 */
function signToken(payload, expiresIn = '7d') {
  const secret = getJwtSecret();
  if (!secret) throw new Error('JWT_SECRET non configuré — ajoutez-le dans Render Environment Variables.');
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn,
  });
}

module.exports = authenticate;
module.exports.optionalAuth = optionalAuth;
module.exports.signToken    = signToken;
