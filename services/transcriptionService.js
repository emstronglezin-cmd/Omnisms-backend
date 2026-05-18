'use strict';
/**
 * OmniSMS — Service Transcription Audio
 *
 * Utilise Faster-Whisper (Python) via HTTP interne ou subprocess.
 * Aucune dépendance API OpenAI — 100% open source.
 *
 * Architecture :
 *  1. Route Node.js reçoit le fichier audio
 *  2. Job BullMQ créé → addTranscriptionJob()
 *  3. Worker appelle le service Python Faster-Whisper
 *  4. Résultat sauvegardé en Firestore (champ `transcription`)
 *  5. Socket.IO notifie le client en temps réel
 *
 * Config env vars :
 *   WHISPER_SERVICE_URL  → URL du service Python (défaut: http://localhost:9000)
 *   WHISPER_MODEL        → Modèle (tiny, base, small, medium — défaut: small)
 *   WHISPER_LANGUAGE     → Langue par défaut (défaut: fr)
 *   WHISPER_DEVICE       → cpu | cuda (défaut: cpu)
 */

const http  = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');
const { execFile } = require('child_process');
const { logger } = require('../middleware/logger');

const WHISPER_SERVICE_URL = process.env.WHISPER_SERVICE_URL || 'http://localhost:9000';
const WHISPER_MODEL       = process.env.WHISPER_MODEL       || 'small';
const WHISPER_LANGUAGE    = process.env.WHISPER_LANGUAGE    || 'fr';
const WHISPER_DEVICE      = process.env.WHISPER_DEVICE      || 'cpu';

/* ── Vérification disponibilité service Python ────────────── */

/**
 * Ping le service Faster-Whisper HTTP.
 * @returns {Promise<boolean>}
 */
async function isWhisperServiceAvailable() {
  return new Promise((resolve) => {
    const url = new URL(`${WHISPER_SERVICE_URL}/health`);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.get(url.toString(), { timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Vérifie si le CLI whisper (openai-whisper) est disponible en fallback.
 */
function isWhisperCliAvailable() {
  try {
    const result = require('child_process').execSync(
      'which whisper 2>/dev/null || which faster-whisper 2>/dev/null',
      { encoding: 'utf8', timeout: 3000 }
    );
    return result.trim().length > 0;
  } catch (_) {
    return false;
  }
}

/* ── Transcription via service HTTP Python ────────────────── */

/**
 * Envoie un fichier audio au service Faster-Whisper HTTP.
 * Le service Python reçoit le chemin du fichier (volume partagé) ou les bytes.
 *
 * @param {object} options
 * @param {string} options.audioPath   - Chemin absolu du fichier audio
 * @param {string} [options.language]  - Code langue ISO (fr, en, ar, …)
 * @param {string} [options.model]     - tiny | base | small | medium
 * @returns {Promise<{text, language, duration, segments}>}
 */
async function transcribeViaService(options) {
  const { audioPath, language = WHISPER_LANGUAGE, model = WHISPER_MODEL } = options;

  const postData = JSON.stringify({
    audio_path: audioPath,
    language,
    model,
    device: WHISPER_DEVICE,
  });

  return new Promise((resolve, reject) => {
    const url    = new URL(`${WHISPER_SERVICE_URL}/transcribe`);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request({
      hostname: url.hostname,
      port    : url.port,
      path    : url.pathname,
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout : 180000,  // 3 minutes max
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200) {
            reject(new Error(data.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(data);
          }
        } catch (_) {
          reject(new Error('Réponse invalide du service de transcription.'));
        }
      });
    });

    req.on('error',   (err) => reject(err));
    req.on('timeout', ()    => { req.destroy(); reject(new Error('Timeout service transcription.')); });
    req.write(postData);
    req.end();
  });
}

/* ── Transcription via CLI whisper (fallback) ─────────────── */

/**
 * Utilise le CLI whisper comme fallback si le service HTTP est indisponible.
 * @returns {Promise<{text, language}>}
 */
async function transcribeViaCli(audioPath, language = WHISPER_LANGUAGE, model = WHISPER_MODEL) {
  return new Promise((resolve, reject) => {
    const outputDir = path.dirname(audioPath);
    const args = [
      audioPath,
      '--model', model,
      '--language', language,
      '--output_format', 'txt',
      '--output_dir', outputDir,
      '--device', WHISPER_DEVICE,
    ];

    execFile('whisper', args, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || err.message));
      }

      // Whisper génère un .txt avec le même nom que le fichier d'entrée
      const base      = path.basename(audioPath, path.extname(audioPath));
      const txtPath   = path.join(outputDir, base + '.txt');

      if (!fs.existsSync(txtPath)) {
        return reject(new Error('Fichier transcription introuvable après traitement.'));
      }

      const text = fs.readFileSync(txtPath, 'utf8').trim();
      try { fs.unlinkSync(txtPath); } catch (_) {}

      resolve({ text, language, model, segments: [] });
    });
  });
}

/* ── Entrée principale ────────────────────────────────────── */

/**
 * Transcrire un fichier audio.
 * Essaie dans l'ordre :
 *  1. Service HTTP Faster-Whisper
 *  2. CLI whisper (fallback)
 *  3. Erreur si aucun disponible
 *
 * @param {object} options
 * @returns {Promise<{text, language, duration, segments, method}>}
 */
async function transcribe(options) {
  const { audioPath, language = WHISPER_LANGUAGE, model = WHISPER_MODEL } = options;

  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error(`Fichier audio introuvable: ${audioPath}`);
  }

  // 1. Essayer le service HTTP Faster-Whisper
  const serviceOk = await isWhisperServiceAvailable();
  if (serviceOk) {
    logger.info('[Transcription] Using HTTP Faster-Whisper service.', { audioPath, language, model });
    const result = await transcribeViaService({ audioPath, language, model });
    return { ...result, method: 'faster-whisper-http' };
  }

  // 2. Fallback CLI whisper
  const cliOk = isWhisperCliAvailable();
  if (cliOk) {
    logger.info('[Transcription] HTTP service unavailable — using CLI fallback.', { audioPath });
    const result = await transcribeViaCli(audioPath, language, model);
    return { ...result, method: 'whisper-cli' };
  }

  // 3. Aucun service disponible
  throw new Error(
    'Aucun service de transcription disponible. ' +
    'Déployez le service Faster-Whisper Python ou installez whisper CLI.'
  );
}

/**
 * Statut du service transcription.
 */
async function getTranscriptionStatus() {
  const [serviceOk, cliOk] = await Promise.all([
    isWhisperServiceAvailable(),
    Promise.resolve(isWhisperCliAvailable()),
  ]);

  return {
    available    : serviceOk || cliOk,
    httpService  : { url: WHISPER_SERVICE_URL, available: serviceOk },
    cliAvailable : cliOk,
    model        : WHISPER_MODEL,
    language     : WHISPER_LANGUAGE,
    device       : WHISPER_DEVICE,
  };
}

module.exports = {
  transcribe,
  getTranscriptionStatus,
  isWhisperServiceAvailable,
  isWhisperCliAvailable,
};
