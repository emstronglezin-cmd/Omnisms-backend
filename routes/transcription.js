'use strict';
/**
 * OmniSMS — Route Transcription Audio
 *
 * Utilise OpenAI Whisper (CLI) installé sur le serveur.
 * Formats acceptés : mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg, flac
 * Taille maximale : 25 MB
 *
 * Endpoint :
 *   POST /transcription/transcribe
 *     - multipart/form-data : champ "audio" (fichier)
 *     - optionnel           : champ "recipient" (numéro E.164 pour envoi SMS)
 *     - optionnel           : champ "language"  (code langue ISO 639-1, ex: "fr")
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { exec } = require('child_process');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Importer sendSms de manière souple (plusieurs noms possibles)
// ─────────────────────────────────────────────────────────────
let sendSmsFunc = null;
try {
  const africasTalking = require('../services/africasTalking');
  sendSmsFunc = africasTalking.sendSms || africasTalking.sendSMS || null;
} catch (e) {
  // africasTalking non disponible — l'envoi SMS sera ignoré
}
if (!sendSmsFunc) {
  try {
    const smsProvider = require('../services/smsProvider');
    sendSmsFunc = smsProvider.sendSMS || smsProvider.sendSms || null;
  } catch (e) {
    // smsProvider non disponible
  }
}

// ─────────────────────────────────────────────────────────────
// Multer — stockage temporaire
// ─────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({
  dest  : UPLOADS_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: function(_req, file, cb) {
    const ALLOWED_MIME = [
      'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a',
      'audio/wav', 'audio/wave', 'audio/x-wav',
      'audio/webm', 'audio/ogg', 'audio/flac',
      'video/mp4', 'video/webm',
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    const ALLOWED_EXT = ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac'];

    if (ALLOWED_MIME.includes(file.mimetype) || ALLOWED_EXT.includes(ext)) {
      return cb(null, true);
    }
    return cb(new Error(`Format audio non supporté : ${file.mimetype}`));
  },
});

// ─────────────────────────────────────────────────────────────
// Helper : nettoyer les fichiers temporaires
// ─────────────────────────────────────────────────────────────
function cleanupFiles(...paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (_) { /* silencieux */ }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Helper : vérifier si Whisper CLI est disponible
// ─────────────────────────────────────────────────────────────
function isWhisperAvailable() {
  try {
    const result = require('child_process').execSync('which whisper 2>/dev/null', { encoding: 'utf8' });
    return result.trim().length > 0;
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// POST /transcription/transcribe
// ─────────────────────────────────────────────────────────────
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier audio fourni. Champ attendu : "audio".' });
  }

  const filePath  = req.file.path;
  const language  = (req.body.language || 'fr').replace(/[^a-zA-Z]/g, '');  // sécuriser
  const recipient = req.body.recipient || null;

  // Vérifier que Whisper est installé
  if (!isWhisperAvailable()) {
    cleanupFiles(filePath);
    return res.status(503).json({
      error  : 'Service de transcription indisponible.',
      detail : 'Whisper n\'est pas installé sur ce serveur.',
      hint   : 'Installez Whisper : pip install openai-whisper',
    });
  }

  // Construire la commande Whisper
  // --output_dir = répertoire uploads, --output_format txt
  const outputDir = UPLOADS_DIR;
  const model     = process.env.WHISPER_MODEL || 'small';
  const cmd = `whisper "${filePath}" --model ${model} --language ${language} --output_format txt --output_dir "${outputDir}" 2>&1`;

  exec(cmd, { timeout: 120000 }, async (err, stdout, stderr) => {
    // Le fichier de transcription généré par Whisper porte le même nom que le fichier d'entrée + .txt
    const transcriptionPath = `${filePath}.txt`;

    if (err) {
      const errMsg = stderr || stdout || err.message;
      console.error('[Transcription] Whisper error:', errMsg);
      cleanupFiles(filePath, transcriptionPath);
      return res.status(500).json({
        error : 'Échec de la transcription audio.',
        detail: process.env.NODE_ENV !== 'production' ? errMsg : undefined,
      });
    }

    if (!fs.existsSync(transcriptionPath)) {
      cleanupFiles(filePath);
      return res.status(500).json({ error: 'Fichier de transcription introuvable après traitement.' });
    }

    const transcription = fs.readFileSync(transcriptionPath, 'utf8').trim();
    cleanupFiles(filePath, transcriptionPath);

    // Optionnel : envoyer la transcription par SMS au destinataire
    if (recipient && sendSmsFunc) {
      try {
        await sendSmsFunc(recipient, transcription);
      } catch (smsErr) {
        console.error('[Transcription] Erreur envoi SMS:', smsErr.message);
        // Ne pas bloquer la réponse si l'envoi SMS échoue
      }
    }

    return res.status(200).json({
      success       : true,
      text          : transcription,
      language      : language,
      model         : model,
      smsSent       : !!(recipient && sendSmsFunc),
      recipientPhone: recipient || null,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// GET /transcription/status
// ─────────────────────────────────────────────────────────────
router.get('/status', function(_req, res) {
  const whisperOk = isWhisperAvailable();
  return res.status(whisperOk ? 200 : 503).json({
    service       : 'OmniSMS Transcription',
    whisperInstalled: whisperOk,
    whisperModel  : process.env.WHISPER_MODEL || 'small',
    maxFileSizeMB : 25,
    formatsAcceptes: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'ogg', 'flac'],
    endpoint      : 'POST /transcription/transcribe  (multipart/form-data, champ "audio")',
    optionnels    : {
      language : 'Code ISO 639-1 (défaut: "fr")',
      recipient: 'Numéro E.164 pour recevoir la transcription par SMS',
    },
  });
});

module.exports = router;
