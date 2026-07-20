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
 *     ⚠️  FIX CRITIQUE : req.query est un getter-only dans Node/Express moderne.
 *         On ne mute PLUS req.query — on attache req.cleanedQuery à la place.
 *  8. Content-Type enforcement sur les routes POST/PUT
 */

const helmet      = require('helmet');
const cors        = require('cors');
const hpp         = require('hpp');
const rateLimit   = require('express-rate-limit');
const slowDown    = require('express-slow-down');
const compression = require('compression');

// ── Origines CORS autorisées ─────────────────────────────────
const allowedOrigins = [
  // Netlify / Firebase
  'https://omnisms.netlify.app',
  'https://omnisms.web.app',
  // Vercel — URL principale + previews
  'https://omnisms-frontend.vercel.app',
  'https://omnisms-frontend-qx1u5k6h9-emmanuel-lezin.vercel.app',
  // Dev local
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:8080',
  ...(process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : []),
];

// Regex pour autoriser tous les sous-domaines vercel.app du projet
const vercelPattern = /^https:\/\/omnisms-frontend(-[a-z0-9]+-emmanuel-lezin)?(\.vercel\.app)$/;

// ── 1. Helmet — headers HTTP sécurisés ───────────────────────
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc : ["'self'"],
      scriptSrc  : ["'self'", "'unsafe-inline'"],
      styleSrc   : ["'self'", "'unsafe-inline'"],
      imgSrc     : ["'self'", 'data:', 'https:'],
      connectSrc : ["'self'"],
      frameSrc   : ["'none'"],
      objectSrc  : ["'none'"],
    },
  },
  crossOriginEmbedderPolicy : false,
  crossOriginResourcePolicy : { policy: 'cross-origin' },
  hsts: {
    maxAge           : 31536000,
    includeSubDomains: true,
    preload          : true,
  },
});

// ── 2. CORS ───────────────────────────────────────────────────
const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Autoriser les requêtes sans origine (mobile apps, Postman, curl)
    if (!origin) return callback(null, true);
    // Origines explicites
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Tous les déploiements Vercel du projet (preview + production)
    if (vercelPattern.test(origin)) return callback(null, true);
    // Log pour debug
    console.warn('[CORS] Origine rejetée:', origin);
    return callback(new Error('CORS non autorisé pour : ' + origin), false);
  },
  methods       : ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'x-admin-key',
    'x-api-key', 'x-request-id', 'X-API-Key', 'X-API-Secret',
  ],
  exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  credentials   : true,
  maxAge        : 86400,
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

/** Global : 300 req / 15 min par IP */
const globalLimiter = rateLimit({
  windowMs       : 15 * 60 * 1000,
  max            : 300,
  standardHeaders: true,
  legacyHeaders  : false,
  skip           : (req) => req.path === '/health' || req.path === '/',
  message        : { error: 'Trop de requêtes. Réessayez dans 15 minutes.', code: 'RATE_LIMIT' },
});

/** Auth : 30 tentatives / 15 min par IP (brute-force login) */
const authLimiter = rateLimit({
  windowMs       : 15 * 60 * 1000,
  max            : 30,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { error: 'Trop de tentatives. Réessayez dans 15 minutes.', code: 'AUTH_RATE_LIMIT' },
});

/** Paiement confirm : 10 req / 5 min par IP */
const paymentConfirmLimiter = rateLimit({
  windowMs       : 5 * 60 * 1000,
  max            : 10,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { error: 'Trop de tentatives de confirmation. Attendez 5 minutes.', code: 'PAYMENT_RATE_LIMIT' },
});

/** LeekPay initiation : 10 req / 1 min par IP */
const leekPayLimiter = rateLimit({
  windowMs       : 60 * 1000,
  max            : 10,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { error: 'Trop de tentatives de paiement. Réessayez dans 1 minute.', code: 'PAYMENT_RATE_LIMIT' },
});

// ── 5. Slow-down (délai progressif avant blocage) ─────────────
const globalSlowDown = slowDown({
  windowMs         : 15 * 60 * 1000,
  delayAfter       : 150,
  delayMs          : (hits) => (hits - 150) * 200,
  maxDelayMs       : 5000,
  skip             : (req) => req.path === '/health' || req.path === '/',
});

// ── 6. Input sanitizer (FIX CRITIQUE) ────────────────────────
function deepSanitizeStrings(obj) {
  if (typeof obj === 'string') {
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

function inputSanitizer(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    try {
      req.body = deepSanitizeStrings(req.body);
    } catch (_) {}
  }

  try {
    const rawQuery = req.query;
    if (rawQuery && typeof rawQuery === 'object') {
      req.cleanedQuery = deepSanitizeStrings({ ...rawQuery });
    } else {
      req.cleanedQuery = {};
    }
  } catch (_) {
    req.cleanedQuery = {};
  }

  try {
    if (req.params && typeof req.params === 'object') {
      req.cleanedParams = deepSanitizeStrings({ ...req.params });
    } else {
      req.cleanedParams = {};
    }
  } catch (_) {
    req.cleanedParams = {};
  }

  next();
}

// ── 7. Content-Type enforcement ───────────────────────────────
function requireJson(req, res, next) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    if (
      !ct.includes('application/json') &&
      !ct.includes('application/x-www-form-urlencoded') &&
      !ct.includes('multipart/form-data')
    ) {
      return res.status(415).json({
        error: 'Content-Type non supporté.',
        code : 'UNSUPPORTED_MEDIA_TYPE',
      });
    }
  }
  next();
}

// ── Helper pour les routes : lire la query sanitisée ─────────
function getQueryParam(req, key) {
  const cleaned = req.cleanedQuery || {};
  const raw     = req.query        || {};
  return cleaned[key] !== undefined ? cleaned[key] : raw[key];
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
  leekPayLimiter,
  inputSanitizer,
  requireJson,
  getQueryParam,
  deepSanitizeStrings,
};
