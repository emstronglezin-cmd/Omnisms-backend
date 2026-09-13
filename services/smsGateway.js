'use strict';
/**
 * OmniSMS — Service SMS Gateway (INfiniReach)
 *
 * Transport physique SMS principal du mode Offline :
 *   Backend OmniSMS → INfiniReach API → Z Fold2 Android → SIM → réseau SMS
 *
 * Fournisseur : INfiniReach (https://api.infinireach.io)
 * Le Z Fold2 est enregistré et connecté dans l'application Android INfiniReach.
 *
 * ── API Envoi SMS ─────────────────────────────────────────────────────────
 *
 * POST https://api.infinireach.io/api/v1/messages
 * Headers :
 *   X-API-Key    : ${INFINIREACH_API_KEY}
 *   Content-Type : application/json
 * Body :
 *   {
 *     "to"         : "+22670000000",
 *     "message"    : "texte du SMS",
 *     "from"       : "+22600000000",   // numéro SIM du Z Fold2, obligatoire
 *     "channel"    : "sms",
 *     "externalId" : "omnisms-xxx"     // ID OmniSMS pour idempotence
 *   }
 * Réponse succès (200/201/202) :
 *   { id: "ir-xxx", status: "queued"|"sent", ... }
 *
 * ── Webhook SMS entrant ───────────────────────────────────────────────────
 *
 * INfiniReach envoie :
 *   POST /api/webhooks/sms-gateway/inbound
 *   {
 *     "event"    : "message.inbound",
 *     "timestamp": "...",
 *     "data"     : {
 *       "messageId" : "...",
 *       "direction" : "inbound",
 *       "from"      : "+22670000000",
 *       "to"        : "+22600000000",
 *       "body"      : "texte du SMS",
 *       "deviceId"  : "...",
 *       "timestamp" : "...",
 *       "status"    : "delivered"
 *     }
 *   }
 *
 * Événements DLR (statuts sortants) :
 *   message.sent, message.delivered, message.failed
 *
 * ── Variables d'environnement ─────────────────────────────────────────────
 *
 *   INFINIREACH_API_KEY    (requis) — Clé API INfiniReach
 *   INFINIREACH_FROM_NUMBER (requis) — Numéro SIM du Z Fold2 (champ "from", obligatoire)
 *   INFINIREACH_API_URL    (optionnel, défaut: https://api.infinireach.io)
 *   INFINIREACH_ENABLED    (optionnel, défaut: true)
 *
 *   Sélection transport :
 *   OFFLINE_SMS_PROVIDER           : 'sms_gateway' (défaut) | 'infobip'
 *   OFFLINE_SMS_FALLBACK_TO_INFOBIP: 'true' pour fallback Infobip sur échec
 *
 * ── Compatibilité avec l'architecture existante ───────────────────────────
 *
 * Ce module expose la même interface que l'ancien service sms-gate.app :
 *   isConfigured(), isSmsGatewayProvider(), isInfobipFallbackEnabled()
 *   sendSMS({ to, text, messageId }) → { success, gatewayMessageId, provider }
 *   validateWebhookSignature(req)
 *   getStatus()
 *
 * messageRouter.js et smsQueueWorker.js utilisent cette interface via
 * selectTransport() — aucune modification de ces fichiers n'est nécessaire.
 */

const https  = require('https');
const http   = require('http');
const urlMod = require('url');
const crypto = require('crypto');

const { logger } = require('../middleware/logger');

/* ── Config helpers ─────────────────────────────────────────── */

/**
 * Lecture lazy de la configuration (jamais au require-time).
 * NE JAMAIS logger apiKey ou secret.
 */
function getConfig() {
  return {
    apiKey    : process.env.INFINIREACH_API_KEY      || '',
    fromNumber: process.env.INFINIREACH_FROM_NUMBER  || '',
    apiUrl    : (process.env.INFINIREACH_API_URL || 'https://api.infinireach.io').replace(/\/$/, ''),
    enabled   : process.env.INFINIREACH_ENABLED !== 'false', // true par défaut
    webhookSecret: process.env.INFINIREACH_WEBHOOK_SECRET || '',
  };
}

/**
 * Retourne true si INfiniReach est configuré (apiKey + fromNumber présents).
 */
function isConfigured() {
  const { apiKey, fromNumber, enabled } = getConfig();
  return !!(enabled && apiKey && fromNumber);
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
 * (INfiniReach hérite de ce nom — le routing existant est inchangé.)
 */
function isSmsGatewayProvider() {
  return getActiveProvider() === 'sms_gateway';
}

/**
 * Retourne true si le fallback Infobip est activé en cas d'erreur.
 */
function isInfobipFallbackEnabled() {
  return process.env.OFFLINE_SMS_FALLBACK_TO_INFOBIP === 'true';
}

/* ── Diagnostic de démarrage ────────────────────────────────── */

/**
 * Émet des logs de démarrage sûrs pour diagnostiquer la configuration INfiniReach.
 * Appelé UNE SEULE FOIS depuis server.js au démarrage.
 * Ne logue JAMAIS la valeur réelle de apiKey ou webhookSecret.
 */
function logStartupDiagnostic() {
  const { apiKey, fromNumber, apiUrl, enabled, webhookSecret } = getConfig();
  const provider = getActiveProvider();
  const isGw     = isSmsGatewayProvider();
  const cfg      = isConfigured();

  logger.info('[InfiniReach] ── Configuration au démarrage ─────────────────────────');
  logger.info(`[InfiniReach] enabled          : ${enabled ? 'YES' : 'NO'}`);
  logger.info(`[InfiniReach] INFINIREACH_API_KEY     : ${apiKey      ? 'CONFIGURED' : 'MISSING ⚠️'}`);
  logger.info(`[InfiniReach] INFINIREACH_FROM_NUMBER : ${fromNumber  ? 'CONFIGURED (' + fromNumber.replace(/\d{4}$/, '****') + ')' : 'MISSING ⚠️'}`);
  logger.info(`[InfiniReach] INFINIREACH_API_URL     : ${apiUrl      || 'https://api.infinireach.io (défaut)'}`);
  logger.info(`[InfiniReach] INFINIREACH_WEBHOOK_SECRET : ${webhookSecret ? 'CONFIGURED' : 'non défini (mode permissif)'}`);
  logger.info('[Offline SMS] ──────────────────────────────────────────────────────');
  logger.info(`[Offline SMS] OFFLINE_SMS_PROVIDER           : ${provider} (${isGw ? 'INfiniReach' : 'autre'})`);
  logger.info(`[Offline SMS] OFFLINE_SMS_FALLBACK_TO_INFOBIP: ${isInfobipFallbackEnabled() ? 'true (fallback Infobip actif)' : 'false (Infobip désactivé pendant test INfiniReach)'}`);
  logger.info(`[Offline SMS] Transport résolu : ${isGw ? 'INfiniReach Z Fold2' : 'Infobip standby ou aucun'}`);
  logger.info(`[Offline SMS] isConfigured()   : ${cfg ? 'YES ✅' : 'NO ❌ — vérifier INFINIREACH_API_KEY + INFINIREACH_FROM_NUMBER'}`);
  logger.info('[InfiniReach] ──────────────────────────────────────────────────────');

  if (!cfg) {
    logger.warn('[InfiniReach] Transport INfiniReach NON opérationnel. Vérifier les variables d\'environnement sur Render.');
  }
}

/* ── Client HTTP bas niveau ─────────────────────────────────── */

/**
 * Effectue une requête HTTPS/HTTP vers l'API INfiniReach.
 * Ne logge JAMAIS la clé API.
 *
 * @param {string} method         - GET | POST
 * @param {string} path           - Chemin (ex: '/api/v1/messages')
 * @param {object|null} payload   - Body JSON ou null
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<{ statusCode: number, body: object }>}
 */
function infiniReachRequest(method, path, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const { apiKey, apiUrl } = getConfig();

    if (!apiKey) {
      return reject(new Error(
        '[INfiniReach] Non configuré : INFINIREACH_API_KEY manquant'
      ));
    }

    let normalizedUrl = apiUrl.trim();
    if (!normalizedUrl.match(/^https?:\/\//i)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    const parsed  = urlMod.parse(normalizedUrl + path);
    const isHttps = parsed.protocol === 'https:';
    const host    = parsed.hostname;
    const port    = parsed.port
      ? parseInt(parsed.port, 10)
      : (isHttps ? 443 : 80);

    if (!host) {
      return reject(new Error(
        `[INfiniReach] URL invalide — hostname introuvable dans "${apiUrl}"`
      ));
    }

    const body = payload ? JSON.stringify(payload) : null;

    const options = {
      hostname: host,
      port,
      path    : parsed.path,
      method,
      headers : {
        'X-API-Key'    : apiKey,    // jamais loggé, uniquement dans headers
        'Content-Type' : 'application/json',
        'Accept'       : 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    logger.info('[INfiniReach] send:start', {
      method,
      host,
      path: parsed.path,
      // NE PAS inclure apiKey ici
    });

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsedBody;
        try   { parsedBody = JSON.parse(data); }
        catch (_) { parsedBody = { raw: data }; }

        resolve({ statusCode: res.statusCode, body: parsedBody });
      });
    });

    req.on('error', (err) => {
      logger.error('[INfiniReach] send:error', {
        host,
        path   : parsed.path,
        method,
        error  : err.message,
        code   : err.code,
        hint   : 'Vérifier INFINIREACH_API_URL et la connectivité réseau',
      });
      reject(err);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`[INfiniReach] Timeout après ${timeoutMs}ms`));
    });

    if (body) req.write(body);
    req.end();
  });
}

/* ── Envoi SMS ──────────────────────────────────────────────── */

/**
 * Envoie un SMS via INfiniReach → Z Fold2 → SIM → réseau SMS.
 *
 * @param {object} opts
 * @param {string}  opts.to         - Numéro destinataire E.164 (+22670000000)
 * @param {string}  opts.text       - Contenu du SMS
 * @param {string} [opts.messageId] - ID OmniSMS (idempotence via externalId)
 *
 * @returns {Promise<{
 *   success: boolean,
 *   gatewayMessageId?: string,
 *   messageId?: string,
 *   state?: string,
 *   provider: 'sms_gateway',
 *   error?: string,
 *   statusCode?: number
 * }>}
 */
async function sendSMS({ to, text, messageId = null } = {}) {
  if (!to || !text) {
    throw new Error('[INfiniReach] sendSMS: "to" et "text" sont requis');
  }

  if (!isConfigured()) {
    throw new Error(
      '[INfiniReach] Non configuré — définir INFINIREACH_API_KEY et INFINIREACH_FROM_NUMBER'
    );
  }

  const { fromNumber } = getConfig();

  // Payload INfiniReach — tous les champs selon spec
  const payload = {
    to,
    message : text,
    from    : fromNumber,   // numéro SIM Z Fold2, champ obligatoire
    channel : 'sms',
  };

  // externalId pour idempotence (évite d'envoyer deux fois le même SMS)
  if (messageId) {
    payload.externalId = `omnisms-${messageId}`;
  }

  logger.info('[INfiniReach] send:start', {
    to        : to.replace(/\d{4}$/, '****'),
    from      : fromNumber.replace(/\d{4}$/, '****'),
    textLength: text.length,
    externalId: messageId ? `omnisms-${messageId}` : null,
  });

  let response;
  try {
    response = await infiniReachRequest('POST', '/api/v1/messages', payload);
  } catch (err) {
    logger.error('[INfiniReach] send:error', {
      error: err.message,
      code : err.code,
      to   : to.replace(/\d{4}$/, '****'),
      hint : 'Vérifier INFINIREACH_API_KEY, INFINIREACH_FROM_NUMBER et INFINIREACH_API_URL',
    });
    return { success: false, error: err.message, code: err.code, provider: 'sms_gateway' };
  }

  const { statusCode, body } = response;

  // 200/201/202 = succès
  if (statusCode >= 200 && statusCode < 300) {
    const gwMessageId = body?.id || body?.messageId || null;
    const state       = body?.status || body?.state || 'queued';

    logger.info('[INfiniReach] send:success', {
      to          : to.replace(/\d{4}$/, '****'),
      gwMessageId,
      state,
      statusCode,
    });

    return {
      success         : true,
      gatewayMessageId: gwMessageId,
      messageId       : gwMessageId,  // alias pour compatibilité smsQueueWorker
      state,
      provider        : 'sms_gateway',
      raw             : body,
    };
  }

  // Erreurs
  const errMsg = body?.message
    || body?.error
    || (body?.errors ? JSON.stringify(body.errors) : null)
    || body?.raw
    || JSON.stringify(body);

  const hint = statusCode === 401
    ? 'Clé API invalide — vérifier INFINIREACH_API_KEY dans Render'
    : statusCode === 404
    ? `Device non trouvé — vérifier que INFINIREACH_FROM_NUMBER (${fromNumber}) est bien enregistré dans l'application INfiniReach sur le Z Fold2. Le numéro SIM doit correspondre exactement au device enregistré dans votre compte INfiniReach.`
    : statusCode === 400
    ? 'Payload invalide — vérifier INFINIREACH_FROM_NUMBER et le format du numéro (E.164 : +22675405214)'
    : statusCode === 429
    ? 'Rate limit atteint — réessai automatique via BullMQ'
    : statusCode === 503
    ? 'Service INfiniReach indisponible ou Z Fold2 hors ligne / déconnecté'
    : `Réponse inattendue INfiniReach (code ${statusCode})`;

  logger.error('[INfiniReach] send:error', {
    to        : to.replace(/\d{4}$/, '****'),
    statusCode,
    error     : errMsg,
    apiUrlSet : !!getConfig().apiUrl,
    fromSet   : !!getConfig().fromNumber,
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

/* ── Statut d'un message sortant ────────────────────────────── */

/**
 * Récupère le statut d'un message envoyé.
 * (Utilisé par getMessageStatus dans l'ancien service — conservé pour compatibilité)
 *
 * @param {string} gatewayMessageId - ID retourné par sendSMS()
 * @returns {Promise<{ success: boolean, state?: string, error?: string }>}
 */
async function getMessageStatus(gatewayMessageId) {
  if (!isConfigured()) {
    return { success: false, error: '[INfiniReach] Non configuré' };
  }
  if (!gatewayMessageId) {
    return { success: false, error: 'gatewayMessageId requis' };
  }

  try {
    const { statusCode, body } = await infiniReachRequest(
      'GET', `/api/v1/messages/${encodeURIComponent(gatewayMessageId)}`, null
    );
    if (statusCode >= 200 && statusCode < 300) {
      return {
        success: true,
        state  : body?.status || body?.state || 'Unknown',
        raw    : body,
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

/* ── Validation signature webhook ───────────────────────────── */

/**
 * Valide la signature HMAC du webhook INfiniReach (si configurée).
 *
 * INfiniReach n'utilise pas encore de signing secret pour ce premier test.
 * Cette fonction est conservée pour la compatibilité avec l'architecture existante
 * et pour une activation future (INFINIREACH_WEBHOOK_SECRET).
 *
 * Sans secret configuré → retourne toujours true (mode permissif).
 * Avec secret → HMAC-SHA256(rawBody, secret).
 *
 * @param {object} req - Requête Express
 * @returns {boolean}
 */
function validateWebhookSignature(req) {
  const { webhookSecret } = getConfig();

  if (!webhookSecret) {
    // Pas de secret configuré → permissif (cas initial INfiniReach)
    const enforced = process.env.INFINIREACH_REQUIRE_SIGNATURE === 'true';
    if (enforced) {
      logger.error('[INfiniReach] webhook:invalid INFINIREACH_REQUIRE_SIGNATURE=true mais INFINIREACH_WEBHOOK_SECRET absent');
    }
    return true;
  }

  // Lire la signature depuis l'en-tête (INfiniReach peut utiliser X-Signature ou similaire)
  const sig = req.headers['x-signature']
    || req.headers['x-infinireach-signature']
    || '';

  if (!sig) {
    const enforced = process.env.INFINIREACH_REQUIRE_SIGNATURE === 'true';
    if (enforced) {
      logger.warn('[INfiniReach] webhook:invalid Signature manquante (mode strict)');
      return false;
    }
    logger.warn('[INfiniReach] webhook:invalid Signature manquante (mode permissif)');
    return true;
  }

  const rawBody = req.rawBody || (req.body ? JSON.stringify(req.body) : '');
  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  const sigNorm      = String(sig).trim().toLowerCase().replace(/^sha256=/, '');
  const expectedNorm = expectedSig.toLowerCase();

  if (sigNorm.length !== expectedNorm.length) {
    logger.warn('[INfiniReach] webhook:invalid Longueur signature incorrecte');
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedNorm, 'hex'),
      Buffer.from(sigNorm,      'hex'),
    );
  } catch (_) {
    logger.warn('[INfiniReach] webhook:invalid Format hex invalide');
    return false;
  }
}

/* ── Statut du service ──────────────────────────────────────── */

/**
 * Retourne l'état de configuration pour le health check.
 * Ne jamais inclure apiKey dans la réponse.
 */
function getStatus() {
  const { apiUrl, fromNumber, webhookSecret, enabled } = getConfig();
  return {
    provider        : 'sms_gateway',
    implementation  : 'INfiniReach',
    appUrl          : 'https://api.infinireach.io',
    configured      : isConfigured(),
    active          : isSmsGatewayProvider(),
    enabled,
    apiUrl          : apiUrl || null,
    hasApiKey       : !!getConfig().apiKey,
    hasFromNumber   : !!fromNumber,
    fromNumber      : fromNumber ? fromNumber.replace(/\d{4}$/, '****') : null,
    hasWebhookSecret: !!webhookSecret,
    infobipFallback : isInfobipFallbackEnabled(),
  };
}

/* ── Exports ─────────────────────────────────────────────────── */
// Interface identique à l'ancien service sms-gate.app :
// messageRouter.js et smsQueueWorker.js restent inchangés.

module.exports = {
  isConfigured,
  isSmsGatewayProvider,
  isInfobipFallbackEnabled,
  getActiveProvider,
  sendSMS,
  getMessageStatus,
  validateWebhookSignature,
  getStatus,
  logStartupDiagnostic,
};
