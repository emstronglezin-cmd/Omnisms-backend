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
let redisConnection = null;   // pour Queue.add()
let workerConnection = null;  // pour Worker processing — PAS de commandTimeout

if (bullmqAvailable && REDIS_URL) {
  try {
    const Redis = require('ioredis');
    let _queueFallback = false;

    // ── Options TLS communes ─────────────────────────────────
    const tlsOpts = (REDIS_URL.startsWith('rediss://') || REDIS_URL.includes('upstash'))
      ? { tls: {} }
      : {};

    // ── Connexion Queue (pour ajouter des jobs) ──────────────
    // commandTimeout court acceptable — les add() ne durent pas longtemps
    const queueOpts = {
      maxRetriesPerRequest: null,
      enableReadyCheck    : false,
      lazyConnect         : false,
      connectTimeout      : 8000,
      commandTimeout      : 5000,   // court OK pour Queue.add()
      retryStrategy(times) {
        if (_queueFallback) return null;
        if (times >= 2) return null;
        return Math.min(times * 1000, 2000);
      },
      ...tlsOpts,
    };
    const queueConn = new Redis(REDIS_URL, queueOpts);

    queueConn.on('error', (err) => {
      if (_queueFallback) return;
      const isFatal = (
        err.code === 'ENOTFOUND' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'EAI_AGAIN' ||
        err.code === 'ETIMEDOUT'
      );
      if (isFatal) {
        _queueFallback = true;
        logger.warn(`[Queue] Redis DNS/network error (${err.code}) — switching to inline execution.`);
        redisConnection = null;
        workerConnection = null;
        try { queueConn.disconnect(false); } catch (_) {}
      } else {
        logger.error('[Queue] Redis queue connection error', { msg: err.message });
      }
    });

    queueConn.on('end', () => {
      if (!_queueFallback) {
        logger.warn('[Queue] Redis queue connection closed — switching to inline execution.');
        _queueFallback = true;
        redisConnection = null;
        workerConnection = null;
      }
    });

    // ── Connexion Worker (pour processing) ───────────────────
    // CRITIQUE : PAS de commandTimeout — les commandes BZPOPMIN (blocking 10s)
    // et EXTEND (lock renewal pendant Groq 10-120s) ne doivent PAS expirer.
    const workerOpts = {
      maxRetriesPerRequest: null,   // requis BullMQ
      enableReadyCheck    : false,
      lazyConnect         : false,
      connectTimeout      : 10000,
      // commandTimeout INTENTIONNELLEMENT ABSENT — c'est le fix du bug
      retryStrategy(times) {
        if (_queueFallback) return null;
        if (times >= 3) return null;
        return Math.min(times * 2000, 5000);
      },
      ...tlsOpts,
    };
    const wConn = new Redis(REDIS_URL, workerOpts);

    wConn.on('error', (err) => {
      logger.error('[Queue] Redis worker connection error', { msg: err.message, code: err.code });
    });

    redisConnection = queueConn;
    workerConnection = wConn;
    logger.info('[Queue] BullMQ connected to Redis (queue + worker connections).');
  } catch (err) {
    logger.error('[Queue] Redis connection failed', { error: err.message });
    redisConnection = null;
    workerConnection = null;
  }
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
    const job = await q.add(queueName, data, opts);
    logger.info(`[Queue] Job added to "${queueName}"`, { jobId: job.id });
    return { jobId: job.id, queued: true };
  }

  // Mode inline — exécuter directement
  const handler = INLINE_HANDLERS[queueName];
  if (handler) {
    logger.info(`[Queue] Inline execution for "${queueName}" (no Redis).`);
    try {
      const result = await handler({ data });
      return { jobId: `inline-${Date.now()}`, queued: false, result };
    } catch (err) {
      logger.error(`[Queue] Inline job failed for "${queueName}"`, { error: err.message });
      throw err;
    }
  }

  logger.warn(`[Queue] No queue or handler for "${queueName}" — job dropped.`);
  return { jobId: null, queued: false };
}

/**
 * Créer un worker pour une queue.
 *
 * Utilise workerConnection (sans commandTimeout) pour éviter les timeouts
 * pendant les longs jobs de transcription (Groq peut prendre 10-120s).
 * lockDuration: 120000ms — le lock est renouvelé toutes les 60s, ce qui
 * laisse largement le temps à Groq de répondre.
 */
function createWorker(queueName, processor, concurrency = 2) {
  // Utiliser workerConnection en priorité (sans commandTimeout)
  // Si absent, tomber sur redisConnection, puis inline
  const conn = workerConnection || redisConnection;

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
    // stalledInterval: 30000 (default) — vérification jobs bloqués toutes les 30s
    // maxStalledCount: 1 (default) — 1 retry si stalled, puis échec
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
    logger.error(`[Queue] Worker error in "${queueName}"`, { error: err.message });
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
 */
async function addSmsJob(data) {
  return addJob('sms', data, {
    attempts: 3,
    backoff : { type: 'exponential', delay: 3000 },
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
    mode           : redisConnection ? 'redis' : 'inline-fallback',
    lockDuration   : 120000,
  };
}

module.exports = {
  addJob,
  addTranscriptionJob,
  addSmsJob,
  createWorker,
  getQueue,
  getQueueStatus,
  registerInlineHandler,
};
