'use strict';
/**
 * OmniSMS — Service Queue (BullMQ)
 *
 * Queues disponibles :
 *  - transcription  : transcription audio Faster-Whisper
 *  - notifications  : push notifications
 *  - sms            : envoi SMS async
 *
 * Si REDIS_URL absent → dégradation gracieuse (jobs exécutés en sync inline).
 *
 * Usage :
 *   const { addTranscriptionJob } = require('./queueService');
 *   const job = await addTranscriptionJob({ audioPath, messageId, userId, language });
 */

const { logger } = require('../middleware/logger');

const REDIS_URL = process.env.REDIS_URL || null;

let Queue, Worker, QueueEvents;
let bullmqAvailable = false;

try {
  ({ Queue, Worker, QueueEvents } = require('bullmq'));
  bullmqAvailable = true;
} catch (_) {
  logger.warn('[Queue] BullMQ non disponible.');
}

/* ── Config Redis pour BullMQ ─────────────────────────────── */
/*
 * DEUX connexions séparées obligatoires pour BullMQ :
 *
 * 1. redisConnection  → Queue (ajout de jobs) : commandTimeout court OK
 * 2. workerConnection → Worker (processing)   : PAS de commandTimeout
 *
 * CAUSE ROOT BUG "Command timed out" :
 *   La connexion Worker utilisait commandTimeout: 5000ms.
 *   BullMQ Worker renouvelle le lock Redis pendant le processing
 *   (toutes les 15s = lockDuration/2 = 30000/2).
 *   Groq Whisper peut prendre 10-120s.
 *   → Les commandes EXTEND du lock dépassaient 5000ms → "Command timed out"
 *   → Le job échouait alors que Groq avait réussi ou était en cours.
 *
 * FIX : connexion Worker SANS commandTimeout, lockDuration augmenté à 120s.
 */
const QUEUE_MODE = String(process.env.QUEUE_MODE || 'auto').trim().toLowerCase(); // auto | inline
let redisConnection = null;   // pour Queue.add()
let workerConnection = null;  // pour Worker processing — PAS de commandTimeout

/* ── TLS (Upstash / Render externe exigent rediss://) ─────── */
function tlsOptsFor(url) {
  return (url.startsWith('rediss://') || url.includes('upstash')) ? { tls: {} } : {};
}

/* ── Limitation de fréquence des logs (anti-spam d'erreurs) ── */
const LOG_LIMIT_MS = 60 * 1000;
const _lastLogAt = new Map();
function logLimited(key, msg, meta) {
  const now = Date.now();
  const last = _lastLogAt.get(key) || 0;
  if (now - last < LOG_LIMIT_MS) return;
  _lastLogAt.set(key, now);
  logger.warn(msg, meta || {});
}

/* ── Détection « quota épuisé » (Upstash : ERR max requests limit exceeded) ── */
function detectQuotaExhausted(err) {
  const m = String((err && err.message) || err || '');
  return /max requests limit exceeded|requests limit exceeded|max_requests|quota/i.test(m);
}

let quotaExhausted = false;       // true = mode dégradé inline, plus aucune commande Redis
let recoveryTimer = null;         // sonde périodique (1 commande / intervalle)
const workerSpecs = {};           // queueName -> {processor, concurrency, workerOptions} (reprise)

/**
 * QUOTA ÉPUISÉ — dégradation contrôlée :
 * 1. arrêt propre des workers (plus de boucle BZPOPMIN/erreurs par seconde) ;
 * 2. déconnexion des clients Redis (plus aucune commande consommée) ;
 * 3. les futurs jobs passent en exécution INLINE (le SMS part quand même) ;
 * 4. sonde de rétablissement (QUEUE_AUTO_RECOVER, 1 PING par intervalle).
 * Aucun job n'est prétendu réussi : getQueueStatus() le reflète (/health).
 */
function shutdownForQuota(reason) {
  if (quotaExhausted) return;
  quotaExhausted = true;
  logger.error('[Queue] ⛔ QUOTA REDIS ÉPUISÉ — dégradation contrôlée : workers arrêtés, exécution inline. Détail', {
    reason: String(reason).slice(0, 200),
    recover: String(process.env.QUEUE_AUTO_RECOVER || 'true') !== 'false' ? 'probe active' : 'QUEUE_AUTO_RECOVER=false',
  });
  for (const name of Object.keys(workers)) {
    try { const w = workers[name]; w.close ? w.close().catch(() => {}) : null; } catch (_) {}
    delete workers[name];
  }
  for (const name of Object.keys(queues)) { try { queues[name].close().catch(() => {}); } catch (_) {} delete queues[name]; }
  try { redisConnection && redisConnection.disconnect(false); } catch (_) {}
  try { workerConnection && workerConnection.disconnect(false); } catch (_) {}
  redisConnection = null;
  workerConnection = null;
  scheduleRecoveryProbe();
}

/** Sonde de rétablissement : 1 PING / QUEUE_PROBE_INTERVAL_MS (défaut 10 min). */
function scheduleRecoveryProbe() {
  if (recoveryTimer || String(process.env.QUEUE_AUTO_RECOVER || 'true') === 'false') return;
  // Plancher 60 s en production (coût sonde ≤ ~4.3k cmd/mois) ;
  // QUEUE_PROBE_MIN_MS permet aux tests de descendre dessous.
  const minEvery = parseInt(process.env.QUEUE_PROBE_MIN_MS || '60000', 10) || 60000;
  const every = Math.max(minEvery, parseInt(process.env.QUEUE_PROBE_INTERVAL_MS || '600000', 10) || 600000);
  recoveryTimer = setInterval(async () => {
    let probe = null;
    try {
      const Redis = require('ioredis');
      probe = new Redis(REDIS_URL, {
        lazyConnect: true, connectTimeout: 5000, commandTimeout: 4000,
        maxRetriesPerRequest: 1, retryStrategy: () => null, enableOfflineQueue: false,
        ...tlsOptsFor(REDIS_URL),
      });
      probe.on('error', () => {}); // silencieux : la sonde gère ses propres échecs
      const pong = await probe.ping();
      try { probe.disconnect(); } catch (_) {}
      if (pong === 'PONG') {
        clearInterval(recoveryTimer);
        recoveryTimer = null;
        quotaExhausted = false;
        logger.warn('[Queue] ✅ Redis répond à nouveau (PING OK) — reconnexion des files.');
        try {
          initRedisConnections();
          for (const [name, spec] of Object.entries(workerSpecs)) {
            createWorker(name, spec.processor, spec.concurrency, spec.workerOptions);
          }
        } catch (e) {
          quotaExhausted = true;
          logLimited('recover-fail', '[Queue] Reconnexion après quota échouée — nouvelle sonde.', { error: e.message });
          scheduleRecoveryProbe();
        }
      }
    } catch (_) {
      try { probe && probe.disconnect(); } catch (_) {}
      logLimited('probe-fail', '[Queue] Sonde rétablissement : Redis toujours indisponible (quota/DNS).');
    }
  }, every);
  if (recoveryTimer.unref) recoveryTimer.unref();
}

/**
 * Création des DEUX connexions BullMQ (queue + worker). Appelée au boot puis
 * par la sonde de rétablissement. Toute erreur de quota → shutdownForQuota.
 */
function initRedisConnections() {
  const Redis = require('ioredis');

  // Connexion Queue (add de jobs) — commandTimeout court acceptable.
  const queueConn = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
    connectTimeout: 8000,
    commandTimeout: 5000,
    // Ne tourne PAS en boucle de reconnexion : 2 essais puis stop.
    // (Chaque tentative consommerait des requêtes facturées pour rien.)
    retryStrategy(times) { return times >= 2 ? null : Math.min(times * 1000, 2000); },
    ...tlsOptsFor(REDIS_URL),
  });
  queueConn.on('error', (err) => {
    if (detectQuotaExhausted(err)) return shutdownForQuota(err.message);
    const isFatal = ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT'].includes(err.code);
    if (isFatal) {
      logLimited('queue-net-' + err.code, `[Queue] Redis réseau ${err.code} — bascule en exécution inline.`);
      redisConnection = null;
      workerConnection = null;
      try { queueConn.disconnect(false); } catch (_) {}
    } else {
      logLimited('queue-err', '[Queue] Redis queue connection error', { msg: err.message });
    }
  });
  queueConn.on('end', () => logLimited('queue-end', '[Queue] Connexion Redis queue fermée.'));

  // Connexion Worker (processing) — SANS commandTimeout (locks BullMQ pendant
  // les longs jobs Groq 10-120 s). Coût au repos : ~1 BZPOPMIN / 5 s par worker
  // (drainDelay BullMQ) — voir docs/REDIS_QUOTA.md pour le budget commandes.
  const wConn = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
    connectTimeout: 10000,
    retryStrategy(times) { return times >= 3 ? null : Math.min(times * 2000, 5000); },
    ...tlsOptsFor(REDIS_URL),
  });
  wConn.on('error', (err) => {
    if (detectQuotaExhausted(err)) return shutdownForQuota(err.message);
    logLimited('worker-conn-err', '[Queue] Redis worker connection error', { msg: err.message, code: err.code });
  });

  redisConnection = queueConn;
  workerConnection = wConn;
  logger.info('[Queue] BullMQ connecté à Redis (queue + worker).', { mode: QUEUE_MODE });
}

if (bullmqAvailable && REDIS_URL && QUEUE_MODE !== 'inline') {
  try { initRedisConnections(); }
  catch (err) {
    logger.error('[Queue] Connexion Redis échouée au boot', { error: err.message });
    redisConnection = null;
    workerConnection = null;
  }
} else if (QUEUE_MODE === 'inline') {
  logger.warn('[Queue] QUEUE_MODE=inline — Redis volontairement désactivé (0 commande, jobs inline).');
}

/* ── Fallback : exécution inline (sans Redis) ─────────────── */
const INLINE_HANDLERS = {};

function registerInlineHandler(queueName, handler) {
  INLINE_HANDLERS[queueName] = handler;
}

/* ── Factory Queue ────────────────────────────────────────── */
const queues   = {};
const workers  = {};

function getQueue(name, opts = {}) {
  if (!bullmqAvailable || !redisConnection) return null;

  if (!queues[name]) {
    queues[name] = new Queue(name, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts  : 3,
        backoff   : { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail    : { count: 50 },
        ...opts,
      },
    });
    logger.info(`[Queue] Queue "${name}" created.`);
  }
  return queues[name];
}

/**
 * Ajouter un job dans une queue.
 * Si Redis absent → exécute le handler inline (dégradation gracieuse).
 *
 * @param {string}  queueName  - Nom de la queue
 * @param {object}  data       - Données du job
 * @param {object}  [opts]     - Options BullMQ (priority, delay, etc.)
 * @returns {Promise<object>}  - Job BullMQ ou résultat inline
 */
async function addJob(queueName, data, opts = {}) {
  const q = getQueue(queueName);

  if (q) {
    try {
      const job = await q.add(queueName, data, opts);
      logger.info(`[Queue] Job added to "${queueName}"`, { jobId: job.id });
      return { jobId: job.id, queued: true };
    } catch (err) {
      const quota = detectQuotaExhausted(err);
      if (quota) shutdownForQuota(err.message);
      const handler = INLINE_HANDLERS[queueName];
      if (handler) {
        // Dégradation contrôlée : exécution immédiate inline (le SMS part
        // quand même) — résultat marqué queued:false, jamais un faux succès.
        logLimited('inline-degrade', `[Queue] "${queueName}" indisponible (${quota ? 'quota' : err.message.slice(0, 80)}) — exécution inline.`);
        try {
          const result = await handler({ data });
          return { jobId: `inline-${Date.now()}`, queued: false, inline: true, result };
        } catch (e2) {
          logger.error(`[Queue] Job inline échoué pour "${queueName}"`, { error: e2.message });
          throw e2;
        }
      }
      logger.error(`[Queue] Job NON ajouté (pas de handler inline) pour "${queueName}"`, { error: err.message });
      return { jobId: null, queued: false, error: err.message };
    }
  }

  // Mode inline — exécuter directement (dégradation maîtrisée)
  const handler = INLINE_HANDLERS[queueName];
  if (handler) {
    logger.info(`[Queue] Inline execution for "${queueName}" (no Redis).`);
    try {
      const result = await handler({ data });
      return { jobId: `inline-${Date.now()}`, queued: false, inline: true, result };
    } catch (err) {
      logger.error(`[Queue] Inline job failed for "${queueName}"`, { error: err.message });
      throw err;
    }
  }

  logger.warn(`[Queue] No queue or handler for "${queueName}" — job NON exécuté.`);
  return { jobId: null, queued: false, inline: false, error: quotaExhausted ? 'redis-quota-exhausted' : 'no-queue-no-handler' };
}

/**
 * Créer un worker pour une queue.
 *
 * Utilise workerConnection (sans commandTimeout) pour éviter les timeouts
 * pendant les longs jobs de transcription (Groq peut prendre 10-120s).
 * lockDuration: 120000ms — le lock est renouvelé toutes les 60s, ce qui
 * laisse largement le temps à Groq de répondre.
 */
function createWorker(queueName, processor, concurrency = 2, workerOptions = {}) {
  // Mémoriser la spec pour la reprise post-quota (re-création par la sonde).
  workerSpecs[queueName] = { processor, concurrency, workerOptions };
  // Utiliser workerConnection en priorité (sans commandTimeout)
  // Si absent (quota épuisé / inline / pas de Redis), exécution INLINE.
  const conn = quotaExhausted ? null : (workerConnection || redisConnection);

  if (!bullmqAvailable || !conn) {
    // Enregistrer comme handler inline
    registerInlineHandler(queueName, processor);
    logger.info(`[Queue] Worker "${queueName}" registered as inline handler.`);
    return null;
  }

  if (workers[queueName]) return workers[queueName];

  const worker = new Worker(queueName, processor, {
    connection  : conn,
    concurrency,
    lockDuration: 120000,   // 120s — renouvellement toutes les 60s
    // Vérification « stalled » : 1 script/30s/worker par défaut = ~86k cmd/mois
    // → désactivable (QUEUE_SKIP_STALLED_CHECK, défaut true) pour économiser
    // le quota ; l'arbitrage des jobs bloqués repose alors sur les retries BullMQ.
    skipStalledCheck: String(process.env.QUEUE_SKIP_STALLED_CHECK ?? 'true') !== 'false',
    // stalledInterval: 30000 (default) — vérification jobs bloqués toutes les 30s
    // maxStalledCount: 1 (default) — 1 retry si stalled, puis échec
    // Backoff avec jitter (anti-tempête) + limiteur de débit optionnel
    settings: workerOptions.backoffStrategy
      ? { backoffStrategy: workerOptions.backoffStrategy }
      : undefined,
    limiter: workerOptions.limiter || undefined,
  });

  worker.on('completed', (job, result) => {
    logger.info(`[Queue] Job completed in "${queueName}"`, { jobId: job.id, result });
  });

  worker.on('failed', (job, err) => {
    logger.error(`[Queue] Job failed in "${queueName}"`, {
      jobId: job?.id,
      error: err.message,
    });
  });

  worker.on('error', (err) => {
    if (detectQuotaExhausted(err)) return shutdownForQuota(err.message);
    logLimited('worker-' + queueName, `[Queue] Worker error in "${queueName}"`, { error: err.message });
  });

  workers[queueName] = worker;
  logger.info(`[Queue] Worker "${queueName}" started (concurrency: ${concurrency}).`);
  return worker;
}

/* ── API publique simplifiée ──────────────────────────────── */

/**
 * Ajouter un job de transcription audio.
 */
async function addTranscriptionJob(data) {
  return addJob('transcription', data, {
    priority: data.priority || 1,
    attempts: 2,
    backoff : { type: 'fixed', delay: 5000 },
  });
}

/**
 * Ajouter un job SMS async.
 *
 * SESSION 13 : les options passées par l'appelant sont désormais transmises.
 * enqueueSmsJob() fournit `jobId: sms-{messageId}` (déduplication BullMQ :
 * un même message ne crée qu'un seul job) — cette option était ignorée.
 * Valeurs par défaut inchangées (attempts 3, backoff exponentiel 3 s).
 */
async function addSmsJob(data, opts = {}) {
  return addJob('sms', data, {
    attempts: 3,
    backoff : { type: 'exponential', delay: 3000 },
    ...(opts || {}),
  });
}

/**
 * Statut de la queue service.
 */
function getQueueStatus() {
  return {
    redisConnected : !!(redisConnection),
    workerConnected: !!(workerConnection),
    bullmqAvailable,
    queues         : Object.keys(queues),
    workers        : Object.keys(workers),
    mode           : quotaExhausted ? 'inline-quota'
                   : QUEUE_MODE === 'inline' ? 'inline-forced'
                   : redisConnection ? 'redis' : 'inline-fallback',
    quotaExhausted,
    skipStalledCheck: String(process.env.QUEUE_SKIP_STALLED_CHECK ?? 'true') !== 'false',
    autoRecover    : String(process.env.QUEUE_AUTO_RECOVER || 'true') !== 'false',
    lockDuration   : 120000,
  };
}

/**
 * Arrêt propre (SIGTERM / tests) : ferme workers + connexions, sans re-init.
 */
async function shutdownQueues() {
  for (const name of Object.keys(workers)) {
    try { await workers[name].close(); } catch (_) {}
    delete workers[name];
  }
  for (const name of Object.keys(queues)) { try { await queues[name].close(); } catch (_) {} delete queues[name]; }
  try { redisConnection && redisConnection.quit(); } catch (_) { try { redisConnection && redisConnection.disconnect(); } catch (_) {} }
  try { workerConnection && workerConnection.quit(); } catch (_) { try { workerConnection && workerConnection.disconnect(); } catch (_) {} }
  redisConnection = null;
  workerConnection = null;
  if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; }
}

/** Test uniquement — réinitialise l'état interne (interdit en production). */
function _quotaTestReset() {
  if (process.env.NODE_ENV === 'production') throw new Error('interdit en production');
  quotaExhausted = false;
  if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; }
  for (const k of Object.keys(workerSpecs)) delete workerSpecs[k];
  for (const k of Object.keys(_lastLogAt)) delete _lastLogAt[k];
}

module.exports = {
  addJob,
  addTranscriptionJob,
  addSmsJob,
  createWorker,
  getQueue,
  getQueueStatus,
  registerInlineHandler,
  shutdownQueues,
  _quotaTestReset,
};
