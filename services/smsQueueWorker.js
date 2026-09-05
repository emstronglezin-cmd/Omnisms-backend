'use strict';
/**
 * OmniSMS — SMS Outbound Queue Worker
 *
 * Provides async retry logic for outbound SMS via Infobip.
 * Uses BullMQ 'sms' queue (via queueService.addSmsJob) with:
 *   - 3 attempts, exponential back-off (3s, 9s, 27s)
 *   - Dedup: a job with the same jobId will not be re-queued
 *   - Status updates written back to Firestore on success/failure
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

function getInfobip() {
  try { return require('./infobip'); } catch (_) { return null; }
}

/* ── Job processor ──────────────────────────────────────────── */
/**
 * Process a single SMS job.
 * @param {object} job  - BullMQ job (job.data contains SMS params)
 */
async function processSmsJob(job) {
  const { to, text, messageId, conversationId, ownerUid } = job.data;

  logger.info('[SmsWorker] Processing SMS job', {
    jobId: job.id,
    to: to ? to.replace(/\d{4}$/, '****') : null,
    messageId,
    attempt: job.attemptsMade,
  });

  const infobip = getInfobip();
  if (!infobip || !infobip.isConfigured()) {
    logger.warn('[SmsWorker] Infobip not configured — job skipped', { jobId: job.id });
    // Don't throw — don't fill retry queue if Infobip simply isn't set up
    return { skipped: true, reason: 'infobip_not_configured' };
  }

  let result;
  try {
    result = await infobip.sendSMS({ to, text });
  } catch (err) {
    logger.error('[SmsWorker] infobip.sendSMS threw', { jobId: job.id, error: err.message });
    throw err; // BullMQ will retry
  }

  const db = getDb();

  if (result.success) {
    logger.info('[SmsWorker] SMS sent successfully', {
      jobId: job.id, messageId, to: to.replace(/\d{4}$/, '****'),
      smsMessageId: result.messageId,
    });

    // Update Firestore message status
    if (db && messageId) {
      try {
        await db.collection('messages').doc(messageId).update({
          status      : 'sent',
          smsMessageId: result.messageId || null,
          smsStatus   : result.status    || 'SENT',
          updatedAt   : new Date().toISOString(),
        });
      } catch (dbErr) {
        logger.warn('[SmsWorker] Firestore status update failed', { error: dbErr.message, messageId });
      }
    }

    return { success: true, smsMessageId: result.messageId };
  }

  // SMS failed
  logger.error('[SmsWorker] SMS send failed', {
    jobId: job.id, messageId,
    error: result.error, statusCode: result.statusCode,
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
  throw new Error(result.error || 'Infobip SMS send failed');
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
