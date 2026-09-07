'use strict';
/**
 * OmniSMS — Service SMS Gateway for Android™
 *
 * Intégration avec l'application "SMS Gateway for Android™" (sms-gate.app)
 * installée sur le Samsung Z Fold2.
 *
 * Application identifiée : SMS Gateway for Android™ par capcom6
 *   - Dépôt : https://github.com/capcom6/android-sms-gateway
 *   - Documentation : https://docs.sms-gate.app
 *   - API Cloud : https://api.sms-gate.app/3rdparty/v1
 *
 * ── Architecture ──────────────────────────────────────────────────────────
 *
 * Transport Offline PRINCIPAL :
 *   Backend OmniSMS → SMS Gateway API → Z Fold2 → SIM → réseau SMS → numéro externe
 *
 * Transport Offline STANDBY (Infobip) :
 *   Activé si SMS_GATEWAY_PROVIDER=infobip OU si le Gateway est indisponible
 *   et que OFFLINE_SMS_FALLBACK_TO_INFOBIP=true.
 *
 * ── Modes de connexion ────────────────────────────────────────────────────
 *
 * Mode Cloud (RECOMMANDÉ pour déploiement Render) :
 *   Le Z Fold2 est enregistré sur api.sms-gate.app.
 *   SMS_GATEWAY_API_URL = https://api.sms-gate.app/3rdparty/v1  (défaut)
 *   Accessible depuis internet → compatible Render.
 *
 * Mode Local (non compatible Render sans tunnel) :
 *   SMS_GATEWAY_API_URL = https://192.168.x.x:8080 (IP locale Z Fold2)
 *   Nécessite que le Z Fold2 et le backend soient sur le même réseau.
 *   Sur Render (cloud), nécessite un tunnel Cloudflare ou ngrok.
 *
 * ── Variables d'environnement requises ───────────────────────────────────
 *
 *   SMS_GATEWAY_LOGIN        : Identifiant (onglet Home de l'app sur Z Fold2)
 *   SMS_GATEWAY_PASSWORD     : Mot de passe (onglet Home de l'app sur Z Fold2)
 *   SMS_GATEWAY_DEVICE_ID    : Device ID (affiché dans l'app, onglet Home)
 *   SMS_GATEWAY_API_URL      : URL API (défaut: https://api.sms-gate.app/3rdparty/v1)
 *   SMS_GATEWAY_WEBHOOK_SECRET : Clé HMAC (Settings → Webhooks → Signing Key dans l'app)
 *
 * ── Optionnel ─────────────────────────────────────────────────────────────
 *
 *   OFFLINE_SMS_PROVIDER     : 'sms_gateway' (défaut) ou 'infobip' (standby)
 *   SMS_GATEWAY_SIM_NUMBER   : Numéro du slot SIM (1 ou 2, défaut: 1)
 *   OFFLINE_SMS_FALLBACK_TO_INFOBIP : 'true' pour fallback Infobip si Gateway échoue
 *
 * ── API SMS Gateway for Android™ ─────────────────────────────────────────
 *
 * Envoi SMS :
 *   POST {apiUrl}/messages
 *   Authorization: Basic <base64(login:password)>
 *   Content-Type: application/json
 *   Body: {
 *     textMessage: { text: "..." },
 *     phoneNumbers: ["+22670000000"],
 *     deviceId: "...",        // optionnel
 *     simNumber: 1,           // optionnel (1 ou 2)
 *     ttl: 3600,              // optionnel (expiration en secondes)
 *     withDeliveryReport: true
 *   }
 *
 * Réponse succès (202) :
 *   { id: "abc123", state: "Pending", ... }
 *
 * Webhook entrant (sms:received) :
 *   {
 *     deviceId: "...",
 *     event: "sms:received",
 *     id: "Ey6ECgOkVVFjz3CL48B8C",
 *     webhookId: "LreFUt-Z3sSq0JufY9uWB",
 *     payload: {
 *       messageId: "abc123",
 *       message: "contenu du SMS",
 *       sender: "+22670000000",
 *       recipient: "+22600000000",  // peut être null
 *       simNumber: 1,               // peut être null
 *       receivedAt: "2024-06-22T15:46:11.000+07:00"
 *     }
 *   }
 *
 * Signature HMAC (X-Signature) :
 *   HMAC-SHA256(rawBody + X-Timestamp, signingKey)
 *   X-Timestamp = unix timestamp en secondes
 */

const https = require('https');
const http  = require('http');
const url   = require('url');
const crypto = require('crypto');

const { logger } = require('../middleware/logger');

/* ── Config helpers ─────────────────────────────────────────── */

/**
 * Lire la configuration depuis les variables d'environnement.
 * Ne jamais appeler à l'initialisation du module — toujours lazy.
 */
function getConfig() {
  return {
    login      : process.env.SMS_GATEWAY_LOGIN      || '',
    password   : process.env.SMS_GATEWAY_PASSWORD   || '',
    deviceId   : process.env.SMS_GATEWAY_DEVICE_ID  || null,
    apiUrl     : (process.env.SMS_GATEWAY_API_URL || 'https://api.sms-gate.app/3rdparty/v1').replace(/\/$/, ''),
    simNumber  : parseInt(process.env.SMS_GATEWAY_SIM_NUMBER || '1', 10) || 1,
    signingKey : process.env.SMS_GATEWAY_WEBHOOK_SECRET || '',
  };
}

/**
 * Retourne true si le SMS Gateway est configuré (login + password présents).
 */
function isConfigured() {
  const { login, password } = getConfig();
  return !!(login && password);
}

/**
 * Retourne le provider Offline actif.
 * Valeurs : 'sms_gateway' (défaut) | 'infobip'
 */
function getActiveProvider() {
  return (process.env.OFFLINE_SMS_PROVIDER || 'sms_gateway').toLowerCase().trim();
}

/**
 * Retourne true si le provider actif est sms_gateway.
 */
function isSmsGatewayProvider() {
  return getActiveProvider() === 'sms_gateway';
}

/**
 * Retourne true si le fallback Infobip est activé en cas d'erreur Gateway.
 */
function isInfobipFallbackEnabled() {
  return process.env.OFFLINE_SMS_FALLBACK_TO_INFOBIP === 'true';
}

/* ── HTTP client bas niveau ─────────────────────────────────── */

/**
 * Effectue une requête HTTP/HTTPS vers l'API du SMS Gateway.
 *
 * @param {string} method  - GET | POST | DELETE
 * @param {string} path    - Chemin relatif (ex: '/messages')
 * @param {object|null} payload - Body JSON (ou null)
 * @param {number} [timeoutMs=15000] - Timeout en ms
 * @returns {Promise<{ statusCode: number, body: object }>}
 */
function gatewayRequest(method, path, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const { login, password, apiUrl } = getConfig();

    if (!login || !password) {
      return reject(new Error(
        'SMS Gateway not configured: set SMS_GATEWAY_LOGIN and SMS_GATEWAY_PASSWORD'
      ));
    }

    // Normaliser l'URL de base
    let normalizedUrl = apiUrl.trim();
    if (!normalizedUrl.match(/^https?:\/\//i)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    const parsed  = url.parse(normalizedUrl + path);
    const isHttps = parsed.protocol === 'https:';
    const host    = parsed.hostname;
    const port    = parsed.port
      ? parseInt(parsed.port, 10)
      : (isHttps ? 443 : 80);

    if (!host) {
      return reject(new Error(
        `SMS Gateway: URL invalide — impossible de parser le hostname depuis "${apiUrl}"`
      ));
    }

    const body = payload ? JSON.stringify(payload) : null;

    // Basic Auth : base64(login:password)
    const credentials = Buffer.from(`${login}:${password}`).toString('base64');

    const options = {
      hostname: host,
      port,
      path    : parsed.path,
      method,
      headers : {
        'Authorization' : `Basic ${credentials}`,
        'Content-Type'  : 'application/json',
        'Accept'        : 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    logger.info('[SmsGateway] Request', { method, host, port, path: parsed.path });

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsedBody;
        try   { parsedBody = JSON.parse(data); }
        catch (_) { parsedBody = { raw: data }; }

        logger.info('[SmsGateway] Response', {
          statusCode: res.statusCode,
          body      : JSON.stringify(parsedBody).slice(0, 500),
        });
        resolve({ statusCode: res.statusCode, body: parsedBody });
      });
    });

    req.on('error', (err) => {
      logger.error('[SmsGateway] HTTP error', {
        host, port, path: parsed.path, method,
        error: err.message,
        code : err.code,
        hint : 'Vérifier SMS_GATEWAY_API_URL et que le Z Fold2 est connecté au Cloud',
      });
      reject(err);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`SMS Gateway request timed out after ${timeoutMs}ms`));
    });

    if (body) req.write(body);
    req.end();
  });
}

/* ── Envoi SMS ──────────────────────────────────────────────── */

/**
 * Envoie un SMS via le SMS Gateway (Z Fold2 → SIM → réseau SMS).
 *
 * @param {object} opts
 * @param {string}   opts.to          - Numéro destinataire E.164 (+22670000000)
 * @param {string}   opts.text        - Contenu du SMS
 * @param {string}  [opts.messageId]  - ID optionnel (idempotence côté Gateway)
 * @param {number}  [opts.ttl=3600]   - Expiration en secondes (défaut 1h)
 * @param {boolean} [opts.withDeliveryReport=true] - Demander un DLR
 *
 * @returns {Promise<{
 *   success: boolean,
 *   gatewayMessageId?: string,
 *   state?: string,
 *   error?: string,
 *   code?: string,
 *   provider: 'sms_gateway'
 * }>}
 */
async function sendSMS({ to, text, messageId = null, ttl = 3600, withDeliveryReport = true } = {}) {
  if (!to || !text) {
    throw new Error('SmsGateway.sendSMS: "to" et "text" sont requis');
  }

  if (!isConfigured()) {
    throw new Error(
      'SMS Gateway non configuré — définir SMS_GATEWAY_LOGIN et SMS_GATEWAY_PASSWORD'
    );
  }

  const { deviceId, simNumber } = getConfig();

  // Construction du payload selon l'API SMS Gateway for Android™
  const payload = {
    textMessage: { text },
    phoneNumbers: [to],
    simNumber,
    ttl,
    withDeliveryReport,
    priority: 100,  // haute priorité pour les messages OmniSMS
  };

  // ID personnalisé pour idempotence (évite d'envoyer 2× le même SMS)
  if (messageId) {
    payload.id = `omnisms-${messageId}`;
  }

  // Device ID si configuré (pour cibler spécifiquement le Z Fold2)
  if (deviceId) {
    payload.deviceId = deviceId;
  }

  logger.info('[SmsGateway] Sending SMS', {
    to        : to.replace(/\d{4}$/, '****'),
    textLength: text.length,
    deviceId  : deviceId || '(any)',
    simNumber,
    messageId : messageId || null,
  });

  let response;
  try {
    response = await gatewayRequest('POST', '/messages', payload);
  } catch (err) {
    logger.error('[SmsGateway] HTTP error during sendSMS', {
      error: err.message,
      code : err.code,
      to,
      hint : 'Vérifier SMS_GATEWAY_API_URL, login/password, et que le Z Fold2 est connecté au Cloud',
    });
    return { success: false, error: err.message, code: err.code, provider: 'sms_gateway' };
  }

  const { statusCode, body } = response;

  // 201 Created ou 202 Accepted = succès
  if (statusCode === 201 || statusCode === 202) {
    const gwMessageId = body?.id || null;
    const state       = body?.state || 'Pending';

    logger.info('[SmsGateway] SMS enqueued successfully', {
      to          : to.replace(/\d{4}$/, '****'),
      gwMessageId,
      state,
      statusCode,
    });

    return {
      success         : true,
      gatewayMessageId: gwMessageId,
      messageId       : gwMessageId,  // alias pour compatibilité avec smsQueueWorker
      state,
      provider        : 'sms_gateway',
      raw             : body,
    };
  }

  // Erreurs connues
  const errMsg = body?.message
    || body?.error
    || (body?.errors ? JSON.stringify(body.errors) : null)
    || JSON.stringify(body);

  const hint = statusCode === 401 ? 'Identifiants incorrects — vérifier SMS_GATEWAY_LOGIN et SMS_GATEWAY_PASSWORD'
             : statusCode === 403 ? 'Accès refusé — vérifier les permissions du compte Gateway'
             : statusCode === 404 ? 'Device introuvable — vérifier SMS_GATEWAY_DEVICE_ID'
             : statusCode === 503 ? 'Device hors ligne ou file d\'attente pleine — Z Fold2 déconnecté ?'
             : `Réponse inattendue du Gateway (code ${statusCode})`;

  logger.error('[SmsGateway] SMS send FAILED', {
    to        : to.replace(/\d{4}$/, '****'),
    statusCode,
    error     : errMsg,
    fullBody  : JSON.stringify(body).slice(0, 500),
    loginSet  : !!getConfig().login,
    apiUrl    : getConfig().apiUrl,
    hint,
  });

  return {
    success   : false,
    error     : errMsg,
    statusCode,
    provider  : 'sms_gateway',
    raw       : body,
  };
}

/* ── Vérification du statut d'un message ────────────────────── */

/**
 * Récupère le statut d'un message envoyé via le Gateway.
 *
 * @param {string} gatewayMessageId - ID retourné par sendSMS()
 * @returns {Promise<{ success: boolean, state?: string, error?: string }>}
 */
async function getMessageStatus(gatewayMessageId) {
  if (!isConfigured()) {
    return { success: false, error: 'SMS Gateway non configuré' };
  }
  if (!gatewayMessageId) {
    return { success: false, error: 'gatewayMessageId requis' };
  }

  try {
    const { statusCode, body } = await gatewayRequest(
      'GET', `/messages/${encodeURIComponent(gatewayMessageId)}`, null
    );
    if (statusCode >= 200 && statusCode < 300) {
      return {
        success : true,
        state   : body?.state || 'Unknown',
        raw     : body,
      };
    }
    return {
      success   : false,
      error     : body?.message || JSON.stringify(body),
      statusCode,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* ── Vérification de la signature webhook ───────────────────── */

/**
 * Vérifie la signature HMAC-SHA256 du webhook SMS Gateway.
 *
 * Algorithme :
 *   signature = HMAC-SHA256(rawBody + X-Timestamp, SMS_GATEWAY_WEBHOOK_SECRET)
 *
 * Headers attendus :
 *   X-Signature : signature hexadécimale
 *   X-Timestamp : timestamp Unix en secondes
 *
 * @param {object} req  - Requête Express (req.rawBody ou req.body, req.headers)
 * @returns {boolean}   - true si valide (ou si pas de secret configuré)
 */
function validateWebhookSignature(req) {
  const { signingKey } = getConfig();

  if (!signingKey) {
    // Pas de secret configuré → permissif (log avertissement)
    const enforced = process.env.SMS_GATEWAY_REQUIRE_SIGNATURE === 'true';
    if (enforced) {
      logger.error('[SmsGateway/Webhook] SMS_GATEWAY_REQUIRE_SIGNATURE=true mais SMS_GATEWAY_WEBHOOK_SECRET absent');
    }
    return true;
  }

  const sig       = req.headers['x-signature']  || '';
  const timestamp = req.headers['x-timestamp']  || '';

  if (!sig || !timestamp) {
    const enforced = process.env.SMS_GATEWAY_REQUIRE_SIGNATURE === 'true';
    if (enforced) {
      logger.warn('[SmsGateway/Webhook] Signature ou timestamp manquant — requête REJETÉE (mode strict)');
      return false;
    }
    logger.warn('[SmsGateway/Webhook] Signature ou timestamp manquant (mode permissif)');
    return true;
  }

  // Vérification anti-replay : rejeter les timestamps > 5 minutes
  const nowSec = Math.floor(Date.now() / 1000);
  const tsSec  = parseInt(timestamp, 10);
  if (!isNaN(tsSec) && Math.abs(nowSec - tsSec) > 300) {
    logger.warn('[SmsGateway/Webhook] Timestamp trop ancien — possible replay attack', {
      timestampReceived: tsSec,
      timestampNow     : nowSec,
      diffSeconds      : Math.abs(nowSec - tsSec),
    });
    if (process.env.SMS_GATEWAY_REQUIRE_SIGNATURE === 'true') return false;
  }

  // Calcul HMAC : HMAC-SHA256(rawBody + timestamp, signingKey)
  const rawBody = req.rawBody || (req.body ? JSON.stringify(req.body) : '');
  const message = rawBody + timestamp;

  const expectedSig = crypto
    .createHmac('sha256', signingKey)
    .update(message)
    .digest('hex');

  const sigNorm      = String(sig).trim().toLowerCase();
  const expectedNorm = expectedSig.toLowerCase();

  if (sigNorm.length !== expectedNorm.length) {
    logger.warn('[SmsGateway/Webhook] Longueur signature invalide');
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedNorm, 'hex'),
      Buffer.from(sigNorm,      'hex'),
    );
  } catch (_) {
    logger.warn('[SmsGateway/Webhook] Erreur comparaison signature (format hex invalide ?)');
    return false;
  }
}

/* ── Statut du service ──────────────────────────────────────── */

/**
 * Retourne l'état de configuration du SMS Gateway.
 * Utilisé par les endpoints de health check.
 */
function getStatus() {
  const { login, apiUrl, deviceId, simNumber, signingKey } = getConfig();
  return {
    provider        : 'sms_gateway',
    appName         : 'SMS Gateway for Android™',
    appUrl          : 'https://sms-gate.app',
    configured      : isConfigured(),
    active          : isSmsGatewayProvider(),
    apiUrl          : apiUrl || null,
    hasLogin        : !!login,
    hasDeviceId     : !!deviceId,
    simNumber,
    hasWebhookSecret: !!signingKey,
    infobipFallback : isInfobipFallbackEnabled(),
  };
}

/* ── Exports ────────────────────────────────────────────────── */

module.exports = {
  isConfigured,
  isSmsGatewayProvider,
  isInfobipFallbackEnabled,
  getActiveProvider,
  sendSMS,
  getMessageStatus,
  validateWebhookSignature,
  getStatus,
};
