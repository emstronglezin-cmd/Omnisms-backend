'use strict';
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║           OmniSMS Backend — v2.4                        ║
 * ║  Production-ready · Sécurisé · Maintenable              ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Architecture :
 *  💳 PAIEMENT  → GeniusPay (primaire) + Fusion Pay API + Fusion Link
 *  📱 SMS       → Webhook universel (Africa's Talking / Twilio / Orange)
 *  👤 AUTH      → Email/Password + Google Sign-In (Firebase-backed JWT)
 *  🔒 SÉCURITÉ  → Helmet · CORS · HPP · Rate-limit · Slow-down · Sanitize
 *  📊 LOGS      → JSON structurés + Request-ID propagé
 *  🔄 GRACEFUL  → Arrêt propre SIGTERM/SIGINT avec drain des connexions
 */

require('dotenv').config();

const express = require('express');
const http    = require('http');

// ── Middleware de sécurité ──────────────────────────────────
const {
  helmetMiddleware,
  corsMiddleware,
  compressionMiddleware,
  hppMiddleware,
  globalLimiter,
  globalSlowDown,
  paymentConfirmLimiter,
  authLimiter,
  geniusPayLimiter,
  inputSanitizer,
  requireJson,
} = require('./middleware/security');

const { requestLogger, logger } = require('./middleware/logger');

/* ============================================================
   APPLICATION EXPRESS
============================================================ */
const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 5000;

// Faire confiance au proxy Render (pour req.ip correct)
app.set('trust proxy', 1);

/* ============================================================
   MIDDLEWARES GLOBAUX (ordre critique)
============================================================ */

// 1. Compression (avant tout pour réduire le trafic)
app.use(compressionMiddleware);

// 2. Headers de sécurité HTTP
app.use(helmetMiddleware);

// 3. CORS — doit être avant tout autre traitement
app.use(corsMiddleware);
// Répondre immédiatement aux preflight OPTIONS
app.options('*', corsMiddleware);

// 4. Logs structurés (injecte req.requestId)
app.use(requestLogger);

// 5. Body parsers (limits strictes)
// Capture du corps brut (rawBody) pour la vérification HMAC des webhooks GeniusPay
app.use(express.json({
  limit : '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// 6. Protection HTTP Parameter Pollution
app.use(hppMiddleware);

// 7. Sanitization des inputs (null bytes, chars de contrôle)
//    ⚠️  FIX : n'écrit plus sur req.query (getter-only) — utilise req.cleanedQuery
app.use(inputSanitizer);

// 8. Rate limit global + slow-down
app.use(globalSlowDown);
app.use(globalLimiter);

/* ============================================================
   HELPER — lire la query de façon sûre (req.cleanedQuery || req.query)
============================================================ */
function q(req, key) {
  const cq = req.cleanedQuery || {};
  return cq[key] !== undefined ? cq[key] : (req.query || {})[key];
}

/* ============================================================
   ROUTES PRIORITAIRES — répondent avant tout rate-limit
============================================================ */

// GET / — Status JSON (production-ready)
app.get('/', (_req, res) => {
  const gpConfigured = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );

  let smsProvider = 'none';
  try {
    const { getProviderStatus } = require('./services/smsProvider');
    smsProvider = getProviderStatus().activeProvider;
  } catch (_) { /* non bloquant */ }

  return res.status(200).json({
    status  : 'ok',
    service : 'OmniSMS Backend',
    version : '2.4.0',
    auth    : true,
    payments: gpConfigured,
    sms     : smsProvider !== 'none',
    geniuspay: gpConfigured ? 'ACTIVE' : 'INACTIVE',
    smsProvider,
    env     : process.env.NODE_ENV || 'development',
    time    : new Date().toISOString(),
  });
});

// GET /health — Diagnostics complets (Render health check)
app.get('/health', async (_req, res) => {
  const gpConfigured = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );

  let smsStatus = { activeProvider: 'none', twilio: {}, africastalking: {}, orange: {} };
  try {
    const { getProviderStatus } = require('./services/smsProvider');
    smsStatus = getProviderStatus();
  } catch (_) { /* non bloquant */ }

  const firebaseOk = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const jwtOk      = !!process.env.JWT_SECRET;

  const healthy = firebaseOk; // minimum requis

  return res.status(healthy ? 200 : 503).json({
    status : healthy ? 'ok' : 'degraded',
    service: 'OmniSMS Backend',
    version: '2.4.0',
    uptime : Math.round(process.uptime()),
    time   : new Date().toISOString(),
    checks : {
      firebase : firebaseOk  ? 'ok' : 'MISSING — set FIREBASE_SERVICE_ACCOUNT_JSON',
      jwt      : jwtOk       ? 'ok' : 'MISSING — set JWT_SECRET',
      geniuspay: gpConfigured ? 'ACTIVE' : 'INACTIVE — set GENIUSPAY_PUBLIC_KEY + GENIUSPAY_SECRET_KEY',
      sms      : {
        activeProvider: smsStatus.activeProvider,
        status        : smsStatus.activeProvider !== 'none' ? 'ACTIVE' : 'INACTIVE — set Twilio/AfricasTalking/Orange env vars',
        twilio        : smsStatus.twilio?.configured         ? 'configured' : 'not configured',
        africastalking: smsStatus.africastalking?.configured ? 'configured' : 'not configured',
        orange        : smsStatus.orange?.configured         ? 'configured' : 'not configured',
      },
    },
    routes: {
      auth    : ['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/google', 'GET /api/auth/me'],
      payment : ['POST /api/payment/geniuspay', 'POST /api/payment/webhook', 'GET /api/user/status'],
      sms     : ['POST /sms/incoming', 'POST /sms/hybrid/incoming'],
      health  : ['GET /', 'GET /health', 'GET /api/status'],
    },
  });
});

/* ============================================================
   IMPORT DES ROUTES
============================================================ */
const authRoutes          = require('./routes/auth');
const paymentOnlineRoutes = require('./routes/payment.online');
const paymentFusionRoutes = require('./routes/payment.fusionpay');
const smsWebhookRoutes    = require('./routes/sms.webhook');
const adminRoutes         = require('./routes/admin');
const messageRoutes       = require('./routes/messages');
const groupRoutes         = require('./routes/groups');
const userRoutes          = require('./routes/users');
const meRoutes            = require('./routes/me');
const notifRoutes         = require('./routes/notifications');
const statsRoutes         = require('./routes/statistics');
const contactRoutes       = require('./routes/contacts');
const geniusPayRoutes     = require('./routes/payment.geniuspay');
const paymentRoutes       = require('./routes/payment');
const webhookRoutes       = require('./routes/webhook');
const smsHybridRoutes     = require('./routes/sms.hybrid');

// Chargement des routes optionnelles (pas bloquant si fichier absent)
function loadOptional(routePath, mount) {
  try {
    const mod = require(routePath);
    app.use(mount, mod);
    logger.info(`Route optionnelle chargée : ${mount}`);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
      logger.warn(`Route optionnelle erreur (${mount})`, { error: e.message });
    }
  }
}

/* ============================================================
   ROUTES AUTHENTIFICATION
   Rate-limit renforcé contre le brute-force
============================================================ */
app.use('/api/auth', authLimiter, requireJson, authRoutes);
app.use('/auth',     authLimiter, requireJson, authRoutes); // alias rétrocompat

/* ============================================================
   SYSTÈME 1 : FUSION LINK (CONSERVÉ)
============================================================ */
app.use('/', paymentOnlineRoutes);
app.use('/confirm-payment', paymentConfirmLimiter);

/* ============================================================
   SYSTÈME 2 : FUSION PAY API (CONSERVÉ — PARALLÈLE)
============================================================ */
app.use('/api/payment', paymentFusionRoutes);

/* ============================================================
   SYSTÈME 3 : GENIUSPAY (PRIMAIRE)
============================================================ */
// Routes simples — POST /api/payment/geniuspay et POST /api/payment/webhook
app.use('/api/payment', geniusPayLimiter, paymentRoutes);
app.use('/api/payment', webhookRoutes);

// Routes avancées — /api/payment/geniuspay/*
app.use('/api/payment/geniuspay', geniusPayLimiter, geniusPayRoutes);
app.use('/api/payment', geniusPayRoutes);

/* ============================================================
   SMS HYBRIDE (NOUVEAU — ADDITIONNEL)
============================================================ */
app.use('/sms/hybrid', smsHybridRoutes);

/* ============================================================
   SMS WEBHOOKS (OFFLINE — EXISTANT — INCHANGÉ)
============================================================ */
app.use('/sms', smsWebhookRoutes);

// Alias providers
app.post('/webhooks/africastalking', (req, res, next) => {
  req.url = '/incoming';
  smsWebhookRoutes(req, res, next);
});

app.post('/webhooks/twilio', express.urlencoded({ extended: false }), (req, res, next) => {
  req.url = '/incoming';
  smsWebhookRoutes(req, res, next);
});

/* ============================================================
   ADMIN — protégé par x-admin-key
============================================================ */
app.use('/admin', adminRoutes);

/* ============================================================
   AUTRES ROUTES
============================================================ */
app.use('/messages',      messageRoutes);
app.use('/groups',        groupRoutes);
app.use('/users',         userRoutes);
app.use('/me',            meRoutes);
app.use('/notifications', notifRoutes);
app.use('/statistics',    statsRoutes);

/* ============================================================
   CONTACTS & ENVOI SMS
============================================================ */
app.use('/', contactRoutes);

loadOptional('./routes/audio',         '/audio');
loadOptional('./routes/ads',           '/ads');
loadOptional('./routes/companies',     '/companies');
loadOptional('./routes/credits',       '/credits');
loadOptional('./routes/smsCost',       '/sms-cost');
loadOptional('./routes/transcription', '/transcription');
loadOptional('./routes/subscriptions', '/subscriptions');

/* ============================================================
   STATUT UTILISATEUR PREMIUM — GET /api/user/status
============================================================ */
const { getUserStatus } = require('./controllers/paymentController');
app.get('/api/user/status', (req, res) => {
  // Compatibilité req.cleanedQuery → patcher req.query temporairement si besoin
  if (req.cleanedQuery && !req.query.userId && req.cleanedQuery.userId) {
    // Injecter dans req.body en fallback si nécessaire
    req._userId = req.cleanedQuery.userId;
  }
  return getUserStatus(req, res);
});

/* ============================================================
   API STATUS — GET /api/status
============================================================ */
app.get('/api/status', (req, res) => {
  const gpConfigured = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );

  let smsStatus = { activeProvider: 'none' };
  try {
    const { getProviderStatus } = require('./services/smsProvider');
    smsStatus = getProviderStatus();
  } catch (_) { /* non bloquant */ }

  res.json({
    status  : 'OmniSMS Backend v2.4 running',
    port    : PORT,
    env     : process.env.NODE_ENV || 'development',
    geniuspay: gpConfigured ? 'ACTIVE' : 'INACTIVE',
    sms     : smsStatus.activeProvider !== 'none' ? `ACTIVE (${smsStatus.activeProvider})` : 'INACTIVE',
    payment : {
      geniuspay: {
        enabled: gpConfigured,
        status : gpConfigured ? 'ACTIVE' : 'INACTIVE (GENIUSPAY_PUBLIC_KEY / GENIUSPAY_SECRET_KEY manquants)',
        routes : [
          'POST /api/payment/geniuspay      ← créer paiement',
          'POST /api/payment/webhook        ← webhook confirmation',
          'GET  /api/user/status?userId=XXX ← statut premium',
          'POST /api/payment/geniuspay/create',
          'GET  /api/payment/link',
        ],
      },
      fusion_link: { enabled: true, status: 'ACTIVE' },
      fusion_pay : {
        enabled: !!process.env.FUSION_PAY_API_URL,
        status : process.env.FUSION_PAY_API_URL ? 'ACTIVE' : 'INACTIVE',
      },
    },
    smsProviders: smsStatus,
    time: new Date().toISOString(),
  });
});

/* ============================================================
   GESTIONNAIRE D'ERREURS GLOBAL
============================================================ */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const requestId = req.requestId || 'unknown';

  logger.error('Erreur non gérée', {
    requestId,
    message: err.message,
    stack  : err.stack,
    path   : req.path,
    method : req.method,
  });

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Corps de requête trop volumineux.', code: 'PAYLOAD_TOO_LARGE' });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalide.', code: 'INVALID_JSON' });
  }

  // Ne jamais exposer les stack traces en production
  return res.status(err.status || 500).json({
    error    : 'Erreur interne du serveur.',
    code     : 'INTERNAL_ERROR',
    requestId,
    ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    error    : 'Route non trouvée.',
    code     : 'NOT_FOUND',
    path     : req.path,
    requestId: req.requestId,
  });
});

/* ============================================================
   DÉMARRAGE DU SERVEUR
============================================================ */
const server = http.createServer(app);

server.keepAliveTimeout = 65000;
server.headersTimeout   = 66000;

server.listen(PORT, '0.0.0.0', () => {
  // Évaluer les statuts au démarrage
  const gpConfigured = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );

  let smsProviderName = 'aucun';
  try {
    const { getProviderStatus } = require('./services/smsProvider');
    const sp = getProviderStatus();
    smsProviderName = sp.activeProvider !== 'none' ? sp.activeProvider : 'aucun';
  } catch (_) { /* non bloquant */ }

  logger.info('OmniSMS Backend démarré', {
    port      : PORT,
    env       : process.env.NODE_ENV || 'development',
    node      : process.version,
    geniuspay : gpConfigured ? 'ACTIVE' : 'INACTIVE',
    sms       : smsProviderName !== 'aucun' ? `ACTIVE (${smsProviderName})` : 'INACTIVE',
  });

  // Logs console lisibles pour Render
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       OmniSMS Backend v2.4 — Production         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`🚀 Port      : ${PORT}`);
  console.log(`🌍 ENV       : ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Firebase  : ${process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? '✅ configuré' : '❌ FIREBASE_SERVICE_ACCOUNT_JSON absent'}`);
  console.log(`🔑 JWT       : ${process.env.JWT_SECRET ? '✅ configuré' : '❌ JWT_SECRET absent'}`);
  console.log(`💰 GeniusPay : ${gpConfigured ? '✅ ACTIVE' : '⚠️  INACTIVE (GENIUSPAY_PUBLIC_KEY / GENIUSPAY_SECRET_KEY)'}`);
  console.log(`📱 SMS       : ${smsProviderName !== 'aucun' ? `✅ ACTIVE (${smsProviderName})` : '⚠️  INACTIVE (Twilio / AfricasTalking / Orange)'}`);
  console.log(`💳 FusionPay : ${process.env.FUSION_PAY_API_URL ? '✅ actif' : '⏸  inactif'}`);
  console.log(`🔒 Sécurité  : Helmet · CORS · Rate-limit · HPP · Sanitize`);
  console.log(`❤️  Health    : GET /health`);
  console.log(`📊 Status    : GET /`);
  console.log('');
});

/* ============================================================
   GRACEFUL SHUTDOWN
============================================================ */
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Signal ${signal} reçu — arrêt propre en cours…`);
  console.log(`\n🛑 ${signal} reçu. Arrêt propre...`);

  server.close((err) => {
    if (err) {
      logger.error('Erreur durant le shutdown', { error: err.message });
      process.exit(1);
    }
    logger.info('Serveur arrêté proprement.');
    console.log('✅ Serveur arrêté proprement.');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('Shutdown forcé après 30s.');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

/* ============================================================
   GESTION DES ERREURS PROCESS NON CATCHÉES
============================================================ */
process.on('uncaughtException', (err) => {
  logger.error('Exception non catchée — arrêt du serveur', {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Promise rejetée non gérée', { reason: String(reason) });
});

module.exports = app;
