'use strict';
/**
 * OmniSMS Backend — v3.0
 * Production-ready · Express · Firebase graceful degradation
 * Payments : GeniusPay only
 * SMS      : Infobip only
 */

require('dotenv').config({ path: process.env.NODE_ENV === 'production' ? '/etc/secrets/.env' : '.env' });

const express = require('express');
const http    = require('http');

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

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 5000;

app.set('trust proxy', 1);

/* ── Global middleware stack ─────────────────────────────── */
app.use(compressionMiddleware);
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.options(/.*/, corsMiddleware);   // Preflight OPTIONS (regex — works in Express 4 & 5)
app.use(requestLogger);
app.use(express.json({
  limit : '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(hppMiddleware);
app.use(inputSanitizer);   // writes req.cleanedQuery — never mutates req.query
app.use(globalSlowDown);
app.use(globalLimiter);

/* ── Health & status ─────────────────────────────────────── */

app.get('/', (_req, res) => {
  const gpConfigured  = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );
  const infobipOk     = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);

  res.status(200).json({
    status   : 'ok',
    service  : 'OmniSMS Backend',
    version  : '3.0.0',
    auth     : true,
    payments : gpConfigured,
    sms      : infobipOk,
    geniuspay: gpConfigured ? 'ACTIVE' : 'INACTIVE',
    infobip  : infobipOk    ? 'ACTIVE' : 'INACTIVE',
    env      : process.env.NODE_ENV || 'development',
    time     : new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  const gpConfigured  = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );
  const firebaseOk    = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const jwtOk         = !!process.env.JWT_SECRET;
  const infobipOk     = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);

  res.status(200).json({
    status  : 'ok',
    service : 'OmniSMS Backend',
    version : '3.0.0',
    uptime  : Math.round(process.uptime()),
    time    : new Date().toISOString(),
    checks  : {
      firebase : firebaseOk  ? 'ok' : 'MISSING — set FIREBASE_SERVICE_ACCOUNT_JSON in Render env',
      jwt      : jwtOk       ? 'ok' : 'MISSING — set JWT_SECRET',
      geniuspay: gpConfigured ? 'ACTIVE' : 'INACTIVE — set GENIUSPAY_PUBLIC_KEY + GENIUSPAY_SECRET_KEY',
      infobip  : infobipOk   ? 'ACTIVE' : 'INACTIVE — set INFOBIP_API_KEY + INFOBIP_BASE_URL',
    },
    routes  : {
      auth    : ['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/google', 'GET /api/auth/me'],
      payment : ['POST /api/payment/geniuspay', 'POST /api/payment/webhook', 'POST /api/payment/geniuspay/create', 'POST /api/payment/geniuspay/webhook', 'GET /api/payment/geniuspay/status/:id', 'GET /api/user/status'],
      sms     : ['POST /api/sms/send', 'POST /webhooks/infobip', 'GET /api/sms/infobip/status'],
      health  : ['GET /', 'GET /health', 'GET /api/status'],
    },
  });
});

/* ── Route imports ───────────────────────────────────────── */
const authRoutes      = require('./routes/auth');
const geniusPayRoutes = require('./routes/payment.geniuspay');
const paymentRoutes   = require('./routes/payment');
const webhookRoutes   = require('./routes/webhook');
const infobipRoutes   = require('./routes/sms.infobip');
const adminRoutes     = require('./routes/admin');
const messageRoutes   = require('./routes/messages');
const groupRoutes     = require('./routes/groups');
const userRoutes      = require('./routes/users');
const meRoutes        = require('./routes/me');
const notifRoutes     = require('./routes/notifications');
const statsRoutes     = require('./routes/statistics');
const contactRoutes   = require('./routes/contacts');

function loadOptional(routePath, mount) {
  try {
    const mod = require(routePath);
    app.use(mount, mod);
    logger.info('Optional route loaded: ' + mount);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
      logger.warn('Optional route error (' + mount + '): ' + e.message);
    }
  }
}

/* ── Auth ────────────────────────────────────────────────── */
app.use('/api/auth', authLimiter, requireJson, authRoutes);
app.use('/auth',     authLimiter, requireJson, authRoutes);   // retrocompat alias

/* ── GeniusPay payments ──────────────────────────────────── */
app.use('/api/payment', geniusPayLimiter, paymentRoutes);          // POST /api/payment/geniuspay
app.use('/api/payment', webhookRoutes);                             // POST /api/payment/webhook
app.use('/api/payment/geniuspay', geniusPayLimiter, geniusPayRoutes); // /create /webhook /status/:id /link /return /config
app.use('/api/payment', geniusPayRoutes);                           // /link (alias at /api/payment/link)

/* ── Infobip SMS ─────────────────────────────────────────── */
app.use('/', infobipRoutes);   // POST /api/sms/send  POST /webhooks/infobip  GET /api/sms/infobip/status

/* ── Premium user status ─────────────────────────────────── */
const { getUserStatus } = require('./controllers/paymentController');
app.get('/api/user/status', (req, res) => getUserStatus(req, res));

/* ── Admin & feature routes ──────────────────────────────── */
app.use('/admin',        adminRoutes);
app.use('/messages',     messageRoutes);
app.use('/groups',       groupRoutes);
app.use('/users',        userRoutes);
app.use('/me',           meRoutes);
app.use('/notifications',notifRoutes);
app.use('/statistics',   statsRoutes);
app.use('/',             contactRoutes);

loadOptional('./routes/audio',         '/audio');
loadOptional('./routes/ads',           '/ads');
loadOptional('./routes/companies',     '/companies');
loadOptional('./routes/credits',       '/credits');
loadOptional('./routes/smsCost',       '/sms-cost');
loadOptional('./routes/transcription', '/transcription');
loadOptional('./routes/subscriptions', '/subscriptions');
loadOptional('./routes/sms.hybrid',    '/sms/hybrid');

/* ── API status ──────────────────────────────────────────── */
app.get('/api/status', (_req, res) => {
  const gpConfigured = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );
  const infobipOk    = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);

  res.json({
    status   : 'OmniSMS Backend v3.0 running',
    port     : PORT,
    env      : process.env.NODE_ENV || 'development',
    geniuspay: gpConfigured ? 'ACTIVE' : 'INACTIVE',
    infobip  : infobipOk    ? 'ACTIVE' : 'INACTIVE',
    sms      : infobipOk    ? 'ACTIVE (infobip)' : 'INACTIVE',
    time     : new Date().toISOString(),
  });
});

/* ── Global error handler ────────────────────────────────── */
app.use((err, req, res, next) => {
  const requestId = req.requestId || 'unknown';
  logger.error('Unhandled error', { requestId, message: err.message, path: req.path, method: req.method });

  if (err.type === 'entity.too.large')    return res.status(413).json({ error: 'Payload too large.',  code: 'PAYLOAD_TOO_LARGE', requestId });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.',       code: 'INVALID_JSON',      requestId });

  return res.status(err.status || 500).json({
    error    : 'Internal server error.',
    code     : 'INTERNAL_ERROR',
    requestId,
    ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.', code: 'NOT_FOUND', path: req.path, requestId: req.requestId });
});

/* ── Server startup ──────────────────────────────────────── */
const server = http.createServer(app);
server.keepAliveTimeout = 65000;
server.headersTimeout   = 66000;

server.listen(PORT, '0.0.0.0', () => {
  const gpConfigured = !!(
    (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET)
  );
  const infobipOk    = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);
  const firebaseOk   = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  logger.info('OmniSMS Backend started', { port: PORT, env: process.env.NODE_ENV || 'development', node: process.version });

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       OmniSMS Backend v3.0 — Production         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('🚀 Port      : ' + PORT);
  console.log('🌍 ENV       : ' + (process.env.NODE_ENV || 'development'));
  console.log('🔥 Firebase  : ' + (firebaseOk  ? '✅ configured' : '⚠️  MISSING — set FIREBASE_SERVICE_ACCOUNT_JSON'));
  console.log('🔑 JWT       : ' + (process.env.JWT_SECRET ? '✅ configured' : '❌ MISSING — set JWT_SECRET'));
  console.log('💰 GeniusPay : ' + (gpConfigured ? '✅ ACTIVE'    : '⚠️  INACTIVE — set GENIUSPAY_PUBLIC_KEY + GENIUSPAY_SECRET_KEY'));
  console.log('📡 Infobip   : ' + (infobipOk   ? '✅ ACTIVE'    : '⚠️  INACTIVE — set INFOBIP_API_KEY + INFOBIP_BASE_URL'));
  console.log('🔒 Security  : Helmet · CORS · Rate-limit · HPP · Sanitize');
  console.log('❤️  Health    : GET /health');
  console.log('📊 Status    : GET /');
  console.log('');
});

/* ── Graceful shutdown ───────────────────────────────────── */
let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('Signal ' + signal + ' received — graceful shutdown…');
  server.close((err) => {
    if (err) { logger.error('Shutdown error', { error: err.message }); process.exit(1); }
    logger.info('Server stopped cleanly.');
    process.exit(0);
  });
  setTimeout(() => { logger.warn('Forced shutdown after 30s.'); process.exit(1); }, 30000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — exiting', { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

module.exports = app;
