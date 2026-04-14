'use strict';
/**
 * OmniSMS — Security Middleware Stack
 *
 * Regroupe toutes les protections HTTP en un seul fichier :
 *  1. Helmet (headers HTTP sécurisés)
 *  2. CORS strict
 *  3. HPP (HTTP Parameter Pollution)
 *  4. Body size limits
 *  5. Rate limiting global + par route
 *  6. Slow-down (progressive delay avant rate-limit)
 *  7. Input sanitization (strip null bytes, contrôle dangereux)
 *  8. Content-Type enforcement sur les routes POST/PUT
 */

const helmet      = require('helmet');
const cors        = require('cors');
const hpp         = require('hpp');
const rateLimit   = require('express-rate-limit');
const slowDown    = require('express-slow-down');
const compression = require('compression');

// ── Origines CORS autorisées ─────────────────────────────────
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const allowedOrigins = CORS_ORIGIN === '*'
  ? true
  : CORS_ORIGIN.split(',').map(o => o.trim());

// ── 1. Helmet — headers HTTP sécurisés ───────────────────────
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc : ["'self'"],
      scriptSrc  : ["'self'", "'unsafe-inline'"],   // inline pour la page HTML /payment-success
      styleSrc   : ["'self'", "'unsafe-inline'"],
      imgSrc     : ["'self'", 'data:', 'https:'],
      connectSrc : ["'self'"],
      frameSrc   : ["'none'"],
      objectSrc  : ["'none'"],
    },
  },
  crossOriginEmbedderPolicy : false,  // nécessaire pour WebView
  crossOriginResourcePolicy : { policy: 'cross-origin' },
  hsts: {
    maxAge           : 31536000,  // 1 an
    includeSubDomains: true,
    preload          : true,
  },
});

// ── 2. CORS ───────────────────────────────────────────────────
const corsMiddleware = cors({
  origin      : allowedOrigins,
  methods     : ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'x-api-key', 'x-request-id'],
  exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  credentials : true,
  maxAge      : 86400,  // 24h preflight cache
});

// ── 3. Compression gzip/br ────────────────────────────────────
const compressionMiddleware = compression({
  level : 6,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
});

// ── 4. Rate limiters ─────────────────────────────────────────

/** Global : 200 req / 15 min par IP */
const globalLimiter = rateLimit({
  windowMs       : 15 * 60 * 1000,
  max            : 200,
  standardHeaders: true,
  legacyHeaders  : false,
  skip           : (req) => req.path === '/health',   // health check non limité
  message        : { error: 'Trop de requêtes. Réessayez dans 15 minutes.', code: 'RATE_LIMIT' },
});

/** Auth : 20 tentatives / 15 min par IP (brute-force login) */
const authLimiter = rateLimit({
  windowMs       : 15 * 60 * 1000,
  max            : 20,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { error: 'Trop de tentatives. Réessayez dans 15 minutes.', code: 'AUTH_RATE_LIMIT' },
});

/** Paiement confirm : 5 req / 5 min par IP */
const paymentConfirmLimiter = rateLimit({
  windowMs       : 5 * 60 * 1000,
  max            : 5,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { error: 'Trop de tentatives de confirmation. Attendez 5 minutes.', code: 'PAYMENT_RATE_LIMIT' },
});

/** Fusion Pay initiation : 10 req / 1 min par IP */
const fusionPayLimiter = rateLimit({
  windowMs       : 60 * 1000,
  max            : 10,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { error: 'Trop de tentatives. Réessayez dans 1 minute.', code: 'FUSION_PAY_RATE_LIMIT' },
});

// ── 5. Slow-down (délai progressif avant blocage) ─────────────
/** Après 100 req, ajouter 200ms de délai par requête supplémentaire */
const globalSlowDown = slowDown({
  windowMs         : 15 * 60 * 1000,
  delayAfter       : 100,
  delayMs          : (hits) => (hits - 100) * 200,
  maxDelayMs       : 5000,
  skip             : (req) => req.path === '/health',
});

// ── 6. Input sanitizer ────────────────────────────────────────
/** Supprime les caractères de contrôle dangereux des strings */
function deepSanitizeStrings(obj) {
  if (typeof obj === 'string') {
    // Supprimer null bytes et caractères de contrôle (sauf \n, \r, \t)
    return obj.replace(/\x00/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }
  if (Array.isArray(obj)) return obj.map(deepSanitizeStrings);
  if (obj && typeof obj === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      clean[k] = deepSanitizeStrings(v);
    }
    return clean;
  }
  return obj;
}

function inputSanitizer(req, res, next) {
  if (req.body)  req.body  = deepSanitizeStrings(req.body);
  if (req.query) req.query = deepSanitizeStrings(req.query);
  next();
}

// ── 7. Content-Type enforcement ───────────────────────────────
function requireJson(req, res, next) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json') && !ct.includes('application/x-www-form-urlencoded') && !ct.includes('multipart/form-data')) {
      return res.status(415).json({ error: 'Content-Type non supporté.', code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
  }
  next();
}

module.exports = {
  helmetMiddleware,
  corsMiddleware,
  compressionMiddleware,
  hppMiddleware    : hpp(),
  globalLimiter,
  globalSlowDown,
  authLimiter,
  paymentConfirmLimiter,
  fusionPayLimiter,
  inputSanitizer,
  requireJson,
};
