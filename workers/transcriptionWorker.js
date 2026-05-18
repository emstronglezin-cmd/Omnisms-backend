'use strict';
/**
 * OmniSMS — Worker Transcription (BullMQ)
 *
 * Traite les jobs de transcription de manière asynchrone.
 * Flux :
 *  1. Reçoit { audioPath, messageId, userId, language, model }
 *  2. Appelle le service Faster-Whisper
 *  3. Met à jour le document Firestore messages/{messageId}
 *  4. Émet un événement Socket.IO pour notifier le frontend
 *
 * Ce worker est démarré depuis server.js au boot.
 */

const path  = require('path');
const fs    = require('fs');
const { logger } = require('../middleware/logger');
const { transcribe } = require('../services/transcriptionService');
const { createWorker } = require('../services/queueService');

/* ── Référence Socket.IO (injectée depuis server.js) ──────── */
let _io = null;
function setSocketIO(io) { _io = io; }

/* ── Référence Firestore (lazy pour éviter crash boot) ──────── */
function getDb() {
  try { return require('../config/firebase'); } catch (_) { return null; }
}

/* ── Processor du job ─────────────────────────────────────── */
async function transcriptionProcessor(job) {
  const {
    audioPath,
    messageId,
    userId,
    language = 'fr',
    model    = process.env.WHISPER_MODEL || 'small',
  } = job.data;

  logger.info('[TranscriptionWorker] Processing job', {
    jobId: job.id, messageId, userId, audioPath,
  });

  // Mettre à jour le statut "en cours"
  await updateMessageStatus(messageId, { transcriptionStatus: 'processing' });
  emitTranscriptionEvent(userId, messageId, { status: 'processing' });

  let audioFilePath = audioPath;

  // Si le chemin est relatif, résoudre depuis la racine du projet
  if (!path.isAbsolute(audioFilePath)) {
    audioFilePath = path.join(__dirname, '..', audioFilePath);
  }

  if (!fs.existsSync(audioFilePath)) {
    const error = `Fichier audio introuvable: ${audioFilePath}`;
    logger.error('[TranscriptionWorker] File not found', { audioFilePath, jobId: job.id });
    await updateMessageStatus(messageId, {
      transcriptionStatus : 'error',
      transcriptionError  : error,
    });
    emitTranscriptionEvent(userId, messageId, { status: 'error', error });
    throw new Error(error);
  }

  let result;
  try {
    result = await transcribe({ audioPath: audioFilePath, language, model });
    logger.info('[TranscriptionWorker] Transcription success', {
      jobId: job.id, messageId, chars: result.text.length, method: result.method,
    });
  } catch (err) {
    logger.error('[TranscriptionWorker] Transcription failed', {
      jobId: job.id, messageId, error: err.message,
    });
    await updateMessageStatus(messageId, {
      transcriptionStatus: 'error',
      transcriptionError : err.message,
    });
    emitTranscriptionEvent(userId, messageId, { status: 'error', error: err.message });
    throw err;
  }

  // Sauvegarder en Firestore
  await updateMessageStatus(messageId, {
    transcriptionStatus  : 'done',
    transcription        : result.text,
    transcriptionLanguage: result.language,
    transcriptionDuration: result.duration || null,
    transcriptionSegments: result.segments || [],
    transcriptionMethod  : result.method,
    transcribedAt        : new Date().toISOString(),
  });

  // Notifier le frontend via Socket.IO
  emitTranscriptionEvent(userId, messageId, {
    status       : 'done',
    text         : result.text,
    language     : result.language,
    duration     : result.duration,
    messageId,
  });

  return { messageId, text: result.text, method: result.method };
}

/* ── Helpers ──────────────────────────────────────────────── */

async function updateMessageStatus(messageId, fields) {
  if (!messageId) return;
  const db = getDb();
  if (!db || db._stub) return;

  try {
    await db.collection('messages').doc(messageId).update({
      ...fields,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('[TranscriptionWorker] Firestore update failed', {
      messageId, error: err.message,
    });
  }
}

function emitTranscriptionEvent(userId, messageId, data) {
  if (!_io) return;
  try {
    // Notifier la room de l'utilisateur
    _io.to(`user:${userId}`).emit('transcription:update', {
      messageId,
      ...data,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('[TranscriptionWorker] Socket emit failed', { error: err.message });
  }
}

/* ── Démarrage du worker ──────────────────────────────────── */
let worker = null;

function startWorker() {
  if (worker) return worker;

  worker = createWorker('transcription', transcriptionProcessor, 1); // CPU → 1 seul concurrent
  if (worker) {
    logger.info('[TranscriptionWorker] BullMQ worker started.');
  } else {
    logger.info('[TranscriptionWorker] Running in inline mode (no Redis).');
  }
  return worker;
}

module.exports = {
  startWorker,
  setSocketIO,
  transcriptionProcessor,
};
