'use strict';
/**
 * OmniSMS — SMS Outbound Queue Worker
 *
 * Provides async retry logic for outbound SMS.
 * Uses BullMQ 'sms' queue (via queueService.addSmsJob) with:
 *   - 3 attempts, exponential back-off (3s, 9s, 27s)
 *   - Dedup: a job with the same jobId will not be re-queued
 *   - Status updates written back to Firestore on success/failure
 *
 * Transport order :
 *   1. SMS Gateway for Android™ (Z Fold2) si OFFLINE_SMS_PROVIDER=sms_gateway (défaut)
 *   2. Infobip si OFFLINE_SMS_PROVIDER=infobip OU si Gateway non configuré
 *   3. Fallback Infobip si OFFLINE_SMS_FALLBACK_TO_INFOBIP=true
 *
 * If Redis is unavailable → jobs execute inline (queueService fallback).
 *
 * Usage:
 *   // Enqueue an SMS job (called from messageRouter or any service)
 *   const { enqueueSmsJob } = require('./smsQueueWorker');
 *   await enqueueSmsJob({ to, text, messageId, conversationId, ownerUid });
 *
 *   // Start the worker (called from server.js start-up)
 *   const { startSmsWorker } = require('./smsQueueWorker');
 *   startSmsWorker();
 */

const { addSmsJob, createWorker } = require('./queueService');
const { logger } = require('../middleware/logger');

/* ── Lazy imports (avoid circular deps at require-time) ─────── */
function getDb() {
  try {
    const db = require('../config/firebase');
    return db && !db._stub ? db : null;
  } catch (_) { return null; }
}

function getSmsGateway() {
  try { return require('./smsGateway'); } catch (_) { return null; }
}

function getInfobip() {
  try { return require('./infobip'); } catch (_) { return null; }
}

/* ── Transport selector ─────────────────────────────────────── */
/**
 * Sélectionne le bon transport pour le retry SMS.
 * Même logique que messageRouter.js : Gateway d'abord, Infobip en standby.
 *
 * @returns {{ provider: string, send: Function }|null}
 */
function selectTransport() {
  const smsGateway = getSmsGateway();
  const infobip    = getInfobip();

  // SMS Gateway en premier si configuré et actif
  if (smsGateway && smsGateway.isSmsGatewayProvider() && smsGateway.isConfigured()) {
    return {
      provider: 'sms_gateway',
      send    : (opts) => smsGateway.sendSMS(opts),
    };
  }

  // Infobip en standby si configuré
  if (infobip && infobip.isConfigured()) {
    return {
      provider: 'infobip',
      send    : ({ to, text }) => infobip.sendSMS({ to, text }),
    };
  }

  return null;
}

/* ── Job processor ──────────────────────────────────────────── */
/**
 * Process a single SMS job.
 * @param {object} job  - BullMQ job (job.data contains SMS params)
 */
async function processSmsJob(job) {
  const { to, text, messageId, conversationId, ownerUid } = job.data;

  logger.info('[SmsWorker] Processing SMS job', {
    jobId  : job.id,
    to     : to ? to.replace(/\d{4}$/, '****') : null,
    messageId,
    attempt: job.attemptsMade,
  });

  const transport = selectTransport();

  if (!transport) {
    logger.warn('[SmsWorker] Aucun transport SMS configuré — job ignoré', {
      jobId: job.id,
      hint : 'Configurer SMS_GATEWAY_LOGIN + SMS_GATEWAY_PASSWORD (transport principal) ou INFOBIP_API_KEY + INFOBIP_BASE_URL (standby)',
    });
    // Ne pas jeter — éviter de remplir la queue si aucun provider n'est configuré
    return { skipped: true, reason: 'no_transport_configured' };
  }

  logger.info('[SmsWorker] Using transport', { provider: transport.provider, jobId: job.id });

  let result;
  try {
    result = await transport.send({
      to,
      text,
      messageId: messageId || null,
      ttl      : 3600,
    });
  } catch (err) {
    logger.error('[SmsWorker] transport.send threw', {
      jobId   : job.id,
      provider: transport.provider,
      error   : err.message,
    });
    throw err; // BullMQ will retry
  }

  // Si le transport principal (Gateway) échoue ET fallback Infobip activé
  if (!result.success && transport.provider === 'sms_gateway') {
    const smsGateway = getSmsGateway();
    const infobip    = getInfobip();
    if (smsGateway && smsGateway.isInfobipFallbackEnabled() && infobip && infobip.isConfigured()) {
      logger.warn('[SmsWorker] Gateway failed — tentative Infobip fallback', {
        jobId: job.id,
        error: result.error,
      });
      try {
        const fallback = await infobip.sendSMS({ to, text });
        if (fallback.success) {
          result = { ...fallback, provider: 'infobip_fallback' };
          logger.info('[SmsWorker] Infobip fallback réussi', { jobId: job.id });
        }
      } catch (fbErr) {
        logger.warn('[SmsWorker] Infobip fallback threw', { error: fbErr.message });
      }
    }
  }

  const db = getDb();

  if (result.success) {
    const providerMsgId = result.messageId || result.gatewayMessageId || null;

    logger.info('[SmsWorker] SMS sent successfully', {
      jobId      : job.id,
      messageId,
      to         : to.replace(/\d{4}$/, '****'),
      provider   : result.provider || transport.provider,
      providerMsgId,
    });

    // Update Firestore message status
    if (db && messageId) {
      try {
        await db.collection('messages').doc(messageId).update({
          status      : 'sent',
          smsMessageId: providerMsgId,
          smsProvider : result.provider || transport.provider,
          smsStatus   : result.state || result.status || 'SENT',
          updatedAt   : new Date().toISOString(),
        });
      } catch (dbErr) {
        logger.warn('[SmsWorker] Firestore status update failed', { error: dbErr.message, messageId });
      }
    }

    return { success: true, smsMessageId: providerMsgId, provider: result.provider || transport.provider };
  }

  // SMS failed
  logger.error('[SmsWorker] SMS send failed', {
    jobId     : job.id,
    messageId,
    provider  : transport.provider,
    error     : result.error,
    statusCode: result.statusCode,
  });

  // Update Firestore message as failed on last attempt
  if (db && messageId && job.attemptsMade >= 2) {
    try {
      await db.collection('messages').doc(messageId).update({
        status   : 'failed',
        smsError : result.error || 'unknown',
        updatedAt: new Date().toISOString(),
      });
    } catch (dbErr) {
      logger.warn('[SmsWorker] Firestore failure update failed', { error: dbErr.message, messageId });
    }
  }

  // Throw to trigger BullMQ retry
  throw new Error(result.error || `SMS send failed via ${transport.provider}`);
}

/* ── Public API ─────────────────────────────────────────────── */

/**
 * Enqueue an outbound SMS job (idempotent via jobId dedup).
 *
 * @param {object} opts
 * @param {string}  opts.to             - E.164 destination
 * @param {string}  opts.text           - SMS content
 * @param {string} [opts.messageId]     - Firestore message doc ID (for status updates)
 * @param {string} [opts.conversationId]
 * @param {string} [opts.ownerUid]      - OmniSMS sender UID
 * @returns {Promise<{jobId, queued}>}
 */
async function enqueueSmsJob({ to, text, messageId, conversationId, ownerUid } = {}) {
  if (!to || !text) {
    logger.warn('[SmsWorker] enqueueSmsJob: to and text are required');
    return { jobId: null, queued: false };
  }

  // Use messageId as dedup key when available (same message → same BullMQ jobId)
  const jobOpts = messageId
    ? { jobId: `sms-${messageId}`, attempts: 3, backoff: { type: 'exponential', delay: 3000 } }
    : { attempts: 3, backoff: { type: 'exponential', delay: 3000 } };

  return addSmsJob(
    { to, text, messageId: messageId || null, conversationId: conversationId || null, ownerUid: ownerUid || null },
    jobOpts,
  );
}

/**
 * Start the BullMQ SMS worker.
 * Call once from server.js at startup.
 * Safe to call even if Redis is unavailable (inline fallback).
 */
function startSmsWorker() {
  createWorker('sms', processSmsJob, 2);
  logger.info('[SmsWorker] SMS worker started (concurrency: 2).');
}

module.exports = {
  enqueueSmsJob,
  startSmsWorker,
  processSmsJob, // exported for unit tests
};
