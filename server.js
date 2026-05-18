'use strict';
/**
 * OmniSMS Backend — v4.0
 *
 * Production-ready · Express · Socket.IO · Firebase graceful degradation
 * Payments  : GeniusPay only
 * SMS       : Infobip only
 * Realtime  : Socket.IO (messages, typing, online, seen)
 * Audio     : Upload + Streaming + Transcription Faster-Whisper
 * Queue     : BullMQ + Redis (inline fallback si Redis absent)
 * Auth      : Firebase verifyIdToken + JWT fallback
 */

require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '/etc/secrets/.env' : '.env',
});

const express = require('express');
const http    = require('http');
const path    = require('path');

const {
  helmetMiddleware,
  corsMiddleware,
  compressionMiddleware,
  hppMiddleware,
  globalLimiter,
  globalSlowDown,
  authLimiter,
  geniusPayLimiter,
  inputSanitizer,
  requireJson,
} = require('./middleware/security');

const { requestLogger, logger } = require('./middleware/logger');

const app    = express();
const server = http.createServer(app);
const PORT   = parseInt(process.env.PORT, 10) || 5000;

app.set('trust proxy', 1);

/* ── Middleware global ───────────────────────────────────── */
app.use(compressionMiddleware);
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.options(/.*/, corsMiddleware);
app.use(requestLogger);
app.use(express.json({
  limit : '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(hppMiddleware);
app.use(inputSanitizer);
app.use(globalSlowDown);
app.use(globalLimiter);

/* ── Servir les uploads en statique ─────────────────────── */
app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'), {
    maxAge    : '1d',
    etag      : true,
    lastModified: true,
    setHeaders(res, filePath) {
      // Content-Type correct pour l'audio
      if (filePath.match(/\.(mp3|m4a|aac)$/i)) {
        res.setHeader('Content-Type', 'audio/mpeg');
      } else if (filePath.match(/\.wav$/i)) {
        res.setHeader('Content-Type', 'audio/wav');
      } else if (filePath.match(/\.ogg$/i)) {
        res.setHeader('Content-Type', 'audio/ogg');
      } else if (filePath.match(/\.webm$/i)) {
        res.setHeader('Content-Type', 'audio/webm');
      }
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  })
);

/* ── Health & status ─────────────────────────────────────── */
app.get('/', (_req, res) => {
  const gpConfigured = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );
  const infobipOk = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);

  res.status(200).json({
    status   : 'ok',
    service  : 'OmniSMS Backend',
    version  : '4.0.0',
    auth     : true,
    payments : gpConfigured,
    sms      : infobipOk,
    realtime : true,
    geniuspay: gpConfigured ? 'ACTIVE' : 'INACTIVE',
    infobip  : infobipOk    ? 'ACTIVE' : 'INACTIVE',
    env      : process.env.NODE_ENV || 'development',
    time     : new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  const gpConfigured = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );
  const firebaseOk = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const jwtOk      = !!process.env.JWT_SECRET;
  const infobipOk  = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);
  const redisOk    = !!process.env.REDIS_URL;

  let queueStatus = {};
  try { queueStatus = require('./services/queueService').getQueueStatus(); } catch (_) {}

  res.status(200).json({
    status  : 'ok',
    service : 'OmniSMS Backend',
    version : '4.0.0',
    uptime  : Math.round(process.uptime()),
    time    : new Date().toISOString(),
    checks  : {
      firebase : firebaseOk  ? 'ok' : 'MISSING — set FIREBASE_SERVICE_ACCOUNT_JSON in Render env',
      jwt      : jwtOk       ? 'ok' : 'MISSING — set JWT_SECRET',
      geniuspay: gpConfigured ? 'ACTIVE' : 'INACTIVE — set GENIUSPAY_PUBLIC_KEY + GENIUSPAY_SECRET_KEY',
      infobip  : infobipOk   ? 'ACTIVE' : 'INACTIVE — set INFOBIP_API_KEY + INFOBIP_BASE_URL',
      redis    : redisOk     ? 'CONFIGURED' : 'MISSING — using memory fallback (set REDIS_URL)',
      socketio : 'ACTIVE',
    },
    queue   : queueStatus,
    routes  : {
      auth       : ['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/google', 'GET /api/auth/me'],
      contacts   : ['POST /api/contacts/sync', 'POST /api/contacts/add', 'GET /api/contacts', 'DELETE /api/contacts/:phone', 'GET /api/contacts/check/:phone'],
      messages   : ['POST /api/messages/send', 'GET /api/messages/conversation/:uid', 'GET /api/messages/conversations', 'PUT /api/messages/:id/read', 'DELETE /api/messages/:id'],
      audio      : ['POST /api/audio/upload', 'POST /api/audio/transcribe/:id', 'GET /api/audio/stream/:filename', 'GET /api/audio/:id'],
      payment    : ['POST /api/payment/geniuspay', 'POST /api/payment/webhook', 'POST /api/payment/geniuspay/create'],
      sms        : ['POST /api/sms/send', 'POST /webhooks/infobip', 'GET /api/sms/infobip/status'],
      realtime   : ['ws:// Socket.IO — connect with { auth: { token } }'],
      health     : ['GET /', 'GET /health', 'GET /api/status'],
    },
  });
});

/* ── Route imports ───────────────────────────────────────── */
const authRoutes        = require('./routes/auth');
const geniusPayRoutes   = require('./routes/payment.geniuspay');
const paymentRoutes     = require('./routes/payment');
const webhookRoutes     = require('./routes/webhook');
const infobipRoutes     = require('./routes/sms.infobip');
const adminRoutes       = require('./routes/admin');
const groupRoutes       = require('./routes/groups');
const userRoutes        = require('./routes/users');
const meRoutes          = require('./routes/me');
const notifRoutes       = require('./routes/notifications');
const statsRoutes       = require('./routes/statistics');

// v2 — nouvelles routes
const contactsV2Routes  = require('./routes/contacts.v2');
const messagesV2Routes  = require('./routes/messages.v2');
const audioV2Routes     = require('./routes/audio.v2');

/* ── loadOptional helper ─────────────────────────────────── */
function loadOptional(routePath, mount) {
  try {
    const mod = require(routePath);
    app.use(mount, mod);
    logger.info(`Optional route loaded: ${mount}`);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
      logger.warn(`Optional route error (${mount}): ${e.message}`);
    }
  }
}

/* ── Auth ────────────────────────────────────────────────── */
app.use('/api/auth', authLimiter, requireJson, authRoutes);
app.use('/auth',     authLimiter, requireJson, authRoutes);  // retrocompat

/* ── Contacts v2 ─────────────────────────────────────────── */
app.use('/api/contacts', contactsV2Routes);

/* ── Messages v2 ─────────────────────────────────────────── */
app.use('/api/messages', messagesV2Routes);

/* ── Audio v2 ────────────────────────────────────────────── */
app.use('/api/audio', audioV2Routes);

/* ── GeniusPay payments ──────────────────────────────────── */
app.use('/api/payment', geniusPayLimiter, paymentRoutes);
app.use('/api/payment', webhookRoutes);
app.use('/api/payment/geniuspay', geniusPayLimiter, geniusPayRoutes);
app.use('/api/payment', geniusPayRoutes);

/* ── Infobip SMS ─────────────────────────────────────────── */
app.use('/', infobipRoutes);

/* ── Premium user status ─────────────────────────────────── */
const { getUserStatus } = require('./controllers/paymentController');
app.get('/api/user/status', (req, res) => getUserStatus(req, res));

/* ── Admin & feature routes ──────────────────────────────── */
app.use('/admin',         adminRoutes);
app.use('/groups',        groupRoutes);
app.use('/users',         userRoutes);
app.use('/me',            meRoutes);
app.use('/notifications', notifRoutes);
app.use('/statistics',    statsRoutes);

/* ── Optional routes ─────────────────────────────────────── */
loadOptional('./routes/ads',           '/ads');
loadOptional('./routes/companies',     '/companies');
loadOptional('./routes/credits',       '/credits');
loadOptional('./routes/smsCost',       '/sms-cost');
loadOptional('./routes/subscriptions', '/subscriptions');
loadOptional('./routes/sms.hybrid',    '/sms/hybrid');

/* ── Ancienne route contacts (rétrocompat) ───────────────── */
loadOptional('./routes/contacts',      '/');

/* ── API status ──────────────────────────────────────────── */
app.get('/api/status', (_req, res) => {
  const gpConfigured = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );
  const infobipOk = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);

  let queue = {};
  try { queue = require('./services/queueService').getQueueStatus(); } catch (_) {}

  res.json({
    status   : 'OmniSMS Backend v4.0 running',
    version  : '4.0.0',
    port     : PORT,
    env      : process.env.NODE_ENV || 'development',
    geniuspay: gpConfigured ? 'ACTIVE' : 'INACTIVE',
    infobip  : infobipOk    ? 'ACTIVE' : 'INACTIVE',
    redis    : process.env.REDIS_URL ? 'CONFIGURED' : 'memory-fallback',
    socketio : 'ACTIVE',
    queue,
    time     : new Date().toISOString(),
  });
});

/* ── Global error handler ────────────────────────────────── */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const requestId = req.requestId || 'unknown';
  logger.error('Unhandled error', {
    requestId,
    message: err.message,
    path   : req.path,
    method : req.method,
  });

  // Erreurs Multer (uploads)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Fichier trop volumineux.', code: 'FILE_TOO_LARGE', requestId });
  }
  if (err.message && err.message.includes('Format non autorisé')) {
    return res.status(415).json({ error: err.message, code: 'UNSUPPORTED_MEDIA_TYPE', requestId });
  }
  // Erreurs body
  if (err.type === 'entity.too.large')   return res.status(413).json({ error: 'Payload too large.',  code: 'PAYLOAD_TOO_LARGE', requestId });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.',       code: 'INVALID_JSON',      requestId });
  // CORS
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({ error: err.message, code: 'CORS_ERROR', requestId });
  }

  return res.status(err.status || 500).json({
    error    : 'Internal server error.',
    code     : 'INTERNAL_ERROR',
    requestId,
    ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    error    : 'Route not found.',
    code     : 'NOT_FOUND',
    path     : req.path,
    requestId: req.requestId,
  });
});

/* ── Socket.IO ───────────────────────────────────────────── */
let io = null;
try {
  const { initSocketIO } = require('./services/socketService');
  io = initSocketIO(server);
  logger.info('[Socket.IO] Initialized successfully.');
} catch (err) {
  logger.error('[Socket.IO] Init failed — real-time disabled.', { error: err.message });
}

/* ── Workers BullMQ ──────────────────────────────────────── */
try {
  const { startWorker, setSocketIO } = require('./workers/transcriptionWorker');
  if (io) setSocketIO(io);
  startWorker();
  logger.info('[Worker] Transcription worker started.');
} catch (err) {
  logger.warn('[Worker] Could not start transcription worker.', { error: err.message });
}

/* ── Démarrage serveur ───────────────────────────────────── */
server.keepAliveTimeout = 65000;
server.headersTimeout   = 66000;

server.listen(PORT, '0.0.0.0', () => {
  const gpConfigured = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );
  const infobipOk  = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);
  const firebaseOk = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const redisOk    = !!process.env.REDIS_URL;

  logger.info('OmniSMS Backend v4.0 started', {
    port: PORT,
    env : process.env.NODE_ENV || 'development',
    node: process.version,
  });

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║       OmniSMS Backend v4.0 — Production             ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('🚀 Port       : ' + PORT);
  console.log('🌍 ENV        : ' + (process.env.NODE_ENV || 'development'));
  console.log('🔥 Firebase   : ' + (firebaseOk  ? '✅ configured' : '⚠️  MISSING — set FIREBASE_SERVICE_ACCOUNT_JSON'));
  console.log('🔑 JWT        : ' + (process.env.JWT_SECRET ? '✅ configured' : '❌ MISSING — set JWT_SECRET'));
  console.log('💰 GeniusPay  : ' + (gpConfigured ? '✅ ACTIVE'    : '⚠️  INACTIVE — set GENIUSPAY keys'));
  console.log('📡 Infobip    : ' + (infobipOk   ? '✅ ACTIVE'    : '⚠️  INACTIVE — set INFOBIP keys'));
  console.log('🗄️  Redis      : ' + (redisOk     ? '✅ configured' : '⚠️  INACTIVE — using memory fallback'));
  console.log('🔌 Socket.IO  : ' + (io          ? '✅ ACTIVE'    : '❌ INACTIVE'));
  console.log('🔒 Security   : Helmet · CORS · Rate-limit · HPP · Sanitize');
  console.log('🎙️  Audio      : POST /api/audio/upload  GET /api/audio/stream/:file');
  console.log('📇 Contacts   : POST /api/contacts/sync');
  console.log('💬 Messages   : POST /api/messages/send  GET /api/messages/conversation/:uid');
  console.log('❤️  Health     : GET /health');
  console.log('');
});

/* ── Graceful shutdown ───────────────────────────────────── */
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Signal ${signal} received — graceful shutdown…`);

  // Fermer Socket.IO proprement
  if (io) {
    io.close(() => logger.info('[Socket.IO] Closed.'));
  }

  server.close((err) => {
    if (err) {
      logger.error('Shutdown error', { error: err.message });
      process.exit(1);
    }
    logger.info('Server stopped cleanly.');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('Forced shutdown after 30s.');
    process.exit(1);
  }, 30000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

module.exports = app;
