'use strict';
/**
 * OmniSMS Backend — v2.5
 * Production-ready · Express 4 · Firebase graceful · Infobip SMS
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
  paymentConfirmLimiter,
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

app.options(/.*/, corsMiddleware);

app.use(requestLogger);

app.use(express.json({
  limit : '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(hppMiddleware);

app.use(inputSanitizer);

app.use(globalSlowDown);
app.use(globalLimiter);

/* ── Safe query helper ───────────────────────────────────── */
function q(req, key) {
  const cq = req.cleanedQuery || {};
  return cq[key] !== undefined ? cq[key] : (req.query || {})[key];
}

/* ── Health & status routes (highest priority) ───────────── */

app.get('/', (_req, res) => {
  const gpConfigured = !!((process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET));

  let smsProvider = 'none';
  try { smsProvider = require('./services/smsProvider').getProviderStatus().activeProvider; } catch (_) {}

  const infobipConfigured = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);

  res.status(200).json({
    status      : 'ok',
    service     : 'OmniSMS Backend',
    version     : '2.5.0',
    auth        : true,
    payments    : gpConfigured,
    sms         : smsProvider !== 'none' || infobipConfigured,
    geniuspay   : gpConfigured ? 'ACTIVE' : 'INACTIVE',
    infobip     : infobipConfigured ? 'ACTIVE' : 'INACTIVE',
    smsProvider,
    env         : process.env.NODE_ENV || 'development',
    time        : new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  const gpConfigured    = !!((process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET));
  const firebaseOk      = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const jwtOk           = !!process.env.JWT_SECRET;
  const infobipOk       = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);

  let smsStatus = { activeProvider: 'none', twilio: {}, africastalking: {}, orange: {} };
  try { smsStatus = require('./services/smsProvider').getProviderStatus(); } catch (_) {}

  res.status(200).json({
    status  : 'ok',
    service : 'OmniSMS Backend',
    version : '2.5.0',
    uptime  : Math.round(process.uptime()),
    time    : new Date().toISOString(),
    checks  : {
      firebase  : firebaseOk  ? 'ok' : 'MISSING — set FIREBASE_SERVICE_ACCOUNT_JSON in Render env',
      jwt       : jwtOk       ? 'ok' : 'MISSING — set JWT_SECRET',
      geniuspay : gpConfigured ? 'ACTIVE' : 'INACTIVE — set GENIUSPAY_PUBLIC_KEY + GENIUSPAY_SECRET_KEY',
      infobip   : infobipOk   ? 'ACTIVE' : 'INACTIVE — set INFOBIP_API_KEY + INFOBIP_BASE_URL',
      sms       : {
        activeProvider: smsStatus.activeProvider,
        infobip       : infobipOk ? 'configured' : 'not configured',
        twilio        : smsStatus.twilio?.configured         ? 'configured' : 'not configured',
        africastalking: smsStatus.africastalking?.configured ? 'configured' : 'not configured',
        orange        : smsStatus.orange?.configured         ? 'configured' : 'not configured',
      },
    },
    routes  : {
      auth    : ['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/google', 'GET /api/auth/me'],
      payment : ['POST /api/payment/geniuspay', 'POST /api/payment/webhook', 'GET /api/user/status'],
      sms     : ['POST /sms/incoming', 'POST /sms/hybrid/incoming', 'POST /api/sms/send', 'POST /webhooks/infobip'],
      health  : ['GET /', 'GET /health', 'GET /api/status'],
    },
  });
});

/* ── Route imports ───────────────────────────────────────── */
const authRoutes          = require('./routes/auth');
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
const infobipRoutes       = require('./routes/sms.infobip');

function loadOptional(routePath, mount) {
  try {
    const mod = require(routePath);
    app.use(mount, mod);
    logger.info('Optional route loaded: ' + mount);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
      logger.warn('Optional route error (' + mount + ')', { error: e.message });
    }
  }
}

/* ── Auth routes EN PREMIER ──────────────────────────────── */
app.use('/api/auth', authLimiter, requireJson, authRoutes);
app.use('/auth',     authLimiter, requireJson, authRoutes);

/* ── Payment — Fusion Pay API ────────────────────────────── */
app.use('/api/payment', paymentFusionRoutes);

/* ── Payment — GeniusPay (primary) ──────────────────────── */
app.use('/api/payment', geniusPayLimiter, paymentRoutes);
app.use('/api/payment', webhookRoutes);
app.use('/api/payment/geniuspay', geniusPayLimiter, geniusPayRoutes);
app.use('/api/payment', geniusPayRoutes);

/* ── SMS — Infobip ───────────────────────────────────────── */
app.use('/', infobipRoutes);

/* ── SMS — Hybrid (alias flow) ───────────────────────────── */
app.use('/sms/hybrid', smsHybridRoutes);

/* ── SMS — Webhooks ──────────────────────────────────────── */
app.use('/sms', smsWebhookRoutes);

app.post('/webhooks/africastalking', (req, res, next) => {
  req.url = '/incoming';
  smsWebhookRoutes(req, res, next);
});

app.post('/webhooks/twilio', express.urlencoded({ extended: false }), (req, res, next) => {
  req.url = '/incoming';
  smsWebhookRoutes(req, res, next);
});

/* ── Admin ───────────────────────────────────────────────── */
app.use('/admin', adminRoutes);

/* ── Other feature routes ────────────────────────────────── */
app.use('/messages',      messageRoutes);
app.use('/groups',        groupRoutes);
app.use('/users',         userRoutes);
app.use('/me',            meRoutes);
app.use('/notifications', notifRoutes);
app.use('/statistics',    statsRoutes);
app.use('/',              contactRoutes);

loadOptional('./routes/audio',         '/audio');
loadOptional('./routes/ads',           '/ads');
loadOptional('./routes/companies',     '/companies');
loadOptional('./routes/credits',       '/credits');
loadOptional('./routes/smsCost',       '/sms-cost');
loadOptional('./routes/transcription', '/transcription');
loadOptional('./routes/subscriptions', '/subscriptions');
loadOptional('./routes/payment.online','/payment-online');
loadOptional('./routes/payments.start','/payments-start');
loadOptional('./routes/offline.payment','/offline-payment');

/* ── Premium user status ─────────────────────────────────── */
const { getUserStatus } = require('./controllers/paymentController');
app.get('/api/user/status', (req, res) => getUserStatus(req, res));

/* ── API status ──────────────────────────────────────────── */
app.get('/api/status', (_req, res) => {
  const gpConfigured = !!((process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET));
  const infobipOk    = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);

  let smsStatus = { activeProvider: 'none' };
  try { smsStatus = require('./services/smsProvider').getProviderStatus(); } catch (_) {}

  res.json({
    status   : 'OmniSMS Backend v2.5 running',
    port     : PORT,
    env      : process.env.NODE_ENV || 'development',
    geniuspay: gpConfigured ? 'ACTIVE' : 'INACTIVE',
    infobip  : infobipOk    ? 'ACTIVE' : 'INACTIVE',
    sms      : smsStatus.activeProvider !== 'none' ? 'ACTIVE (' + smsStatus.activeProvider + ')' : (infobipOk ? 'ACTIVE (infobip)' : 'INACTIVE'),
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
  const gpConfigured = !!((process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY) &&
    (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET));
  const infobipOk    = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);
  const firebaseOk   = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  let smsName = 'none';
  try {
    const sp = require('./services/smsProvider').getProviderStatus();
    smsName = sp.activeProvider !== 'none' ? sp.activeProvider : 'none';
  } catch (_) {}

  logger.info('OmniSMS Backend started', { port: PORT, env: process.env.NODE_ENV || 'development', node: process.version });

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       OmniSMS Backend v2.5 — Production         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('🚀 Port      : ' + PORT);
  console.log('🌍 ENV       : ' + (process.env.NODE_ENV || 'development'));
  console.log('🔥 Firebase  : ' + (firebaseOk ? '✅ configured' : '⚠️  FIREBASE_SERVICE_ACCOUNT_JSON missing'));
  console.log('🔑 JWT       : ' + (process.env.JWT_SECRET ? '✅ configured' : '❌ JWT_SECRET missing'));
  console.log('💰 GeniusPay : ' + (gpConfigured ? '✅ ACTIVE' : '⚠️  INACTIVE'));
  console.log('📡 Infobip   : ' + (infobipOk    ? '✅ ACTIVE' : '⚠️  INACTIVE'));
  console.log('📱 SMS       : ' + (smsName !== 'none' ? '✅ ACTIVE (' + smsName + ')' : '⚠️  INACTIVE'));
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
