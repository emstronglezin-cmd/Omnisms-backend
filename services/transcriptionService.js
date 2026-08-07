'use strict';
/**
 * OmniSMS — Service Transcription Audio v2
 *
 * Architecture multi-moteurs (ordre de priorité sur Render) :
 *
 *  1. GROQ Whisper API    → si GROQ_API_KEY configuré
 *                           Modèle : whisper-large-v3-turbo
 *                           Quota gratuit : 28 800 sec audio/mois
 *                           URL : https://api.groq.com
 *                           100% open-source (Whisper de OpenAI)
 *
 *  2. Faster-Whisper HTTP → si WHISPER_SERVICE_URL accessible
 *                           Service Python séparé (localhost:9000 ou externe)
 *
 *  3. Whisper CLI         → si binaire `whisper` ou `faster-whisper` installé
 *
 *  4. Erreur claire       → instructions pour configurer GROQ_API_KEY
 *
 * Variables d'environnement :
 *   GROQ_API_KEY         → Clé API Groq (https://console.groq.com — GRATUIT)
 *   GROQ_WHISPER_MODEL   → whisper-large-v3-turbo | whisper-large-v3 (défaut: turbo)
 *   WHISPER_SERVICE_URL  → URL service Python (ex: http://localhost:9000)
 *   WHISPER_MODEL        → tiny | base | small | medium (défaut: small)
 *   WHISPER_LANGUAGE     → Code ISO 639-1 (défaut: fr)
 *   WHISPER_DEVICE       → cpu | cuda (défaut: cpu)
 */

const http     = require('http');
const https    = require('https');
const path     = require('path');
const fs       = require('fs');
const { execFile } = require('child_process');
const { logger }   = require('../middleware/logger');

// ── Configuration ────────────────────────────────────────────
const GROQ_API_KEY       = () => process.env.GROQ_API_KEY       || '';
const GROQ_MODEL         = () => process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
const WHISPER_SERVICE_URL= () => (process.env.WHISPER_SERVICE_URL || 'http://localhost:9000').replace(/\/$/, '');
const WHISPER_MODEL      = () => process.env.WHISPER_MODEL      || 'small';
const WHISPER_LANGUAGE   = () => process.env.WHISPER_LANGUAGE   || 'fr';
const WHISPER_DEVICE     = () => process.env.WHISPER_DEVICE     || 'cpu';

/* ═══════════════════════════════════════════════════════════════
   MOTEUR 1 — GROQ Whisper API
   Utilise l'endpoint /openai/v1/audio/transcriptions de Groq
   Compatible avec groq-sdk ou implémentation HTTP native
   ═══════════════════════════════════════════════════════════════ */

function isGroqConfigured() {
  return !!GROQ_API_KEY();
}

/**
 * Transcription via Groq Whisper API.
 * Envoie le fichier audio en multipart/form-data.
 */
async function transcribeViaGroq(options) {
  const {
    audioPath,
    language = WHISPER_LANGUAGE(),
    model    = GROQ_MODEL(),
  } = options;

  if (!isGroqConfigured()) {
    throw new Error('GROQ_API_KEY non configuré.');
  }

  if (!fs.existsSync(audioPath)) {
    throw new Error(`Fichier audio introuvable : ${audioPath}`);
  }

  logger.info('[Transcription/Groq] Démarrage', { audioPath, language, model });

  // Construire le multipart/form-data manuellement (pas de dépendance externe)
  const fileBuffer  = fs.readFileSync(audioPath);
  const filename    = path.basename(audioPath);
  const boundary    = `----OmniSMSBoundary${Date.now()}`;

  // Déterminer le Content-Type audio
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    '.mp3' : 'audio/mpeg',
    '.mp4' : 'audio/mp4',
    '.m4a' : 'audio/mp4',
    '.wav' : 'audio/wav',
    '.webm': 'audio/webm',
    '.ogg' : 'audio/ogg',
    '.flac': 'audio/flac',
    '.mpga': 'audio/mpeg',
  };
  const mimeType = mimeMap[ext] || 'audio/mpeg';

  // Construire le body multipart
  const parts = [];

  // Champ file
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  // Champ model
  const modelPart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}`;
  // Champ language
  const langPart  = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}`;
  // Champ response_format
  const fmtPart   = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json`;
  // Fin
  const endPart   = `\r\n--${boundary}--\r\n`;

  const headerBuf  = Buffer.from(parts[0], 'utf8');
  const modelBuf   = Buffer.from(modelPart, 'utf8');
  const langBuf    = Buffer.from(langPart,  'utf8');
  const fmtBuf     = Buffer.from(fmtPart,   'utf8');
  const endBuf     = Buffer.from(endPart,   'utf8');

  const bodyBuffer = Buffer.concat([headerBuf, fileBuffer, modelBuf, langBuf, fmtBuf, endBuf]);

  const groqStart = Date.now();
  logger.info('[Transcription] Groq request started', {
    filename, fileSizeKB: Math.round(fileBuffer.length / 1024),
    mimeType, model, language, bodyBytes: bodyBuffer.length,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.groq.com',
      port    : 443,
      path    : '/openai/v1/audio/transcriptions',
      method  : 'POST',
      headers : {
        'Authorization' : `Bearer ${GROQ_API_KEY()}`,
        'Content-Type'  : `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length,
      },
      timeout: 120000,   // 2 minutes max — suffisant pour Groq
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const durMs = Date.now() - groqStart;
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            const errMsg = parsed?.error?.message || parsed?.message || `HTTP ${res.statusCode}`;
            logger.error('[Transcription] Groq API error', {
              statusCode: res.statusCode, error: errMsg,
              durMs, rawBody: data.substring(0, 300),
            });
            return reject(new Error(`Groq API error (${res.statusCode}): ${errMsg}`));
          }

          const text     = parsed.text || '';
          const language = parsed.language || WHISPER_LANGUAGE();
          const duration = parsed.duration || null;
          const segments = (parsed.segments || []).map(s => ({
            start: s.start, end: s.end, text: s.text,
          }));

          logger.info('[Transcription] Groq response received — success', {
            chars: text.length, language, duration, segments: segments.length, durMs,
          });

          resolve({
            text,
            language,
            duration,
            segments,
            method: 'groq-whisper',
            model : parsed.model || model,
          });
        } catch (parseErr) {
          logger.error('[Transcription] Groq réponse non-JSON', {
            durMs, rawBody: data.substring(0, 300), parseError: parseErr.message,
          });
          reject(new Error(`Groq réponse invalide : ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      const durMs = Date.now() - groqStart;
      logger.error('[Transcription] Groq HTTP error', {
        error: err.message, code: err.code, durMs,
      });
      reject(new Error(`Groq HTTP error : ${err.message}`));
    });
    req.on('timeout', () => {
      const durMs = Date.now() - groqStart;
      logger.error('[Transcription] Groq timeout (120s)', { durMs, filename, fileSizeKB: Math.round(fileBuffer.length / 1024) });
      req.destroy();
      reject(new Error('Groq timeout après 120s. Fichier audio peut-être trop long.'));
    });
    req.write(bodyBuffer);
    req.end();
  });
}

/* ═══════════════════════════════════════════════════════════════
   MOTEUR 2 — Faster-Whisper HTTP service (Python séparé)
   ═══════════════════════════════════════════════════════════════ */

async function isWhisperServiceAvailable() {
  return new Promise((resolve) => {
    const serviceUrl = WHISPER_SERVICE_URL();
    try {
      const url = new URL(`${serviceUrl}/health`);
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url.toString(), { timeout: 3000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error',   () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch (_) {
      resolve(false);
    }
  });
}

async function transcribeViaService(options) {
  const {
    audioPath,
    language = WHISPER_LANGUAGE(),
    model    = WHISPER_MODEL(),
  } = options;

  const postData = JSON.stringify({
    audio_path: audioPath,
    language,
    model,
    device: WHISPER_DEVICE(),
  });

  const serviceUrl = WHISPER_SERVICE_URL();

  return new Promise((resolve, reject) => {
    const url    = new URL(`${serviceUrl}/transcribe`);
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
      timeout : 180000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200) {
            return reject(new Error(data.error || `HTTP ${res.statusCode}`));
          }
          resolve({ ...data, method: 'faster-whisper-http' });
        } catch (_) {
          reject(new Error('Réponse invalide du service Faster-Whisper.'));
        }
      });
    });

    req.on('error',   err => reject(err));
    req.on('timeout', ()  => { req.destroy(); reject(new Error('Timeout Faster-Whisper service (180s).')); });
    req.write(postData);
    req.end();
  });
}

/* ═══════════════════════════════════════════════════════════════
   MOTEUR 3 — Whisper / Faster-Whisper CLI
   ═══════════════════════════════════════════════════════════════ */

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

async function transcribeViaCli(audioPath, language = WHISPER_LANGUAGE(), model = WHISPER_MODEL()) {
  return new Promise((resolve, reject) => {
    const outputDir = path.dirname(audioPath);
    const args = [
      audioPath,
      '--model',         model,
      '--language',      language,
      '--output_format', 'txt',
      '--output_dir',    outputDir,
      '--device',        WHISPER_DEVICE(),
    ];

    execFile('whisper', args, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || err.message));
      }
      const base    = path.basename(audioPath, path.extname(audioPath));
      const txtPath = path.join(outputDir, base + '.txt');
      if (!fs.existsSync(txtPath)) {
        return reject(new Error('Fichier transcription introuvable après CLI.'));
      }
      const text = fs.readFileSync(txtPath, 'utf8').trim();
      try { fs.unlinkSync(txtPath); } catch (_) {}
      resolve({ text, language, model, segments: [], method: 'whisper-cli' });
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   POINT D'ENTRÉE PRINCIPAL
   ═══════════════════════════════════════════════════════════════ */

/**
 * Transcrire un fichier audio.
 * Essaie les moteurs dans l'ordre : Groq → Faster-Whisper HTTP → CLI → Erreur
 *
 * @param {object} options
 * @param {string} options.audioPath   - Chemin absolu du fichier audio
 * @param {string} [options.language]  - Code langue ISO (fr, en, ar, …)
 * @param {string} [options.model]     - Modèle Whisper (small, medium, …)
 * @returns {Promise<{text, language, duration, segments, method}>}
 */
async function transcribe(options) {
  const { audioPath, language = WHISPER_LANGUAGE(), model = WHISPER_MODEL() } = options;

  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error(`Fichier audio introuvable : ${audioPath}`);
  }

  const errors = [];

  // ── 1. Groq Whisper API (priorité) ──────────────────────────
  if (isGroqConfigured()) {
    try {
      logger.info('[Transcription] Using Groq Whisper API.', { audioPath, language });
      const result = await transcribeViaGroq({ audioPath, language });
      return result;
    } catch (groqErr) {
      logger.warn('[Transcription] Groq failed — trying next engine.', { error: groqErr.message });
      errors.push(`Groq: ${groqErr.message}`);
    }
  } else {
    errors.push('Groq: GROQ_API_KEY non configuré.');
  }

  // ── 2. Faster-Whisper HTTP service ───────────────────────────
  const serviceOk = await isWhisperServiceAvailable();
  if (serviceOk) {
    try {
      logger.info('[Transcription] Using Faster-Whisper HTTP service.', { audioPath });
      const result = await transcribeViaService({ audioPath, language, model });
      return result;
    } catch (fwErr) {
      logger.warn('[Transcription] Faster-Whisper HTTP failed.', { error: fwErr.message });
      errors.push(`Faster-Whisper HTTP: ${fwErr.message}`);
    }
  } else {
    errors.push(`Faster-Whisper HTTP: service indisponible sur ${WHISPER_SERVICE_URL()}`);
  }

  // ── 3. CLI whisper (fallback final) ──────────────────────────
  const cliOk = isWhisperCliAvailable();
  if (cliOk) {
    try {
      logger.info('[Transcription] Using Whisper CLI fallback.', { audioPath });
      const result = await transcribeViaCli(audioPath, language, model);
      return result;
    } catch (cliErr) {
      logger.warn('[Transcription] CLI fallback failed.', { error: cliErr.message });
      errors.push(`Whisper CLI: ${cliErr.message}`);
    }
  } else {
    errors.push('Whisper CLI: non installé.');
  }

  // ── Aucun moteur disponible ──────────────────────────────────
  const fullError = [
    'Aucun moteur de transcription disponible.',
    ...errors,
    '→ Solution: configurez GROQ_API_KEY dans Render (gratuit sur https://console.groq.com)',
  ].join(' | ');

  throw new Error(fullError);
}

/* ═══════════════════════════════════════════════════════════════
   STATUT DU SERVICE
   ═══════════════════════════════════════════════════════════════ */

async function getTranscriptionStatus() {
  const groqOk = isGroqConfigured();
  const cliOk  = isWhisperCliAvailable();

  let serviceOk = false;
  try {
    serviceOk = await isWhisperServiceAvailable();
  } catch (_) {}

  const available = groqOk || serviceOk || cliOk;

  // Identifier le moteur actif
  let activeEngine = null;
  let activeEngineDetails = null;
  if (groqOk) {
    activeEngine = 'groq-whisper';
    activeEngineDetails = {
      model      : GROQ_MODEL(),
      description: 'Groq Whisper API — ultra-rapide, gratuit 28 800 sec/mois',
      configured : true,
    };
  } else if (serviceOk) {
    activeEngine = 'faster-whisper-http';
    activeEngineDetails = {
      url        : WHISPER_SERVICE_URL(),
      model      : WHISPER_MODEL(),
      description: 'Faster-Whisper service Python HTTP',
      configured : true,
    };
  } else if (cliOk) {
    activeEngine = 'whisper-cli';
    activeEngineDetails = {
      model      : WHISPER_MODEL(),
      description: 'Whisper CLI local',
      configured : true,
    };
  }

  return {
    available,
    activeEngine,
    activeEngineDetails,
    engines: {
      groq: {
        available    : groqOk,
        model        : GROQ_MODEL(),
        configured   : groqOk,
        hint         : groqOk ? 'GROQ_API_KEY configuré ✅' : 'Configurez GROQ_API_KEY (gratuit sur https://console.groq.com)',
        quotaFree    : '28 800 secondes audio / mois',
        languages    : 'fr, en, ar, es, pt, de, it, zh, ja, ko, …',
      },
      fasterWhisperHttp: {
        available    : serviceOk,
        url          : WHISPER_SERVICE_URL(),
        model        : WHISPER_MODEL(),
        hint         : serviceOk ? 'Service Python accessible ✅' : `Service inaccessible sur ${WHISPER_SERVICE_URL()}`,
      },
      whisperCli: {
        available    : cliOk,
        model        : WHISPER_MODEL(),
        hint         : cliOk ? 'CLI disponible ✅' : 'Installez: pip install openai-whisper',
      },
    },
    language     : WHISPER_LANGUAGE(),
    device       : WHISPER_DEVICE(),
    setupGuide   : available ? null : {
      recommended: 'Groq Whisper API (gratuit)',
      steps      : [
        '1. Créez un compte sur https://console.groq.com (gratuit)',
        '2. Générez une API key dans Settings → API Keys',
        '3. Dans Render → Settings → Environment Variables → ajoutez GROQ_API_KEY=gsk_...',
        '4. Redéployez le service',
      ],
    },
  };
}

module.exports = {
  transcribe,
  getTranscriptionStatus,
  isGroqConfigured,
  isWhisperServiceAvailable,
  isWhisperCliAvailable,
  transcribeViaGroq,
};
