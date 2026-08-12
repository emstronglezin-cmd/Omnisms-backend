'use strict';
/**
 * OmniSMS — Routes Messages Vocaux v2
 *
 * Endpoints :
 *   POST /api/audio/upload             → Upload fichier audio (message vocal)
 *   POST /api/audio/transcribe/:id     → Lancer transcription d'un message vocal
 *   GET  /api/audio/:id                → Récupérer métadonnées d'un audio
 *   GET  /api/audio/stream/:filename   → Streaming audio sécurisé
 *   DELETE /api/audio/:id              → Supprimer un audio
 *   GET  /api/audio/status             → Statut du service transcription
 *
 * Flux upload + transcription :
 *   1. POST /api/audio/upload → sauvegarde fichier + Firestore
 *   2. POST /api/audio/transcribe/:id → job BullMQ asynchrone
 *   3. Worker transcrit → met à jour Firestore
 *   4. Socket.IO notifie le client (transcription:update)
 */

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const authenticate = require('../middleware/authenticate');
const firebaseAuth = require('../middleware/firebaseAuth');
const {
  audioUpload,
  validateUploadedFile,
  getAudioMetadata,
  buildFileUrl,
  cleanupFile,
  multerErrorHandler,
  DIRS,
} = require('../services/uploadService');
const { addTranscriptionJob } = require('../services/queueService');
const { getTranscriptionStatus } = require('../services/transcriptionService');
const { logger } = require('../middleware/logger');

const auth = firebaseAuth;

/* ── Firestore helper ─────────────────────────────────────── */
function getDb() {
  try {
    const db = require('../config/firebase');
    if (db._stub) return null;
    return db;
  } catch (_) { return null; }
}

/* ─────────────────────────────────────────────────────────────
   POST /api/audio/upload
   Upload un message vocal
   multipart/form-data : champ "audio"
   ─────────────────────────────────────────────────────────── */
router.post(
  '/upload',
  auth,
  audioUpload.single('audio'),
  multerErrorHandler,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: 'Aucun fichier audio fourni. Champ multipart attendu: "audio".',
        code : 'NO_FILE',
        hint : 'Formats acceptés: mp3, m4a, wav, aac, ogg, webm, flac',
      });
    }

    const filePath = req.file.path;
    const uid      = req.user.uid;

    try {
      // Validation magic bytes
      try {
        await validateUploadedFile(filePath, 'audio');
      } catch (validErr) {
        cleanupFile(filePath);
        return res.status(415).json({
          error: validErr.message,
          code : 'INVALID_FILE_TYPE',
        });
      }

      // Extraire métadonnées audio (durée, codec, bitrate)
      const metadata = await getAudioMetadata(filePath);

      // Vérifier durée max (10 minutes)
      if (metadata && metadata.duration > 600) {
        cleanupFile(filePath);
        return res.status(400).json({
          error   : 'Message vocal trop long (max 10 minutes).',
          code    : 'AUDIO_TOO_LONG',
          duration: Math.round(metadata.duration),
        });
      }

      const filename = req.file.filename;
      const fileUrl  = buildFileUrl('audio', filename);
      const now      = new Date().toISOString();

      // ── Stratégie persistance audio ────────────────────────
      // Render ephemeral FS : les fichiers sont effacés à chaque redeploy.
      // Pour les vocaux courts (≤ 1.5 MB), on stocke le base64 dans Firestore.
      // Pour les fichiers plus grands, on garde l'URL disque (playback immédiat,
      // mais 404 après redeploy — acceptable pour gros fichiers).
      const MAX_AUDIO_B64 = 1.5 * 1024 * 1024; // 1.5 MB
      let audioDataUri = null;

      if (req.file.size <= MAX_AUDIO_B64) {
        try {
          const buf  = fs.readFileSync(filePath);
          const b64  = buf.toString('base64');
          audioDataUri = `data:${req.file.mimetype};base64,${b64}`;
          logger.info('[Audio] Small audio stored as base64 in Firestore', { uid, size: req.file.size });
        } catch (b64Err) {
          logger.warn('[Audio] base64 conversion failed, keeping disk URL', { error: b64Err.message });
        }
      }

      // URL à utiliser : data URI (persistant) ou URL disque (éphémère)
      const audioUrl = audioDataUri || fileUrl;

      const audioDoc = {
        id              : filename.replace(/\.[^.]+$/, ''),  // sans extension
        filename,
        originalName    : req.file.originalname,
        mimetype        : req.file.mimetype,
        size            : req.file.size,
        url             : audioUrl,
        audioDataUri    : audioDataUri || null,  // base64 pour persistance
        uploaderId      : uid,
        duration        : metadata?.duration      || null,
        durationFormatted: metadata?.duration
          ? `${Math.floor(metadata.duration / 60)}:${String(Math.round(metadata.duration % 60)).padStart(2, '0')}`
          : null,
        bitrate         : metadata?.bitrate       || null,
        codec           : metadata?.codec         || null,
        sampleRate      : metadata?.sampleRate    || null,
        channels        : metadata?.channels      || null,
        transcription   : null,
        transcriptionStatus: 'pending',
        createdAt       : now,
        updatedAt       : now,
      };

      // Sauvegarder en Firestore
      const db = getDb();
      let docId = audioDoc.id;

      if (db) {
        try {
          const ref = await db.collection('audio_messages').add(audioDoc);
          docId = ref.id;
          audioDoc.id = docId;
        } catch (dbErr) {
          logger.warn('[Audio] Firestore save failed', { error: dbErr.message });
        }
      }

      logger.info('[Audio] Upload success', {
        uid, filename, size: req.file.size, duration: metadata?.duration,
        storedAs: audioDataUri ? 'base64' : 'disk-url',
      });

      return res.status(201).json({
        success      : true,
        id           : docId,
        filename,
        url          : audioUrl,
        size         : req.file.size,
        mimetype     : req.file.mimetype,
        duration     : metadata?.duration      || null,
        durationFormatted: audioDoc.durationFormatted,
        codec        : metadata?.codec         || null,
        transcription: null,
        transcriptionStatus: 'pending',
        hint         : `Lancer la transcription : POST /api/audio/transcribe/${docId}`,
      });

    } catch (err) {
      cleanupFile(filePath);
      logger.error('[Audio] Upload error', { error: err.message });
      return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   POST /api/audio/transcribe/:id
   Lancer la transcription (async via BullMQ)
   ─────────────────────────────────────────────────────────── */
router.post('/transcribe/:id', auth, async (req, res) => {
  const { id }     = req.params;
  const { language = 'fr', model } = req.body;
  const uid        = req.user.uid;

  try {
    const db = getDb();
    let audioData = null;

    if (db) {
      const snap = await db.collection('audio_messages').doc(id).get();
      if (snap.exists) {
        audioData = { id: snap.id, ...snap.data() };
      }
    }

    // Chercher le fichier par ID dans uploads/audio si Firestore indisponible
    if (!audioData) {
      const files = fs.readdirSync(DIRS.audio);
      const match = files.find(f => f.startsWith(id));
      if (match) {
        audioData = {
          id,
          filename: match,
          uploaderId: uid,
        };
      }
    }

    if (!audioData) {
      return res.status(404).json({ error: 'Message vocal non trouvé.', code: 'NOT_FOUND' });
    }

    // Vérifier propriétaire
    if (audioData.uploaderId && audioData.uploaderId !== uid) {
      return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
    }

    const audioPath = path.join(DIRS.audio, audioData.filename);

    if (!fs.existsSync(audioPath)) {
      return res.status(404).json({
        error: 'Fichier audio introuvable sur le serveur.',
        code : 'FILE_NOT_FOUND',
      });
    }

    // Créer le job de transcription
    const job = await addTranscriptionJob({
      audioPath,
      messageId : id,
      userId    : uid,
      language  : language.replace(/[^a-zA-Z]/g, '').slice(0, 5),
      model     : model || process.env.WHISPER_MODEL || 'small',
      collection: 'audio_messages',   // collection Firestore à mettre à jour
    });

    // Mettre à jour le statut
    if (db) {
      await db.collection('audio_messages').doc(id).update({
        transcriptionStatus: 'queued',
        transcriptionJobId : job.jobId,
        updatedAt          : new Date().toISOString(),
      }).catch(() => {});
    }

    return res.status(202).json({
      success   : true,
      jobId     : job.jobId,
      queued    : job.queued,
      messageId : id,
      language,
      status    : 'queued',
      message   : 'Transcription en cours. Vous serez notifié via Socket.IO (transcription:update).',
    });

  } catch (err) {
    logger.error('[Audio] transcribe error', { error: err.message, id });
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/audio/:id
   Récupérer métadonnées d'un audio
   ─────────────────────────────────────────────────────────── */
router.get('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const uid    = req.user.uid;

  try {
    const db = getDb();

    if (db) {
      const snap = await db.collection('audio_messages').doc(id).get();
      if (snap.exists) {
        const data = snap.data();
        // Vérifier accès (propriétaire ou destinataire)
        if (data.uploaderId !== uid && data.receiverId !== uid) {
          return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
        }
        return res.status(200).json({ id: snap.id, ...data });
      }
    }

    return res.status(404).json({ error: 'Audio non trouvé.', code: 'NOT_FOUND' });

  } catch (err) {
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/audio/stream/:filename
   Streaming audio sécurisé avec Range headers
   ─────────────────────────────────────────────────────────── */
router.get('/stream/:filename', auth, (req, res) => {
  const { filename } = req.params;

  // Sécurité : éviter path traversal
  const safeName = path.basename(filename);
  const filePath = path.join(DIRS.audio, safeName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Fichier audio introuvable.', code: 'NOT_FOUND' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range    = req.headers.range;

  if (range) {
    // Streaming partiel (Range request)
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end   = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }

    const chunkSize = end - start + 1;
    const stream    = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range' : `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges' : 'bytes',
      'Content-Length': chunkSize,
      'Content-Type'  : 'audio/mpeg',
      'Cache-Control' : 'no-cache',
    });
    stream.pipe(res);
  } else {
    // Envoi complet
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type'  : 'audio/mpeg',
      'Accept-Ranges' : 'bytes',
      'Cache-Control' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /api/audio/:id
   ─────────────────────────────────────────────────────────── */
router.delete('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const uid    = req.user.uid;

  try {
    const db = getDb();
    let filename = null;

    if (db) {
      const snap = await db.collection('audio_messages').doc(id).get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'Audio non trouvé.', code: 'NOT_FOUND' });
      }
      const data = snap.data();
      if (data.uploaderId !== uid) {
        return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
      }
      filename = data.filename;
      await db.collection('audio_messages').doc(id).delete();
    }

    // Supprimer le fichier physique
    if (filename) {
      cleanupFile(path.join(DIRS.audio, filename));
    }

    return res.status(200).json({ success: true, message: 'Message vocal supprimé.' });

  } catch (err) {
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/audio/status
   Statut du service transcription
   ─────────────────────────────────────────────────────────── */
router.get('/status/transcription', async (_req, res) => {
  try {
    const status = await getTranscriptionStatus();
    return res.status(status.available ? 200 : 503).json(status);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
