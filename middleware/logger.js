'use strict';
/**
 * OmniSMS — Structured Logger
 *
 * Logger centralisé :
 * - Logs JSON structurés (faciles à parser par Render/Datadog/etc.)
 * - Niveaux : debug | info | warn | error
 * - request-id propagé automatiquement
 * - Masquage automatique des données sensibles
 * - Performance : durée de chaque requête
 */

const SENSITIVE_KEYS = new Set([
  'password', 'secret', 'token', 'authorization', 'x-admin-key',
  'x-api-key', 'private_key', 'api_key', 'apikey', 'credit_card',
  'firebase_service_account_json', 'fusion_pay_api_key',
]);

const LEVEL_PRIORITY = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVEL_PRIORITY[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'production' ? 1 : 0);

/** Masquer les valeurs sensibles dans un objet */
function sanitize(obj, depth = 0) {
  if (depth > 4 || !obj || typeof obj !== 'object') return obj;
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : sanitize(v, depth + 1);
  }
  return result;
}

/** Écrire un log JSON structuré */
function log(level, message, meta = {}) {
  if ((LEVEL_PRIORITY[level] ?? 0) < MIN_LEVEL) return;

  const entry = {
    ts   : new Date().toISOString(),
    level,
    msg  : message,
    env  : process.env.NODE_ENV || 'development',
    ...sanitize(meta),
  };

  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const logger = {
  debug : (msg, meta) => log('debug', msg, meta),
  info  : (msg, meta) => log('info',  msg, meta),
  warn  : (msg, meta) => log('warn',  msg, meta),
  error : (msg, meta) => log('error', msg, meta),
};

/**
 * Middleware Express — logue chaque requête HTTP.
 * Injecte req.requestId et req.log pour les handlers.
 */
function requestLogger(req, res, next) {
  const start     = Date.now();
  const requestId = req.headers['x-request-id']
                 || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  // Logger contextuel lié à cette requête
  req.log = {
    debug : (msg, m) => logger.debug(msg,  { requestId, ...m }),
    info  : (msg, m) => logger.info(msg,   { requestId, ...m }),
    warn  : (msg, m) => logger.warn(msg,   { requestId, ...m }),
    error : (msg, m) => logger.error(msg,  { requestId, ...m }),
  };

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level    = res.statusCode >= 500 ? 'error'
                   : res.statusCode >= 400 ? 'warn'
                   : 'info';

    log(level, 'HTTP', {
      requestId,
      method  : req.method,
      path    : req.path,
      status  : res.statusCode,
      duration: `${duration}ms`,
      ip      : req.ip,
      ua      : req.get('user-agent')?.slice(0, 80),
    });
  });

  next();
}

module.exports = { logger, requestLogger, sanitize };
