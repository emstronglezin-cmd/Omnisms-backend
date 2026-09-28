'use strict';
/**
 * OmniSMS — Service SaaSPay
 * ═══════════════════════════════════════════════════════════════
 *
 * Client HTTP pour l'API SasPay.
 * Documentation officielle : https://docs.saspay.me
 *
 * Endpoint de création :
 *   POST https://api.saspay.me/api/v1/checkout-sessions/
 *   Authorization: Bearer sk_live_xxx
 *   Réponse : { id, checkout_url, status, amount, currency, expires_at, ... }
 *
 * Endpoint de statut :
 *   GET https://api.saspay.me/api/v1/checkout-sessions/:id/
 *   Authorization: Bearer sk_live_xxx
 *   Réponse : { id, status, amount, currency, paid_at, ... }
 *   status = "paid" quand payé
 *
 * Variables d'environnement :
 *   SAASPAY_SECRET_KEY     → sk_live_xxx  (clé API SasPay / Bearer — requis)
 *   SAASPAY_API_KEY        → legacy seulement; SasPay webhook utilise SAASPAY_WEBHOOK_SECRET
 *   SAASPAY_BASE_URL       → https://api.saspay.me (défaut)
 *   SAASPAY_WEBHOOK_SECRET → signing_secret fourni par SasPay (webhook)
 */

const axios  = require('axios');
const crypto = require('crypto');
const { logger } = require('../middleware/logger');
const { normalizePaymentEnv, getPaymentEnvStatus, maskSecret } = require('../config/paymentEnv');

/* ── Configuration ───────────────────────────────────────────────
   La clé API secrète est l'unique identifiant requis pour l'API SasPay.
   Les identifiants LEEKPAY_* ne sont jamais utilisés comme fallback.
   Aucune valeur secrète n'est journalisée.
──────────────────────────────────────────────────────────────── */
normalizePaymentEnv({ logger });

/* ── Constantes ──────────────────────────────────────────────── */
const SAASPAY_BASE_URL  = (process.env.SAASPAY_BASE_URL || 'https://api.saspay.me').replace(/\/$/, '');
const SAASPAY_TIMEOUT   = 25_000;   // 25 s
const MAX_RETRIES       = 2;
const RETRY_DELAY_MS    = 1_000;

const PREMIUM_AMOUNT   = parseInt(process.env.SAASPAY_PREMIUM_AMOUNT, 10) || 2000;
const PREMIUM_CURRENCY = (process.env.SAASPAY_PREMIUM_CURRENCY || 'XOF').toUpperCase();

const ALLOWED_CURRENCIES = ['XOF', 'EUR', 'USD', 'GHS', 'KES', 'NGN'];
const MIN_AMOUNTS        = { XOF: 100, EUR: 1, USD: 1, GHS: 1, KES: 1, NGN: 100 };

/* ── Helpers ─────────────────────────────────────────────────── */

function resolveKeys() {
  const secretKey = (process.env.SAASPAY_SECRET_KEY || '').trim();
  if (!secretKey) throw new Error('SAASPAY_SECRET_KEY manquante (sk_live_xxx).');
  return { secretKey };
}

function isConfigured() {
  return !!(process.env.SAASPAY_SECRET_KEY || '').trim();
}

function buildHeaders() {
  const { secretKey } = resolveKeys();
  return {
    'Authorization': `Bearer ${secretKey}`,
    'Content-Type' : 'application/json',
    'Accept'       : 'application/json',
    'User-Agent'   : 'OmniSMS-Backend/5.0',
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// JSON diagnostics must tolerate absent/non-serializable bodies.
function safeJson(value, maxLength = 500) {
  if (value === undefined) return '[no response body]';
  try {
    const text = JSON.stringify(maskSensitiveFields(value));
    return (text === undefined ? String(value) : text).slice(0, maxLength);
  } catch (_) {
    return '[unserializable response body]';
  }
}

function responseShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value !== 'object') return typeof value;
  return Object.keys(value).slice(0, 30);
}

/**
 * Masque toute valeur sensible dans un objet destiné aux logs
 * (clé, secret, token, signature, authorization…).
 * Utilisé pour ne JAMAIS écrire une clé API complète dans les logs.
 */
function maskSensitiveFields(input, depth = 0) {
  if (depth > 4 || input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map(v => maskSensitiveFields(v, depth + 1));
  if (typeof input !== 'object') return input;

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (/key|secret|token|signature|authorization|password/i.test(key)) {
      out[key] = typeof value === 'string' ? maskSecret(value) : '[REDACTED]';
    } else {
      out[key] = maskSensitiveFields(value, depth + 1);
    }
  }
  return out;
}

/**
 * Résumé de configuration sûr (aucun secret) pour les diagnostics.
 * @returns {object}
 */
function getConfigStatus() {
  const status = getPaymentEnvStatus();
  return {
    provider      : status.provider,
    configured    : status.configured,
    baseUrl       : status.baseUrl,
    secretKey     : status.required.SAASPAY_SECRET_KEY,
    apiKey        : status.optional.SAASPAY_API_KEY,
    webhookSecret : status.optional.SAASPAY_WEBHOOK_SECRET,
    backendUrl    : status.optional.BACKEND_URL,
    frontendUrl   : status.optional.FRONTEND_URL,
    missingRequired: status.missingRequired,
    legacyPresent : status.legacyPresent,
    legacyApplied : status.legacyApplied,
    premiumAmount : PREMIUM_AMOUNT,
    premiumCurrency: PREMIUM_CURRENCY,
    webhookUrl    : `${(process.env.BACKEND_URL || 'https://omnisms-backend.onrender.com').replace(/\/$/, '')}${status.webhookPath}`,
  };
}

async function withRetry(fn, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status     = err.response?.status;
      const isRetryable = !status || status === 429 || status >= 500;
      if (!isRetryable || attempt >= retries) break;
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
      logger.warn(`[SaaSPay] Retry ${attempt + 1}/${retries} dans ${delay}ms (status ${status || 'network'})`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function validateAmount(amount, currency) {
  const amt  = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0)
    throw new Error(`Montant invalide : ${amount}.`);
  const curr = (currency || '').toUpperCase();
  if (!ALLOWED_CURRENCIES.includes(curr))
    throw new Error(`Devise non supportée : ${currency}. Acceptées : ${ALLOWED_CURRENCIES.join(', ')}.`);
  const minAmt = MIN_AMOUNTS[curr] || 1;
  if (amt < minAmt)
    throw new Error(`Montant minimum pour ${curr} : ${minAmt}. Reçu : ${amt}.`);
}

/* ── Extraire les données de la réponse SasPay ──────────────── */
// La réponse officielle est directe; l'enveloppe { data: ... } reste tolérée.

function extractData(responseData) {
  if (!responseData) return null;
  // Cas 1 : { data: { ... } }  ← format officiel
  if (responseData.data && typeof responseData.data === 'object') {
    return responseData.data;
  }
  // Cas 2 : l'objet directement (sans wrapper)
  return responseData;
}

/* ═══════════════════════════════════════════════════════════════
   API 1 — Créer un checkout
   POST /api/v1/checkout-sessions/
   Authorization: Bearer sk_live_xxx
   Réponse officielle : { id, checkout_url, status, expires_at, amount, currency }
══════════════════════════════════════════════════════════════════ */
/**
 * @param {object} params
 * @param {number} params.amount
 * @param {string} params.currency
 * @param {string} params.description
 * @param {string} params.returnUrl
 * @param {string} [params.cancelUrl]
 * @param {string} [params.customerEmail]
 * @param {string} [params.customerName]
 * @param {string} [params.customerPhone]
 * @param {object} [params.metadata]
 * @returns {Promise<{checkoutId, paymentUrl, status, expiresAt, amount, currency}>}
 */
async function createCheckout({
  amount,
  currency      = PREMIUM_CURRENCY,
  description,
  returnUrl,
  cancelUrl,
  customerEmail,
  customerName,
  customerPhone,
  metadata      = {},
}) {
  validateAmount(amount, currency);

  // Payload conforme à la documentation officielle SasPay checkout-sessions.
  const payload = {
    amount     : Number(amount).toFixed(2),
    currency   : currency.toUpperCase(),
    description: description || 'OmniSMS Premium',
    country    : 'BF',
    metadata,
  };

  if (returnUrl)     payload.return_url      = returnUrl;
  if (customerEmail) payload.customer_email  = customerEmail;
  if (customerName)  payload.customer_name   = customerName;
  if (customerPhone) payload.customer_phone  = customerPhone;

  const requestUrl = `${SAASPAY_BASE_URL}/api/v1/checkout-sessions/`;
  logger.info('[SasPay] POST /api/v1/checkout-sessions/', {
    requestUrl,
    amount    : payload.amount,
    currency  : payload.currency,
    metadata  : JSON.stringify(metadata).substring(0, 200),
  });

  let response;
  try {
    response = await withRetry(() =>
      axios.post(
        `${SAASPAY_BASE_URL}/api/v1/checkout-sessions/`,
        payload,
        { headers: buildHeaders(), timeout: SAASPAY_TIMEOUT }
      )
    );
  } catch (err) {
    const status  = err.response?.status;
    const detail  = err.response?.data;
    logger.error('[PAYMENT_ERROR] SasPay — échec POST /api/v1/checkout-sessions/', {
      status,
      responseBody: detail === undefined ? null : safeJson(detail),
      responseShape: detail === undefined ? null : responseShape(detail),
      errorCode: err.code || null,
      networkError: !err.response,
      message: err.message,
    });
    throw new Error(
      `SasPay API error (${status || 'network'}): ` +
      (detail?.message || detail?.error || err.message)
    );
  }

  // Extraire la réponse directe SasPay ou son enveloppe { data: ... }.
  const data = extractData(response.data);

  logger.info('[PAYMENT] SaaSPay — réponse création checkout', {
    checkoutId : data?.id || data?.checkout_id || null,
    status     : data?.status || null,
    amount     : data?.amount || null,
    currency   : data?.currency || null,
    hasPaymentUrl: !!(data?.checkout_url || data?.payment_url || data?.url),
  });

  // Vérifier les champs obligatoires
  const checkoutId = data?.id || data?.checkout_id || null;
  const paymentUrl = data?.checkout_url || data?.payment_url || data?.url || null;

  if (!checkoutId || !paymentUrl) {
    logger.error('[SaaSPay] Réponse inattendue — champs id ou payment_url manquants', {
      responseShape: responseShape(response.data),
      responseData: safeJson(response.data),
    });
    throw new Error(
      'Réponse SasPay invalide : champs id/checkout_url manquants. ' +
      'Vérifiez la clé API SasPay et son scope PAYIN.'
    );
  }

  return {
    checkoutId  : checkoutId,
    paymentUrl  : paymentUrl,           // ← data.checkout_url (SasPay officiel)
    status      : data?.status         || 'pending',
    expiresAt   : data?.expires_at     || null,
    amount      : data?.amount         || Number(amount),
    currency    : data?.currency       || currency.toUpperCase(),
    returnUrl   : data?.return_url     || returnUrl || null,
  };
}

/* ═══════════════════════════════════════════════════════════════
   API 2 — Statut d'un checkout (polling)
   GET /api/v1/checkout-sessions/:id/
   Réponse officielle : { data: { id, status, amount, currency, paid_at, ... } }
   status = "paid" quand le paiement est confirmé
══════════════════════════════════════════════════════════════════ */
/**
 * @param {string} checkoutId
 * @returns {Promise<{checkoutId, status, amount, currency, paidAt, paymentMethod, metadata}>}
 */
async function getCheckoutStatus(checkoutId) {
  if (!checkoutId || typeof checkoutId !== 'string') {
    throw new Error('checkoutId invalide.');
  }

  logger.info('[SaaSPay] GET /api/v1/checkout-sessions/:id/', { checkoutId });

  let response;
  try {
    response = await withRetry(() =>
      axios.get(
        `${SAASPAY_BASE_URL}/api/v1/checkout-sessions/${encodeURIComponent(checkoutId)}/`,
        { headers: buildHeaders(), timeout: SAASPAY_TIMEOUT }
      )
    );
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    logger.error('[SaaSPay] Erreur GET /api/v1/checkout-sessions/:id/', {
      checkoutId, status, message: err.message,
    });
    throw new Error(
      `SasPay status error (${status || 'network'}): ` +
      (detail?.message || err.message)
    );
  }

  const data = extractData(response.data);

  logger.info('[SaaSPay] Statut checkout', {
    checkoutId,
    status: data?.status,
    paidAt: data?.paid_at,
  });

  return {
    checkoutId   : data?.id           || checkoutId,
    status       : data?.status       || 'unknown',
    amount       : data?.amount       || 0,
    currency     : data?.currency     || PREMIUM_CURRENCY,
    paidAt       : data?.paid_at      || null,
    paymentMethod: data?.payment_method || null,
    metadata     : data?.metadata     || {},
    customer     : data?.customer     || {},
    isPaid       : ['paid', 'success'].includes(String(data?.status || '').toLowerCase()),
  };
}

/* ═══════════════════════════════════════════════════════════════
   Webhook — Vérification signature HMAC
   Header : X-SaaSPay-Signature (ou X-LeekPay-Signature — legacy)
   Calcul  : HMAC-SHA256(rawBody, secret) en hex

   ⚠️ SÉCURITÉ : la vérification est FAIL-CLOSED.
   En l'absence de clé de signature ou d'en-tête de signature, la
   fonction retourne false. Le controller compense en exigeant alors
   une confirmation du statut auprès de l'API SaaSPay (server-side)
   avant toute activation Premium : aucun webhook ne peut donc être
   falsifié pour activer Premium sans confirmation du fournisseur.
══════════════════════════════════════════════════════════════════ */
/**
 * @param {string} rawBody   - Corps brut UTF-8
 * @param {string} signature - Valeur header X-SaaSPay-Signature
 * @returns {boolean} true uniquement si la signature est présente ET valide
 */
function verifyWebhookSignature(rawBody, signature) {
  const signingKey = (
    process.env.SAASPAY_WEBHOOK_SECRET ||
    process.env.SAASPAY_API_KEY        ||
    ''
  ).trim();

  if (!signingKey) {
    logger.warn('[PAYMENT_VERIFY] Clé de signature webhook absente (SAASPAY_WEBHOOK_SECRET / SAASPAY_API_KEY) ' +
      '— signature non vérifiable : confirmation du statut auprès du fournisseur obligatoire.', {
      signaturePresent: !!signature,
    });
    return false;
  }

  if (!signature) {
    logger.warn('[PAYMENT_VERIFY] Header de signature absent — signature non vérifiable : ' +
      'confirmation du statut auprès du fournisseur obligatoire.');
    return false;
  }

  try {
    const expected = crypto
      .createHmac('sha256', signingKey)
      .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf8')
      .digest('hex');

    // timingSafeEqual requiert des buffers de même taille
    const sigBuf = Buffer.from(signature,  'hex');
    const expBuf = Buffer.from(expected,   'hex');

    if (sigBuf.length !== expBuf.length || sigBuf.length === 0) {
      logger.error('[PAYMENT_VERIFY] Signature webhook invalide (longueur)', {
        receivedLength: signature.length,
      });
      return false;
    }

    const isValid = crypto.timingSafeEqual(sigBuf, expBuf);
    if (!isValid) {
      logger.error('[PAYMENT_VERIFY] Signature webhook invalide', {
        receivedLength: signature.length,
      });
    }
    return isValid;

  } catch (err) {
    logger.error('[PAYMENT_VERIFY] Erreur vérification signature', { error: err.message });
    return false;
  }
}

/* ── Exports ─────────────────────────────────────────────────── */
module.exports = {
  createCheckout,
  getCheckoutStatus,
  verifyWebhookSignature,
  isConfigured,
  validateAmount,
  getConfigStatus,
  maskSensitiveFields,
  PREMIUM_AMOUNT,
  PREMIUM_CURRENCY,
  ALLOWED_CURRENCIES,
  MIN_AMOUNTS,
};
