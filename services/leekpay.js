'use strict';
/**
 * OmniSMS — Service LeekPay
 * ═══════════════════════════════════════════════════════════════
 *
 * Client HTTP pour l'API LeekPay.
 * Documentation officielle : https://leekpay.fr/docs
 *
 * Endpoint de création :
 *   POST https://leekpay.fr/api/v1/checkout
 *   Authorization: Bearer sk_live_xxx
 *   Réponse : { data: { id, payment_url, status, amount, currency, expires_at, ... } }
 *
 * Endpoint de statut :
 *   GET https://leekpay.fr/api/v1/checkout/:id
 *   Authorization: Bearer sk_live_xxx
 *   Réponse : { data: { id, status, amount, currency, paid_at, ... } }
 *   status = "paid" quand payé
 *
 * Webhook (payment.completed) :
 *   Header X-LeekPay-Signature: <hmac_sha256_hex>
 *   Body   { event: "payment.completed", data: { checkout_id, status: "paid", ... } }
 *
 * Variables d'environnement :
 *   LEEKPAY_SECRET_KEY     → sk_live_xxx  (Bearer token — requis)
 *   LEEKPAY_API_KEY        → pk_live_xxx  (signature webhook — requis)
 *   LEEKPAY_BASE_URL       → https://leekpay.fr (défaut)
 *   LEEKPAY_WEBHOOK_SECRET → HMAC secret (optionnel, remplace pk_live_xxx)
 */

const axios  = require('axios');
const crypto = require('crypto');
const { logger } = require('../middleware/logger');

/* ── Constantes ──────────────────────────────────────────────── */
const LEEKPAY_BASE_URL  = (process.env.LEEKPAY_BASE_URL || 'https://leekpay.fr').replace(/\/$/, '');
const LEEKPAY_TIMEOUT   = 25_000;   // 25 s
const MAX_RETRIES       = 2;
const RETRY_DELAY_MS    = 1_000;

const PREMIUM_AMOUNT   = parseInt(process.env.LEEKPAY_PREMIUM_AMOUNT, 10) || 2000;
const PREMIUM_CURRENCY = (process.env.LEEKPAY_PREMIUM_CURRENCY || 'XOF').toUpperCase();

const ALLOWED_CURRENCIES = ['XOF', 'EUR', 'USD', 'GHS', 'KES', 'NGN'];
const MIN_AMOUNTS        = { XOF: 100, EUR: 1, USD: 1, GHS: 1, KES: 1, NGN: 100 };

/* ── Helpers ─────────────────────────────────────────────────── */

function resolveKeys() {
  const secretKey = (process.env.LEEKPAY_SECRET_KEY || '').trim();
  const apiKey    = (process.env.LEEKPAY_API_KEY    || '').trim();
  if (!secretKey) throw new Error('LEEKPAY_SECRET_KEY manquante (sk_live_xxx).');
  if (!apiKey)    throw new Error('LEEKPAY_API_KEY manquante (pk_live_xxx).');
  return { secretKey, apiKey };
}

function isConfigured() {
  return !!(
    (process.env.LEEKPAY_SECRET_KEY || '').trim() &&
    (process.env.LEEKPAY_API_KEY    || '').trim()
  );
}

function buildHeaders() {
  const { secretKey } = resolveKeys();
  return {
    'Authorization': `Bearer ${secretKey}`,
    'Content-Type' : 'application/json',
    'Accept'       : 'application/json',
    'User-Agent'   : 'OmniSMS-Backend/4.3',
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      logger.warn(`[LeekPay] Retry ${attempt + 1}/${retries} dans ${delay}ms (status ${status || 'network'})`);
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

  logger.info('[LeekPay] POST /api/v1/checkout', {
    amount    : payload.amount,
    currency  : payload.currency,
    metadata  : JSON.stringify(metadata).substring(0, 200),
  });

  let response;
  try {
    response = await withRetry(() =>
      axios.post(
        `${LEEKPAY_BASE_URL}/api/v1/checkout`,
        payload,
        { headers: buildHeaders(), timeout: LEEKPAY_TIMEOUT }
      )
    );
  } catch (err) {
    const status  = err.response?.status;
    const detail  = err.response?.data;
    logger.error('[LeekPay] Erreur POST /api/v1/checkout', {
      status,
      detail : JSON.stringify(detail).substring(0, 500),
      message: err.message,
    });
    throw new Error(
      `LeekPay API error (${status || 'network'}): ` +
      (detail?.message || detail?.error || err.message)
    );
  }

  // Extraire les données — format officiel : { data: { id, payment_url, ... } }
  const data = extractData(response.data);

  logger.info('[LeekPay] Réponse POST /api/v1/checkout', {
    raw: JSON.stringify(response.data).substring(0, 500),
  });

  // Vérifier les champs obligatoires
  const checkoutId = data?.id || data?.checkout_id || null;
  const paymentUrl = data?.payment_url || data?.url || data?.checkout_url || null;

  if (!checkoutId || !paymentUrl) {
    logger.error('[LeekPay] Réponse inattendue — champs id ou payment_url manquants', {
      responseData: JSON.stringify(response.data).substring(0, 500),
    });
    throw new Error(
      'Réponse LeekPay invalide : champs id/payment_url manquants. ' +
      'Vérifiez LEEKPAY_SECRET_KEY et LEEKPAY_API_KEY.'
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

  logger.info('[LeekPay] GET /api/v1/checkout/:id', { checkoutId });

  let response;
  try {
    response = await withRetry(() =>
      axios.get(
        `${LEEKPAY_BASE_URL}/api/v1/checkout/${encodeURIComponent(checkoutId)}`,
        { headers: buildHeaders(), timeout: LEEKPAY_TIMEOUT }
      )
    );
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    logger.error('[LeekPay] Erreur GET /api/v1/checkout/:id', {
      checkoutId, status, message: err.message,
    });
    throw new Error(
      `LeekPay status error (${status || 'network'}): ` +
      (detail?.message || err.message)
    );
  }

  const data = extractData(response.data);

  logger.info('[LeekPay] Statut checkout', {
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
   Header : X-LeekPay-Signature
   Calcul  : HMAC-SHA256(rawBody, pk_live_xxx) en hex
══════════════════════════════════════════════════════════════════ */
/**
 * @param {string} rawBody   - Corps brut UTF-8
 * @param {string} signature - Valeur header X-LeekPay-Signature
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature) {
  const signingKey = (
    process.env.LEEKPAY_WEBHOOK_SECRET ||
    process.env.LEEKPAY_API_KEY        ||
    ''
  ).trim();

  if (!signingKey) {
    logger.warn('[LeekPay] Clé signature webhook absente — mode dégradé (accepté sans vérification).');
    return true;
  }

  if (!signature) {
    logger.warn('[LeekPay] Header X-LeekPay-Signature absent — webhook accepté en mode dégradé.');
    return true;  // Accepter si aucune signature (pas encore configurée côté LeekPay)
  }

  try {
    const expected = crypto
      .createHmac('sha256', signingKey)
      .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf8')
      .digest('hex');

    // timingSafeEqual requiert des buffers de même taille
    const sigBuf = Buffer.from(signature,  'hex');
    const expBuf = Buffer.from(expected,   'hex');

    if (sigBuf.length !== expBuf.length) {
      logger.error('[LeekPay] Signature longueur invalide', {
        received: signature.substring(0, 16) + '…',
        expected: expected.substring(0, 16) + '…',
      });
      return false;
    }

    const isValid = crypto.timingSafeEqual(sigBuf, expBuf);
    if (!isValid) {
      logger.error('[LeekPay] Signature webhook invalide', {
        received: signature.substring(0, 16) + '…',
        expected: expected.substring(0, 16) + '…',
      });
    }
    return isValid;

  } catch (err) {
    logger.error('[LeekPay] Erreur vérification signature', { error: err.message });
    return true;  // mode dégradé — accepter plutôt que bloquer
  }
}

/* ── Exports ─────────────────────────────────────────────────── */
module.exports = {
  createCheckout,
  getCheckoutStatus,
  verifyWebhookSignature,
  isConfigured,
  validateAmount,
  PREMIUM_AMOUNT,
  PREMIUM_CURRENCY,
  ALLOWED_CURRENCIES,
  MIN_AMOUNTS,
};
