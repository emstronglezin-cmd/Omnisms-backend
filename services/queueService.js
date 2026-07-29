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
let redisConnection = null;

if (bullmqAvailable && REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redisConnection = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null, // requis par BullMQ
      enableReadyCheck    : false,
      lazyConnect         : false,
      retryStrategy(times) {
        if (times >= 3) return null; // stoppe après 3 tentatives
        return Math.min(times * 500, 2000);
      },
    });
    let _queueFallback = false;
    redisConnection.on('error', (err) => {
      if (_queueFallback) return;
      const isFatal = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'EAI_AGAIN';
      if (isFatal) {
        _queueFallback = true;
        logger.warn(`[Queue] Redis DNS/network error (${err.code}) — switching to inline execution.`);
        redisConnection = null;
        try { redisConnection && redisConnection.disconnect(); } catch (_) {}
      } else {
        logger.error('[Queue] Redis error', { msg: err.message });
      }
    });
    logger.info('[Queue] BullMQ connected to Redis.');
  } catch (err) {
    logger.error('[Queue] Redis connection failed', { error: err.message });
    redisConnection = null;
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
 */
function createWorker(queueName, processor, concurrency = 2) {
  if (!bullmqAvailable || !redisConnection) {
    // Enregistrer comme handler inline
    registerInlineHandler(queueName, processor);
    logger.info(`[Queue] Worker "${queueName}" registered as inline handler.`);
    return null;
  }

  if (workers[queueName]) return workers[queueName];

  const worker = new Worker(queueName, processor, {
    connection : redisConnection,
    concurrency,
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
    bullmqAvailable,
    queues         : Object.keys(queues),
    workers        : Object.keys(workers),
    mode           : redisConnection ? 'redis' : 'inline-fallback',
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
