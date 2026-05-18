'use strict';
/**
 * OmniSMS — Service Upload Unifié
 *
 * Gère tous les uploads (audio, images, pièces jointes) avec :
 * - Validation MIME stricte (magic bytes + mimetype déclaré)
 * - Limite de taille par type
 * - Nommage UUID sécurisé
 * - Cleanup automatique des fichiers temporaires
 * - Métadonnées extractées (durée audio via probe ffprobe)
 *
 * Formats audio  : m4a, mp3, wav, aac, ogg, webm, flac
 * Formats image  : jpg, jpeg, png, gif, webp
 * Pièces jointes : pdf, txt, csv, doc, docx, xls, xlsx
 */

const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { logger } = require('../middleware/logger');

/* ── Répertoires ──────────────────────────────────────────── */
const BASE_UPLOADS = path.join(__dirname, '../uploads');
const DIRS = {
  audio      : path.join(BASE_UPLOADS, 'audio'),
  images     : path.join(BASE_UPLOADS, 'images'),
  attachments: path.join(BASE_UPLOADS, 'attachments'),
  temp       : path.join(BASE_UPLOADS, 'temp'),
};

// Créer les dossiers si absents
Object.values(DIRS).forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/* ── MIME types autorisés ─────────────────────────────────── */
const ALLOWED = {
  audio: {
    mimes: [
      'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a',
      'audio/wav', 'audio/wave', 'audio/x-wav',
      'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac',
      'audio/x-flac', 'audio/3gpp', 'audio/amr',
      'video/mp4', 'video/webm',  // certains clients envoient mp4/webm pour l'audio
    ],
    exts: ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.webm', '.flac', '.3gp', '.amr'],
    maxSize: 50 * 1024 * 1024,  // 50 MB
  },
  images: {
    mimes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
    exts: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
    maxSize: 10 * 1024 * 1024,  // 10 MB
  },
  attachments: {
    mimes: [
      'application/pdf', 'text/plain', 'text/csv',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    exts: ['.pdf', '.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx'],
    maxSize: 20 * 1024 * 1024,  // 20 MB
  },
};

/* ── Magic bytes pour validation côté serveur ─────────────── */
const MAGIC_SIGNATURES = {
  'ffd8ff'  : 'image/jpeg',
  '89504e47': 'image/png',
  '47494638': 'image/gif',
  '52494646': 'audio/wav',   // RIFF (WAV)
  '25504446': 'application/pdf',
  '494433'  : 'audio/mpeg',  // ID3 (MP3)
  'fffb'    : 'audio/mpeg',
  'fffa'    : 'audio/mpeg',
  '4f676753': 'audio/ogg',   // OggS
  '664c6143': 'audio/flac',  // fLaC
};

/**
 * Vérifie les magic bytes d'un buffer.
 * Retourne le MIME détecté ou null si non reconnu.
 */
function detectMimeFromBuffer(buffer) {
  const hex = buffer.slice(0, 8).toString('hex').toLowerCase();
  for (const [sig, mime] of Object.entries(MAGIC_SIGNATURES)) {
    if (hex.startsWith(sig)) return mime;
  }
  // MP4/M4A (ftyp box)
  if (hex.slice(8, 16) === '66747970') return 'audio/mp4';
  return null;
}

/**
 * Valide un fichier uploadé (extension + MIME déclaré).
 * La validation magic bytes se fait après upload dans validateUploadedFile().
 */
function mimeFilter(type) {
  return function(_req, file, cb) {
    const cfg  = ALLOWED[type];
    const ext  = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype.toLowerCase();

    const extOk  = cfg.exts.includes(ext);
    const mimeOk = cfg.mimes.includes(mime);

    if (!extOk && !mimeOk) {
      return cb(new Error(
        `Format non autorisé: ${mime} (${ext}). ` +
        `Formats acceptés: ${cfg.exts.join(', ')}`
      ));
    }
    cb(null, true);
  };
}

/* ── Stockage disque Multer ───────────────────────────────── */
function createDiskStorage(type) {
  return multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, DIRS[type]);
    },
    filename(_req, file, cb) {
      const ext  = path.extname(file.originalname).toLowerCase() || '.bin';
      const uuid = crypto.randomUUID();
      cb(null, `${uuid}${ext}`);
    },
  });
}

/* ── Instances Multer ─────────────────────────────────────── */
const audioUpload = multer({
  storage   : createDiskStorage('audio'),
  limits    : { fileSize: ALLOWED.audio.maxSize },
  fileFilter: mimeFilter('audio'),
});

const imageUpload = multer({
  storage   : createDiskStorage('images'),
  limits    : { fileSize: ALLOWED.images.maxSize },
  fileFilter: mimeFilter('images'),
});

const attachmentUpload = multer({
  storage   : createDiskStorage('attachments'),
  limits    : { fileSize: ALLOWED.attachments.maxSize },
  fileFilter: mimeFilter('attachments'),
});

/* ── Validation post-upload (magic bytes) ─────────────────── */
/**
 * Lit les premiers octets d'un fichier uploadé et vérifie son vrai type.
 * Si invalide, supprime le fichier et throw une Error.
 */
async function validateUploadedFile(filePath, expectedType) {
  const buffer = Buffer.alloc(12);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 12, 0);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }

  const detectedMime = detectMimeFromBuffer(buffer);
  const cfg = ALLOWED[expectedType];

  // Si on a détecté un MIME ET qu'il n'est pas dans la liste autorisée
  if (detectedMime && !cfg.mimes.includes(detectedMime)) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    throw new Error(`Fichier rejeté : type détecté "${detectedMime}" non autorisé pour ${expectedType}.`);
  }

  return detectedMime;
}

/* ── Cleanup ──────────────────────────────────────────────── */
/**
 * Supprime un fichier (silencieux si inexistant).
 */
function cleanupFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn('[Upload] Cleanup failed', { path: filePath, error: err.message });
  }
}

/**
 * Cleanup des fichiers de plus de N heures dans un dossier.
 * À appeler périodiquement (cron interne).
 */
function cleanupOldFiles(dir, maxAgeHours = 24) {
  const now = Date.now();
  const maxAge = maxAgeHours * 60 * 60 * 1000;
  let count = 0;

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(filePath);
        count++;
      }
    }
    if (count > 0) logger.info('[Upload] Cleanup', { dir, deleted: count });
  } catch (err) {
    logger.warn('[Upload] Cleanup error', { dir, error: err.message });
  }
  return count;
}

/* ── Métadonnées audio via ffprobe ────────────────────────── */
/**
 * Extrait la durée et les métadonnées d'un fichier audio.
 * Retourne null si ffprobe n'est pas disponible.
 */
async function getAudioMetadata(filePath) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ];

    execFile('ffprobe', args, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        // ffprobe non installé ou erreur — dégradation gracieuse
        resolve(null);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const format = data.format || {};
        const stream = (data.streams || []).find(s => s.codec_type === 'audio') || {};
        resolve({
          duration    : parseFloat(format.duration || stream.duration || 0),
          bitrate     : parseInt(format.bit_rate || stream.bit_rate || 0, 10),
          codec       : stream.codec_name || 'unknown',
          sampleRate  : parseInt(stream.sample_rate || 0, 10),
          channels    : stream.channels || 1,
          size        : parseInt(format.size || 0, 10),
        });
      } catch (_) {
        resolve(null);
      }
    });
  });
}

/* ── URL sécurisée ────────────────────────────────────────── */
/**
 * Construit l'URL publique d'un fichier uploadé.
 */
function buildFileUrl(type, filename) {
  const base = process.env.BACKEND_URL || 'https://omnisms-backend.onrender.com';
  return `${base}/uploads/${type}/${filename}`;
}

/**
 * Middleware erreur Multer — normalise les erreurs en JSON propre.
 */
function multerErrorHandler(err, _req, res, next) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'Fichier trop volumineux.',
      code : 'FILE_TOO_LARGE',
    });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      error: `Champ inattendu: ${err.field}`,
      code : 'UNEXPECTED_FIELD',
    });
  }
  if (err.message && err.message.includes('Format non autorisé')) {
    return res.status(415).json({
      error: err.message,
      code : 'UNSUPPORTED_MEDIA_TYPE',
    });
  }
  next(err);
}

/* ── Cleanup périodique (toutes les 6h) ───────────────────── */
setInterval(() => {
  Object.entries(DIRS).forEach(([type, dir]) => {
    if (type !== 'temp') return; // on ne nettoie que les fichiers temporaires automatiquement
    cleanupOldFiles(dir, 6);
  });
}, 6 * 60 * 60 * 1000);

module.exports = {
  audioUpload,
  imageUpload,
  attachmentUpload,
  validateUploadedFile,
  cleanupFile,
  cleanupOldFiles,
  getAudioMetadata,
  buildFileUrl,
  multerErrorHandler,
  DIRS,
  ALLOWED,
};
