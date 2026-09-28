'use strict';
/**
 * OmniSMS — Service SaaSPay
 * ═══════════════════════════════════════════════════════════════
 *
 * Client HTTP pour l'API SaaSPay.
 * Documentation officielle : https://saaspay.me/docs
 *
 * Endpoint de création :
 *   POST https://saaspay.me/api/v1/checkout
 *   Authorization: Bearer sk_live_xxx
 *   Réponse : { data: { id, payment_url, status, amount, currency, expires_at, ... } }
 *
 * Endpoint de statut :
 *   GET https://saaspay.me/api/v1/checkout/:id
 *   Authorization: Bearer sk_live_xxx
 *   Réponse : { data: { id, status, amount, currency, paid_at, ... } }
 *   status = "paid" quand payé
 *
 * Webhook (payment.completed) :
 *   Header X-SaaSPay-Signature: <hmac_sha256_hex>
 *   Body   { event: "payment.completed", data: { checkout_id, status: "paid", ... } }
 *
 * Variables d'environnement :
 *   SAASPAY_SECRET_KEY     → sk_live_xxx  (Bearer token — requis)
 *   SAASPAY_API_KEY        → pk_live_xxx  (signature webhook — requis)
 *   SAASPAY_BASE_URL       → https://saaspay.me (défaut)
 *   SAASPAY_WEBHOOK_SECRET → HMAC secret (optionnel, remplace pk_live_xxx)
 */

const axios  = require('axios');
const crypto = require('crypto');
const { logger } = require('../middleware/logger');
const { normalizePaymentEnv, getPaymentEnvStatus, maskSecret } = require('../config/paymentEnv');

/* ── Configuration ───────────────────────────────────────────────
   Les anciennes variables (legacy) éventuellement encore présentes
   dans l'environnement Render sont recopiées vers les variables
   SAASPAY_* lues ci-dessous (voir config/paymentEnv.js).
   Aucune valeur secrète n'est journalisée.
──────────────────────────────────────────────────────────────── */
normalizePaymentEnv({ logger });

/* ── Constantes ──────────────────────────────────────────────── */
const SAASPAY_BASE_URL  = (process.env.SAASPAY_BASE_URL || 'https://saaspay.me').replace(/\/$/, '');
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
  const apiKey    = (process.env.SAASPAY_API_KEY    || '').trim();
  if (!secretKey) throw new Error('SAASPAY_SECRET_KEY manquante (sk_live_xxx).');
  if (!apiKey)    throw new Error('SAASPAY_API_KEY manquante (pk_live_xxx).');
  return { secretKey, apiKey };
}

function isConfigured() {
  return !!(
    (process.env.SAASPAY_SECRET_KEY || '').trim() &&
    (process.env.SAASPAY_API_KEY    || '').trim()
  );
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
    apiKey        : status.required.SAASPAY_API_KEY,
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

/* ── Extraire les données d'une réponse API LeekPay ─────────── */
// La réponse officielle est : { data: { id, payment_url, status, ... } }
// Certaines implémentations retournent directement l'objet sans wrapper data
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
   POST /api/v1/checkout
   Authorization: Bearer sk_live_xxx
   Réponse officielle : { data: { id, payment_url, status, expires_at, amount, currency } }
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

  // Payload conforme à la doc officielle LeekPay
  const payload = {
    amount     : Number(amount),
    currency   : currency.toUpperCase(),
    description: description || 'OmniSMS Premium',
    metadata,
  };

  if (returnUrl)     payload.return_url      = returnUrl;
  if (cancelUrl)     payload.cancel_url      = cancelUrl;
  if (customerEmail) payload.customer_email  = customerEmail;
  if (customerName)  payload.customer_name   = customerName;
  if (customerPhone) payload.customer_phone  = customerPhone;

  logger.info('[SaaSPay] POST /api/v1/checkout', {
    amount    : payload.amount,
    currency  : payload.currency,
    metadata  : JSON.stringify(metadata).substring(0, 200),
  });

  let response;
  try {
    response = await withRetry(() =>
      axios.post(
        `${SAASPAY_BASE_URL}/api/v1/checkout`,
        payload,
        { headers: buildHeaders(), timeout: SAASPAY_TIMEOUT }
      )
    );
  } catch (err) {
    const status  = err.response?.status;
    const detail  = err.response?.data;
    logger.error('[PAYMENT_ERROR] SaaSPay — échec POST /api/v1/checkout', {
      status,
      detail : JSON.stringify(maskSensitiveFields(detail)).substring(0, 500),
      message: err.message,
    });
    throw new Error(
      `SaaSPay API error (${status || 'network'}): ` +
      (detail?.message || detail?.error || err.message)
    );
  }

  // Extraire les données — format officiel : { data: { id, payment_url, ... } }
  const data = extractData(response.data);

  logger.info('[PAYMENT] SaaSPay — réponse création checkout', {
    checkoutId : data?.id || data?.checkout_id || null,
    status     : data?.status || null,
    amount     : data?.amount || null,
    currency   : data?.currency || null,
    hasPaymentUrl: !!(data?.payment_url || data?.url || data?.checkout_url),
  });

  // Vérifier les champs obligatoires
  const checkoutId = data?.id || data?.checkout_id || null;
  const paymentUrl = data?.payment_url || data?.url || data?.checkout_url || null;

  if (!checkoutId || !paymentUrl) {
    logger.error('[SaaSPay] Réponse inattendue — champs id ou payment_url manquants', {
      responseData: JSON.stringify(response.data).substring(0, 500),
    });
    throw new Error(
      'Réponse LeekPay invalide : champs id/payment_url manquants. ' +
      'Vérifiez SAASPAY_SECRET_KEY et SAASPAY_API_KEY.'
    );
  }

  return {
    checkoutId  : checkoutId,
    paymentUrl  : paymentUrl,           // ← data.payment_url (officiel)
    status      : data?.status         || 'pending',
    expiresAt   : data?.expires_at     || null,
    amount      : data?.amount         || Number(amount),
    currency    : data?.currency       || currency.toUpperCase(),
    returnUrl   : data?.return_url     || returnUrl || null,
  };
}

/* ═══════════════════════════════════════════════════════════════
   API 2 — Statut d'un checkout (polling)
   GET /api/v1/checkout/:id
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

  logger.info('[SaaSPay] GET /api/v1/checkout/:id', { checkoutId });

  let response;
  try {
    response = await withRetry(() =>
      axios.get(
        `${SAASPAY_BASE_URL}/api/v1/checkout/${encodeURIComponent(checkoutId)}`,
        { headers: buildHeaders(), timeout: SAASPAY_TIMEOUT }
      )
    );
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    logger.error('[SaaSPay] Erreur GET /api/v1/checkout/:id', {
      checkoutId, status, message: err.message,
    });
    throw new Error(
      `SaaSPay status error (${status || 'network'}): ` +
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
    isPaid       : (data?.status || '').toLowerCase() === 'paid',
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
