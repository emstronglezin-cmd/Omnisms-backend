'use strict';
/**
 * OmniSMS — Worker Transcription (BullMQ)
 *
 * Traite les jobs de transcription de manière asynchrone.
 * Flux :
 *  1. Reçoit { audioPath, messageId, userId, language, model }
 *  2. Appelle Groq Whisper API (principal) ou fallback
 *  3. Met à jour le document Firestore messages/{messageId}
 *  4. Émet un événement Socket.IO pour notifier le frontend
 *
 * Ce worker est démarré depuis server.js au boot.
 *
 * FIX v4.1 : La connexion Worker utilise maintenant une connexion Redis
 * dédiée SANS commandTimeout pour éviter les "Command timed out" pendant
 * les longs appels Groq (10-120s). lockDuration: 120s.
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

/* ── Nettoyage fichier temporaire ─────────────────────────── */
function cleanupTempFile(tempFile) {
  if (!tempFile) return;
  try {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
      logger.info('[TranscriptionWorker] Temp file deleted', { tempFile });
    }
  } catch (err) {
    logger.warn('[TranscriptionWorker] Temp file delete failed', { tempFile, error: err.message });
  }
}

/* ── Processor du job ─────────────────────────────────────── */
async function transcriptionProcessor(job) {
  const {
    audioPath,
    tempFile,                          // fichier temporaire créé depuis base64 — à supprimer après
    messageId,
    userId,
    language   = 'fr',
    model      = process.env.WHISPER_MODEL || 'small',
    collection = 'audio_messages',   // collection Firestore à mettre à jour
  } = job.data;

  const jobStart = Date.now();

  logger.info('[Transcription] Job received', {
    jobId: job.id, messageId, userId, audioPath, language, model, collection,
  });

  // ── Étape 1 : Mettre à jour le statut "en cours" ──────────
  await updateMessageStatus(messageId, { transcriptionStatus: 'processing' }, collection);
  emitTranscriptionEvent(userId, messageId, { status: 'processing', messageId });

  // ── Étape 2 : Localiser le fichier audio ──────────────────
  let audioFilePath = audioPath;
  if (!path.isAbsolute(audioFilePath)) {
    audioFilePath = path.join(__dirname, '..', audioFilePath);
  }

  if (!fs.existsSync(audioFilePath)) {
    const error = `Fichier audio introuvable: ${audioFilePath}`;
    logger.error('[Transcription] FAILED — audio file not found', {
      jobId: job.id, messageId, audioFilePath,
      hint: 'Vérifier que uploads/audio/ existe et que le fichier est bien sauvegardé lors de l\'upload',
    });
    await updateMessageStatus(messageId, {
      transcriptionStatus : 'error',
      transcriptionError  : error,
    }, collection);
    emitTranscriptionEvent(userId, messageId, { status: 'error', error, messageId });
    cleanupTempFile(tempFile);
    throw new Error(error);
  }

  // ── Étape 3 : Info fichier ────────────────────────────────
  const fileStat = fs.statSync(audioFilePath);
  const fileExt  = path.extname(audioFilePath).toLowerCase();
  logger.info('[Transcription] Audio file located', {
    jobId    : job.id,
    messageId,
    audioPath: audioFilePath,
    fileSize : fileStat.size,
    fileExt,
    fileSizeKB: Math.round(fileStat.size / 1024),
  });

  if (fileStat.size === 0) {
    const error = 'Fichier audio vide (0 octets) — impossible de transcrire.';
    logger.error('[Transcription] FAILED — empty file', { jobId: job.id, messageId, audioFilePath });
    await updateMessageStatus(messageId, { transcriptionStatus: 'error', transcriptionError: error }, collection);
    emitTranscriptionEvent(userId, messageId, { status: 'error', error, messageId });
    cleanupTempFile(tempFile);
    throw new Error(error);
  }

  // ── Étape 4 : Appel Groq Whisper ─────────────────────────
  logger.info('[Transcription] Sending request to Groq Whisper', {
    jobId: job.id, messageId, model: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
    language, fileSizeKB: Math.round(fileStat.size / 1024),
  });

  const groqStart = Date.now();
  let result;
  try {
    result = await transcribe({ audioPath: audioFilePath, language, model });
    const groqMs = Date.now() - groqStart;
    logger.info('[Transcription] Groq response received', {
      jobId : job.id,
      messageId,
      method: result.method,
      chars : result.text?.length || 0,
      lang  : result.language,
      durMs : groqMs,
    });
  } catch (err) {
    const groqMs = Date.now() - groqStart;
    logger.error('[Transcription] FAILED — Groq/transcription error', {
      jobId  : job.id,
      messageId,
      error  : err.message,
      durMs  : groqMs,
      step   : 'transcription engine call',
    });
    await updateMessageStatus(messageId, {
      transcriptionStatus: 'error',
      transcriptionError : err.message,
    }, collection);
    emitTranscriptionEvent(userId, messageId, { status: 'error', error: err.message, messageId });
    cleanupTempFile(tempFile);
    throw err;
  }

  // ── Étape 5 : Transcription générée ──────────────────────
  logger.info('[Transcription] Transcription generated', {
    jobId   : job.id,
    messageId,
    chars   : result.text?.length || 0,
    preview : result.text?.slice(0, 80),
    language: result.language,
    duration: result.duration,
    method  : result.method,
  });

  // ── Étape 6 : Sauvegarde Firestore ────────────────────────
  logger.info('[Transcription] Saving transcription to Firestore', { jobId: job.id, messageId, collection });
  await updateMessageStatus(messageId, {
    transcriptionStatus  : 'done',
    transcription        : result.text,
    transcriptionLanguage: result.language,
    transcriptionDuration: result.duration || null,
    transcriptionSegments: result.segments || [],
    transcriptionMethod  : result.method,
    transcribedAt        : new Date().toISOString(),
  }, collection);

  // ── Étape 7 : Notification Socket.IO ─────────────────────
  logger.info('[Transcription] Socket notification sent', { jobId: job.id, messageId, userId });
  emitTranscriptionEvent(userId, messageId, {
    status  : 'done',
    text    : result.text,
    language: result.language,
    duration: result.duration,
    method  : result.method,
    messageId,
  });

  // ── Étape 8 : Nettoyage fichier temporaire ───────────────
  cleanupTempFile(tempFile);

  // ── Étape 9 : Job complété ────────────────────────────────
  const totalMs = Date.now() - jobStart;
  logger.info('[Transcription] Job completed', {
    jobId   : job.id,
    messageId,
    method  : result.method,
    totalMs,
    chars   : result.text?.length || 0,
  });

  return { messageId, text: result.text, method: result.method };
}

/* ── Helpers ──────────────────────────────────────────────── */

async function updateMessageStatus(messageId, fields, collection = 'audio_messages') {
  if (!messageId) return;
  const db = getDb();
  if (!db || db._stub) return;

  try {
    await db.collection(collection).doc(messageId).update({
      ...fields,
      updatedAt: new Date().toISOString(),
    });
    logger.info('[TranscriptionWorker] Firestore updated', {
      messageId, collection, fields: Object.keys(fields),
    });
  } catch (err) {
    logger.warn('[TranscriptionWorker] Firestore update failed', {
      messageId, collection, error: err.message,
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
