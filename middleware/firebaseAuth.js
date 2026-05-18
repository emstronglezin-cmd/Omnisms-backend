'use strict';
/**
 * OmniSMS — Middleware Firebase Auth
 *
 * Vérifie les tokens Firebase (verifyIdToken) ET les tokens JWT internes.
 *
 * Stratégie dual-mode :
 *  1. Essaie Firebase verifyIdToken en premier (tokens mobiles Flutter)
 *  2. Fallback JWT si Firebase non configuré ou token non-Firebase
 *
 * req.user après auth :
 *  {
 *    uid      : string,      ← Firebase UID ou userId JWT
 *    email    : string|null,
 *    phone    : string|null,
 *    authType : 'firebase' | 'jwt',
 *    token    : string,      ← token brut (pour logs)
 *  }
 *
 * Codes erreur :
 *  401 NO_TOKEN           — aucun header Authorization
 *  401 INVALID_TOKEN      — token invalide ou expiré
 *  401 TOKEN_EXPIRED      — token Firebase/JWT expiré
 *  503 AUTH_NOT_CONFIGURED — Firebase ET JWT tous les deux manquants
 */

const jwt = require('jsonwebtoken');
const { logger } = require('./logger');

/* ── Helpers ──────────────────────────────────────────────── */

function extractToken(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (!header) return null;
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return header.trim();
}

function getAdminAuth() {
  try {
    const admin = require('../firebase-admin/index');
    if (admin._stub) return null;
    return admin.auth();
  } catch (_) {
    return null;
  }
}

function getJwtSecret() {
  return process.env.JWT_SECRET || null;
}

/* ── Vérification Firebase ────────────────────────────────── */

async function verifyFirebaseToken(token) {
  const auth = getAdminAuth();
  if (!auth) return null;

  try {
    const decoded = await auth.verifyIdToken(token, true /* checkRevoked */);
    return {
      uid     : decoded.uid,
      email   : decoded.email   || null,
      phone   : decoded.phone_number || null,
      name    : decoded.name    || null,
      picture : decoded.picture || null,
      authType: 'firebase',
      token,
    };
  } catch (err) {
    // Distinguer token expiré vs token invalide
    if (err.code === 'auth/id-token-expired') {
      throw Object.assign(new Error('Token Firebase expiré.'), { code: 'TOKEN_EXPIRED' });
    }
    if (err.code === 'auth/id-token-revoked') {
      throw Object.assign(new Error('Token Firebase révoqué.'), { code: 'TOKEN_REVOKED' });
    }
    // Token non Firebase → retourner null (essaiera JWT ensuite)
    return null;
  }
}

/* ── Vérification JWT ─────────────────────────────────────── */

function verifyJwtToken(token) {
  const secret = getJwtSecret();
  if (!secret) return null;

  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    return {
      uid     : decoded.uid || decoded.userId || decoded.sub || decoded.id,
      email   : decoded.email || null,
      phone   : decoded.phone || null,
      name    : decoded.name  || null,
      authType: 'jwt',
      token,
      ...decoded,
    };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw Object.assign(
        new Error('Session expirée. Reconnectez-vous.'),
        { code: 'TOKEN_EXPIRED', expiredAt: err.expiredAt }
      );
    }
    return null; // Token invalide → pas JWT
  }
}

/* ── Middleware principal ─────────────────────────────────── */

/**
 * Middleware Firebase Auth dual-mode.
 * Vérifie d'abord Firebase, puis JWT.
 */
async function firebaseAuth(req, res, next) {
  const token = extractToken(req);

  if (!token || token.length < 10) {
    return res.status(401).json({
      error: 'Authentification requise.',
      code : token ? 'INVALID_TOKEN_FORMAT' : 'NO_TOKEN',
    });
  }

  const firebaseAvailable = !!getAdminAuth();
  const jwtAvailable      = !!getJwtSecret();

  if (!firebaseAvailable && !jwtAvailable) {
    return res.status(503).json({
      error: 'Service d\'authentification non configuré.',
      code : 'AUTH_NOT_CONFIGURED',
      hint : 'Set FIREBASE_SERVICE_ACCOUNT_JSON and/or JWT_SECRET in Render env vars.',
    });
  }

  try {
    // 1. Essayer Firebase
    let user = null;

    if (firebaseAvailable) {
      try {
        user = await verifyFirebaseToken(token);
      } catch (err) {
        if (err.code === 'TOKEN_EXPIRED' || err.code === 'TOKEN_REVOKED') {
          return res.status(401).json({
            error: err.message,
            code : err.code,
          });
        }
        // Autre erreur Firebase → continuer vers JWT
      }
    }

    // 2. Fallback JWT
    if (!user && jwtAvailable) {
      try {
        user = verifyJwtToken(token);
      } catch (err) {
        if (err.code === 'TOKEN_EXPIRED') {
          return res.status(401).json({
            error    : err.message,
            code     : 'TOKEN_EXPIRED',
            expiredAt: err.expiredAt,
          });
        }
      }
    }

    if (!user) {
      return res.status(401).json({
        error: 'Token invalide ou non reconnu.',
        code : 'INVALID_TOKEN',
      });
    }

    // Vérifier que uid est présent
    if (!user.uid) {
      return res.status(401).json({
        error: 'Token valide mais uid manquant.',
        code : 'INVALID_CLAIMS',
      });
    }

    req.user = user;
    logger.info('[Auth] Authenticated', {
      uid     : user.uid,
      authType: user.authType,
      path    : req.path,
      method  : req.method,
    });
    next();
  } catch (err) {
    logger.error('[Auth] Unexpected error', { error: err.message, path: req.path });
    return res.status(500).json({
      error: 'Erreur d\'authentification.',
      code : 'AUTH_ERROR',
    });
  }
}

/**
 * Middleware optionnel — charge req.user si token présent, ne bloque pas si absent.
 */
async function optionalFirebaseAuth(req, _res, next) {
  const token = extractToken(req);
  if (!token) { req.user = null; return next(); }

  try {
    let user = null;
    if (getAdminAuth()) {
      user = await verifyFirebaseToken(token).catch(() => null);
    }
    if (!user && getJwtSecret()) {
      user = verifyJwtToken(token);
    }
    req.user = user;
  } catch (_) {
    req.user = null;
  }
  next();
}

/**
 * Middleware admin — vérifie que req.user.uid est dans la liste des admins.
 */
function requireAdmin(req, res, next) {
  const admins = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!req.user) {
    return res.status(401).json({ error: 'Non authentifié.', code: 'NO_TOKEN' });
  }
  if (admins.length > 0 && !admins.includes(req.user.uid)) {
    return res.status(403).json({ error: 'Accès administrateur requis.', code: 'FORBIDDEN' });
  }
  next();
}

module.exports = firebaseAuth;
module.exports.optionalFirebaseAuth = optionalFirebaseAuth;
module.exports.requireAdmin         = requireAdmin;
