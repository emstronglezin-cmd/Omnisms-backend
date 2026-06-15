'use strict';
/**
 * OmniSMS — Route Transcription Vocale v2
 *
 * Endpoints :
 *   POST /api/transcription          → Upload + lancement transcription async (BullMQ)
 *   GET  /api/transcription/:id      → Statut + résultat d'une transcription
 *   GET  /api/transcription/service/status → Statut du service Faster-Whisper
 *
 * Flux complet :
 *   1. POST /api/transcription       → upload audio → job BullMQ → { jobId, status: 'queued' }
 *   2. Worker traite → Firestore mis à jour → Socket.IO : transcription:update
 *   3. GET  /api/transcription/:id   → { status: 'done', text: '...' }
 *
 * Moteur : Faster-Whisper (service Python HTTP) ou CLI whisper (fallback)
 * Aucune API payante.
 */

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { body, validationResult } = require('express-validator');
const firebaseAuth   = require('../middleware/firebaseAuth');
const { logger }     = require('../middleware/logger');

/* ── Lazy imports ─────────────────────────────────────────── */
function getDb() {
  try {
    const db = require('../config/firebase');
    if (db._stub) return null;
    return db;
  } catch (_) { return null; }
}

let _queueService = null;
function getQueueService() {
  if (_queueService) return _queueService;
  try { _queueService = require('../services/queueService'); return _queueService; } catch (_) { return null; }
}

let _transcriptionService = null;
function getTranscriptionService() {
  if (_transcriptionService) return _transcriptionService;
  try { _transcriptionService = require('../services/transcriptionService'); return _transcriptionService; } catch (_) { return null; }
}

/* ── Multer config ─────────────────────────────────────────── */
const UPLOADS_DIR = path.join(__dirname, '../uploads/transcription');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const ALLOWED_MIMES = [
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a',
  'audio/wav',  'audio/wave', 'audio/x-wav',
  'audio/webm', 'audio/ogg', 'audio/flac',
  'video/mp4',  'video/webm',
];
const ALLOWED_EXTS = ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac'];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename   : (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || '.mp3';
    const name = `transcription-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits    : { fileSize: 50 * 1024 * 1024 },   // 50 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIMES.includes(file.mimetype) || ALLOWED_EXTS.includes(ext)) {
      return cb(null, true);
    }
    return cb(new Error(`Format non supporté : ${file.mimetype || ext}. Formats acceptés : mp3, m4a, wav, webm, ogg, flac`));
  },
});

function cleanupFile(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

/* ─────────────────────────────────────────────────────────────
   POST /api/transcription
   Upload un fichier audio + lance la transcription async
   multipart/form-data : champ "audio" (requis)
   Body JSON optionnel : language (fr), model (small)
   ─────────────────────────────────────────────────────────── */
router.post(
  '/',
  firebaseAuth,
  upload.single('audio'),
  async (req, res) => {
    // Multer error handler
    if (req.multerError) {
      return res.status(400).json({ error: req.multerError.message, code: 'UPLOAD_ERROR' });
    }

    if (!req.file) {
      return res.status(400).json({
        error  : 'Aucun fichier audio fourni.',
        code   : 'NO_FILE',
        hint   : 'Envoyer un formulaire multipart/form-data avec le champ "audio".',
        formats: ALLOWED_EXTS,
      });
    }

    const filePath = req.file.path;
    const uid      = req.user.uid;
    const language = (req.body.language || req.query.language || 'fr').replace(/[^a-zA-Z]/g, '').slice(0, 5);
    const model    = (req.body.model    || req.query.model    || process.env.WHISPER_MODEL || 'small')
      .replace(/[^a-zA-Z0-9]/g, '');
    const async_   = req.body.async !== 'false';   // true par défaut

    const now       = new Date().toISOString();
    const jobId     = `tr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const filename  = req.file.filename;

    // Sauvegarder le job en Firestore
    const db = getDb();
    let docId = jobId;

    const jobDoc = {
      jobId,
      filename,
      audioPath : filePath,
      userId    : uid,
      language,
      model,
      status    : 'queued',
      text      : null,
      error     : null,
      createdAt : now,
      updatedAt : now,
    };

    if (db) {
      try {
        const ref = await db.collection('transcriptions').add(jobDoc);
        docId = ref.id;
        jobDoc.id = docId;
      } catch (dbErr) {
        logger.warn('[Transcription] Firestore save failed', { error: dbErr.message });
      }
    }

    // ── Mode synchrone (async=false) — direct, bloquant ──────
    if (!async_) {
      const svc = getTranscriptionService();
      if (!svc) {
        cleanupFile(filePath);
        return res.status(503).json({
          error: 'Service de transcription indisponible.',
          code : 'SERVICE_UNAVAILABLE',
          hint : 'Déployez le service Faster-Whisper ou installez whisper CLI.',
        });
      }

      try {
        const result = await svc.transcribe({ audioPath: filePath, language, model });
        cleanupFile(filePath);

        if (db && docId) {
          await db.collection('transcriptions').doc(docId).update({
            status      : 'done',
            text        : result.text,
            language    : result.language,
            duration    : result.duration || null,
            segments    : result.segments || [],
            method      : result.method,
            transcribedAt: new Date().toISOString(),
            updatedAt   : new Date().toISOString(),
          }).catch(() => {});
        }

        return res.status(200).json({
          success : true,
          id      : docId,
          jobId   : docId,
          status  : 'done',
          text    : result.text,
          language: result.language || language,
          duration: result.duration || null,
          model,
          method  : result.method,
          async   : false,
        });

      } catch (transcribeErr) {
        cleanupFile(filePath);
        if (db && docId) {
          await db.collection('transcriptions').doc(docId).update({
            status   : 'error',
            error    : transcribeErr.message,
            updatedAt: new Date().toISOString(),
          }).catch(() => {});
        }
        return res.status(503).json({
          error : transcribeErr.message,
          code  : 'TRANSCRIPTION_FAILED',
          id    : docId,
        });
      }
    }

    // ── Mode asynchrone (défaut) — BullMQ queue ──────────────
    const qs = getQueueService();
    let queued = false;
    let bullJobId = null;

    if (qs && qs.addTranscriptionJob) {
      try {
        const jobRes = await qs.addTranscriptionJob({
          audioPath: filePath,
          messageId: docId,
          userId   : uid,
          language,
          model,
        });
        queued     = jobRes.queued !== false;
        bullJobId  = jobRes.jobId;
        logger.info('[Transcription] Job ajouté à la queue', { jobId: bullJobId, docId, uid });
      } catch (qErr) {
        logger.warn('[Transcription] Queue error — fallback inline', { error: qErr.message });
      }
    }

    // Fallback inline si BullMQ indisponible
    if (!queued) {
      const svc = getTranscriptionService();
      if (svc) {
        // Lancer en background sans bloquer la réponse
        setImmediate(async () => {
          try {
            const result = await svc.transcribe({ audioPath: filePath, language, model });
            cleanupFile(filePath);

            if (db && docId) {
              await db.collection('transcriptions').doc(docId).update({
                status      : 'done',
                text        : result.text,
                language    : result.language,
                duration    : result.duration || null,
                segments    : result.segments || [],
                method      : result.method,
                transcribedAt: new Date().toISOString(),
                updatedAt   : new Date().toISOString(),
              }).catch(() => {});
            }

            // Notifier via Socket.IO
            try {
              const { emitToUser } = require('../services/socketService');
              emitToUser(uid, 'transcription:update', {
                status  : 'done',
                id      : docId,
                text    : result.text,
                language: result.language,
                duration: result.duration,
                timestamp: new Date().toISOString(),
              });
            } catch (_) {}

          } catch (err) {
            logger.error('[Transcription] Inline fallback error', { error: err.message });
            cleanupFile(filePath);
            if (db && docId) {
              await db.collection('transcriptions').doc(docId).update({
                status: 'error', error: err.message, updatedAt: new Date().toISOString(),
              }).catch(() => {});
            }
          }
        });
      }
    }

    logger.info('[Transcription] Job créé', { jobId: docId, uid, language, model, filename });

    return res.status(202).json({
      success : true,
      id      : docId,
      jobId   : docId,
      bullJobId,
      status  : 'queued',
      filename,
      language,
      model,
      async   : true,
      message : 'Transcription en cours. Écoutez transcription:update via Socket.IO ou interrogez GET /api/transcription/' + docId,
      poll    : `GET /api/transcription/${docId}`,
    });
  }
);

/* ─────────────────────────────────────────────────────────────
   GET /api/transcription/service/status
   Doit être défini AVANT /:id pour éviter le conflit
   ─────────────────────────────────────────────────────────── */
router.get('/service/status', async (_req, res) => {
  const svc = getTranscriptionService();
  if (!svc) {
    return res.status(503).json({
      available: false,
      error    : 'Service de transcription non chargé.',
    });
  }
  try {
    const status = await svc.getTranscriptionStatus();
    return res.status(status.available ? 200 : 503).json(status);
  } catch (err) {
    return res.status(500).json({ available: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/transcription/:id
   Récupérer le statut et résultat d'une transcription
   ─────────────────────────────────────────────────────────── */
router.get('/:id', firebaseAuth, async (req, res) => {
  const { id } = req.params;
  const uid    = req.user.uid;

  try {
    const db = getDb();
    if (!db) {
      return res.status(503).json({
        error: 'Firebase non configuré.',
        code : 'DB_UNAVAILABLE',
      });
    }

    const snap = await db.collection('transcriptions').doc(id).get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Transcription non trouvée.', code: 'NOT_FOUND' });
    }

    const data = snap.data();

    // Vérification propriétaire
    if (data.userId && data.userId !== uid) {
      return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
    }

    return res.status(200).json({
      id       : snap.id,
      jobId    : data.jobId    || snap.id,
      status   : data.status   || 'unknown',
      text     : data.text     || null,
      language : data.language || null,
      duration : data.duration || null,
      model    : data.model    || null,
      method   : data.method   || null,
      error    : data.error    || null,
      filename : data.filename || null,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      transcribedAt: data.transcribedAt || null,
    });

  } catch (err) {
    logger.error('[Transcription] GET /:id error', { error: err.message, id });
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

/* ─────────────────────────────────────────────────────────────
   Multer error handler global pour ce router
   ─────────────────────────────────────────────────────────── */
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Fichier trop volumineux (max 50 MB).', code: 'FILE_TOO_LARGE' });
    }
    return res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
  }
  if (err && err.message) {
    return res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
  }
  next(err);
});

module.exports = router;
