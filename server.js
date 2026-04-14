'use strict';
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║           OmniSMS Backend — v2.3                        ║
 * ║  Production-ready · Sécurisé · Maintenable              ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Architecture :
 *  💳 PAIEMENT  → Fusion Pay API (nouveau) + Fusion Link (conservé)
 *  📱 SMS       → Webhook universel (Africa's Talking / Twilio / Orange)
 *  👤 CONTACTS  → Carnet d'adresses Firestore + envoi SMS intelligent
 *  🔒 SÉCURITÉ  → Helmet + CORS + HPP + Rate-limit + Slow-down + Sanitize
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
  inputSanitizer,
  requireJson,
} = require('./middleware/security');

const { requestLogger, logger } = require('./middleware/logger');

/* ============================================================
   VALIDATION DES VARIABLES D'ENVIRONNEMENT CRITIQUES
============================================================ */
const REQUIRED_ENV = ['JWT_SECRET', 'ADMIN_KEY', 'FIREBASE_SERVICE_ACCOUNT_JSON'];

if (process.env.NODE_ENV === 'production') {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logger.error('Variables d\'environnement manquantes', { missing });
    process.exit(1);
  }
}

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

// 3. CORS
app.use(corsMiddleware);

// 4. Logs structurés (injecte req.requestId)
app.use(requestLogger);

// 5. Body parsers (limits strictes)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 6. Protection HTTP Parameter Pollution
app.use(hppMiddleware);

// 7. Sanitization des inputs (null bytes, chars de contrôle)
app.use(inputSanitizer);

// 8. Rate limit global + slow-down
app.use(globalSlowDown);
app.use(globalLimiter);

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
const contactRoutes       = require('./routes/contacts');  // 🆕 contacts + send-sms

// Chargement des routes optionnelles (pas bloquant si fichier absent)
function loadOptional(routePath, mount) {
  try {
    app.use(mount, require(routePath));
    logger.info(`Route chargée : ${mount}`);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
      logger.warn(`Route optionnelle erreur (${mount})`, { error: e.message });
    }
  }
}

/* ============================================================
   HEALTH CHECK (non rate-limité)
   Inclut le statut Firebase et des providers SMS
============================================================ */
app.get('/health', async (req, res) => {
  const mem = process.memoryUsage();

  // Vérifier la connexion Firebase
  let firebaseStatus = 'connected';
  let firebaseProject = null;
  try {
    const db = require('./config/firebase');
    // Lecture légère pour confirmer la connexion
    await db.collection('_health').doc('ping').get();
    const admin = require('./firebase-admin/index');
    firebaseProject = admin.app?.().options?.projectId || 'unknown';
  } catch (err) {
    firebaseStatus = `error: ${err.message}`;
  }

  // Statut des providers SMS
  let smsProvider = {};
  try {
    const { getProviderStatus } = require('./services/smsProvider');
    smsProvider = getProviderStatus();
  } catch { smsProvider = { activeProvider: 'unknown' }; }

  res.json({
    status  : firebaseStatus === 'connected' ? 'ok' : 'degraded',
    service : 'OmniSMS Backend v2.3',
    version : '2.3.0',
    uptime  : `${Math.floor(process.uptime())}s`,
    firebase: {
      status : firebaseStatus,
      project: firebaseProject,
    },
    sms     : smsProvider,
    memory  : {
      heapUsed : `${Math.round(mem.heapUsed  / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      rss      : `${Math.round(mem.rss       / 1024 / 1024)}MB`,
    },
    node    : process.version,
    time    : new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name   : 'OmniSMS Backend',
    version: '2.3.0',
    status : 'running',
    health : '/health',
    status2: '/api/status',
    routes : {
      sms     : 'POST /sms/incoming, POST /sms/test, GET /sms/commands',
      contacts: 'POST /add-contact, GET /contacts/:userId, DELETE /contacts/:userId/:phone, POST /send-sms',
      auth    : 'POST /api/auth/register, POST /api/auth/login, GET /api/auth/me, PUT /api/auth/profile',
      payment : 'POST /api/payment/fusion-pay, POST /api/payment/fusion-callback, POST /api/payment/fusion-callback-api',
    },
  });
});

/* ============================================================
   ROUTES AUTHENTIFICATION
   Rate-limit renforcé contre le brute-force
============================================================ */
app.use('/api/auth', authLimiter, requireJson, authRoutes);
app.use('/auth',     authLimiter, requireJson, authRoutes);  // alias rétrocompat

/* ============================================================
   SYSTÈME 1 : FUSION LINK (CONSERVÉ)
   GET  /payment-success
   POST /confirm-payment  ← rate-limit strict
   GET  /moneyfusion-link
============================================================ */
app.use('/', paymentOnlineRoutes);
app.use('/confirm-payment', paymentConfirmLimiter);

/* ============================================================
   SYSTÈME 2 : FUSION PAY API (NOUVEAU — PARALLÈLE)
   POST /api/payment/fusion-pay
   POST /api/payment/fusion-callback
   GET  /api/payment/fusion-status/:token
   GET  /api/payment/fusion-user/:userId
   GET  /api/payment/fusion-return
   GET  /api/payment/fusion-config
   GET  /api/payment/fusion-link-url
============================================================ */
app.use('/api/payment', paymentFusionRoutes);

/* ============================================================
   SMS WEBHOOKS (OFFLINE)
   POST /sms/incoming
   POST /sms/test
   GET  /sms/commands
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
app.use('/messages',     messageRoutes);
app.use('/groups',       groupRoutes);
app.use('/users',        userRoutes);
app.use('/me',           meRoutes);
app.use('/notifications', notifRoutes);
app.use('/statistics',   statsRoutes);

/* ============================================================
   CONTACTS & ENVOI SMS
   POST /add-contact
   GET  /contacts/:userId
   POST /send-sms
   DELETE /contacts/:userId/:contactPhone
============================================================ */
app.use('/', contactRoutes);

loadOptional('./routes/audio',       '/audio');
loadOptional('./routes/ads',         '/ads');
loadOptional('./routes/companies',   '/companies');
loadOptional('./routes/credits',     '/credits');
loadOptional('./routes/smsCost',     '/sms-cost');
loadOptional('./routes/transcription', '/transcription');
loadOptional('./routes/subscriptions', '/subscriptions');

/* ============================================================
   API STATUS
============================================================ */
app.get('/api/status', (req, res) => {
  res.json({
    status : 'OmniSMS Backend v2.3 running',
    port   : PORT,
    env    : process.env.NODE_ENV || 'development',
    payment: {
      fusion_link: {
        enabled: true,
        routes : ['GET /payment-success', 'POST /confirm-payment'],
        status : 'ACTIF',
      },
      fusion_pay: {
        enabled: !!process.env.FUSION_PAY_API_URL,
        routes : ['POST /api/payment/fusion-pay', 'POST /api/payment/fusion-callback', 'POST /api/payment/fusion-callback-api'],
        status : process.env.FUSION_PAY_API_URL ? 'ACTIF' : 'INACTIF (FUSION_PAY_API_URL absent)',
      },
      sms_offline: { enabled: true },
    },
    security: {
      helmet      : true,
      cors        : true,
      rateLimit   : true,
      slowDown    : true,
      hpp         : true,
      sanitize    : true,
      compression : true,
    },
    time: new Date().toISOString(),
  });
});

/* ============================================================
   GESTIONNAIRE D'ERREURS GLOBAL
   Ne jamais exposer les stack traces en production
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

  // Erreurs de validation du body JSON
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Corps de requête trop volumineux.', code: 'PAYLOAD_TOO_LARGE' });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalide.', code: 'INVALID_JSON' });
  }

  res.status(err.status || 500).json({
    error    : 'Erreur interne du serveur.',
    code     : 'INTERNAL_ERROR',
    requestId,
    // Stack uniquement en développement
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

// Timeouts pour éviter les connexions zombie
server.keepAliveTimeout = 65000;   // > 60s (load balancer Render)
server.headersTimeout   = 66000;

server.listen(PORT, '0.0.0.0', () => {
  logger.info('OmniSMS Backend démarré', {
    port   : PORT,
    env    : process.env.NODE_ENV || 'development',
    node   : process.version,
    fusionPay: !!process.env.FUSION_PAY_API_URL,
  });

  // Logs console lisibles pour Render
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       OmniSMS Backend v2.3 — Production     ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`🚀 Port    : ${PORT}`);
  console.log(`🌍 ENV     : ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Firebase : ${process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? '✅ configuré' : '⚠️  absent'}`);
  console.log(`💳 FusionPay: ${process.env.FUSION_PAY_API_URL ? '✅ actif' : '⏸  inactif'}`);
  // Afficher le provider SMS actif
  try {
    const { getProviderStatus } = require('./services/smsProvider');
    const sp = getProviderStatus();
    console.log(`📱 SMS      : ${sp.activeProvider !== 'none' ? `✅ ${sp.activeProvider}` : '⚠️  aucun provider configuré'}`);
  } catch { /* non bloquant */ }
  console.log(`🔒 Sécurité : Helmet · CORS · Rate-limit · HPP · Sanitize`);
  console.log(`👤 Contacts : POST /add-contact · GET /contacts/:id · POST /send-sms`);
  console.log(`❤️  Health   : GET /health`);
  console.log('');
});

/* ============================================================
   GRACEFUL SHUTDOWN
   Arrêt propre — termine les requêtes en cours avant de quitter
============================================================ */
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Signal ${signal} reçu — arrêt propre en cours…`);
  console.log(`\n🛑 ${signal} reçu. Arrêt propre...`);

  // Arrêter d'accepter de nouvelles connexions
  server.close((err) => {
    if (err) {
      logger.error('Erreur durant le shutdown', { error: err.message });
      process.exit(1);
    }
    logger.info('Serveur arrêté proprement.');
    console.log('✅ Serveur arrêté proprement.');
    process.exit(0);
  });

  // Forcer l'arrêt après 30s si des connexions persistent
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
  // Arrêt obligatoire — état indéterminé
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promise rejetée non gérée', {
    reason: String(reason),
    promise: String(promise),
  });
  // Ne pas exit — loguer uniquement (peut être une lib tierce)
});

module.exports = app;
