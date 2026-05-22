'use strict';
/**
 * OmniSMS — Service LeekPay
 * ═══════════════════════════════════════════════════════════════
 *
 * Client HTTP pour l'API LeekPay.me.
 * Aucune clé codée en dur — tout depuis les variables d'environnement.
 *
 * Variables d'environnement :
 *   LEEKPAY_SECRET_KEY     → Clé secrète  sk_live_xxx  (requise)
 *   LEEKPAY_API_KEY        → Clé publique pk_live_xxx  (requise — sert aussi à la signature webhook)
 *   LEEKPAY_BASE_URL       → Base URL (défaut: https://leekpay.fr)
 *   LEEKPAY_WEBHOOK_SECRET → Secret HMAC webhook (optionnel — si défini, remplace LEEKPAY_API_KEY pour la signature)
 *
 * API LeekPay (REST) :
 *   POST /api/v1/checkout              → Créer un checkout
 *   GET  /api/v1/checkout/:id          → Statut d'un checkout
 *
 * Signature webhook :
 *   Header : X-LeekPay-Signature
 *   Calcul  : HMAC-SHA256(payload, pk_live_xxx) — en hex
 *
 * @see https://www.leekpay.me/docs
 */

const axios  = require('axios');
const crypto = require('crypto');
const { logger } = require('../middleware/logger');

// ── Constantes ────────────────────────────────────────────────
const LEEKPAY_BASE_URL  = (process.env.LEEKPAY_BASE_URL || 'https://leekpay.fr').replace(/\/$/, '');
const LEEKPAY_TIMEOUT   = 20_000; // 20 secondes
const MAX_RETRIES       = 2;      // 2 retries max
const RETRY_DELAY_MS    = 1_000;  // 1 seconde entre retries

// Montant abonnement OmniSMS Premium
const PREMIUM_AMOUNT   = parseInt(process.env.LEEKPAY_PREMIUM_AMOUNT, 10) || 2000;
const PREMIUM_CURRENCY = process.env.LEEKPAY_PREMIUM_CURRENCY || 'XOF';

// Devises autorisées par LeekPay
const ALLOWED_CURRENCIES = ['XOF', 'EUR', 'USD'];

// Montants minimum par devise
const MIN_AMOUNTS = { XOF: 100, EUR: 1, USD: 1 };

// ── Helpers internes ───────────────────────────────────────────

/**
 * Résoudre les clés LeekPay depuis l'environnement.
 * @returns {{ secretKey: string, apiKey: string }}
 * @throws {Error} si les clés sont absentes
 */
function resolveKeys() {
  const secretKey = process.env.LEEKPAY_SECRET_KEY || '';
  const apiKey    = process.env.LEEKPAY_API_KEY    || '';

  if (!secretKey) {
    throw new Error(
      'LeekPay non configuré : LEEKPAY_SECRET_KEY manquante. ' +
      'Ajoutez sk_live_xxx dans vos variables d\'environnement Render.'
    );
  }
  if (!apiKey) {
    throw new Error(
      'LeekPay non configuré : LEEKPAY_API_KEY manquante. ' +
      'Ajoutez pk_live_xxx dans vos variables d\'environnement Render.'
    );
  }

  return { secretKey, apiKey };
}

/**
 * Vérifier si LeekPay est correctement configuré.
 * @returns {boolean}
 */
function isConfigured() {
  return !!(process.env.LEEKPAY_SECRET_KEY && process.env.LEEKPAY_API_KEY);
}

/**
 * Construire les headers HTTP pour l'API LeekPay.
 * @returns {object}
 */
function buildHeaders() {
  const { secretKey } = resolveKeys();
  return {
    'Authorization': `Bearer ${secretKey}`,
    'Content-Type' : 'application/json',
    'Accept'       : 'application/json',
    'User-Agent'   : 'OmniSMS-Backend/4.1',
  };
}

/**
 * Attendre N millisecondes (pour les retries).
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Appel HTTP avec retry automatique.
 * Retry sur : timeout, 429, 502, 503, 504.
 *
 * @param {Function} fn  - Fonction async qui fait l'appel axios
 * @param {number}   retries
 * @returns {Promise<any>}
 */
async function withRetry(fn, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const isRetryable = !status || status === 429 || status >= 500;

      if (!isRetryable || attempt >= retries) break;

      const delay = RETRY_DELAY_MS * Math.pow(2, attempt); // backoff exponentiel
      logger.warn(`[LeekPay] Retry ${attempt + 1}/${retries} dans ${delay}ms`, {
        status,
        message: err.message,
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

// ── Validation ──────────────────────────────────────────────────

/**
 * Valider un montant et une devise LeekPay.
 * @param {number} amount
 * @param {string} currency
 * @throws {Error} si invalide
 */
function validateAmount(amount, currency) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error(`Montant invalide : ${amount}. Doit être un nombre positif.`);
  }
  const curr = (currency || '').toUpperCase();
  if (!ALLOWED_CURRENCIES.includes(curr)) {
    throw new Error(`Devise non supportée : ${currency}. Devises acceptées : ${ALLOWED_CURRENCIES.join(', ')}.`);
  }
  const minAmount = MIN_AMOUNTS[curr] || 1;
  if (amt < minAmount) {
    throw new Error(`Montant minimum pour ${curr} : ${minAmount}. Reçu : ${amt}.`);
  }
}

// ── API : Créer un checkout ──────────────────────────────────────

/**
 * Créer un checkout LeekPay et obtenir l'URL de paiement.
 *
 * @param {object} params
 * @param {number}  params.amount          - Montant (ex : 2000)
 * @param {string}  params.currency        - Devise : XOF | EUR | USD
 * @param {string}  params.description     - Description de la commande
 * @param {string}  params.returnUrl       - URL de retour après paiement réussi
 * @param {string}  [params.cancelUrl]     - URL si annulation
 * @param {string}  [params.customerEmail] - Email du client
 * @param {string}  [params.customerName]  - Nom du client
 * @param {string}  [params.customerPhone] - Téléphone du client (Mobile Money)
 * @param {object}  [params.metadata]      - Données libres (renvoyées dans le webhook)
 * @returns {Promise<{checkoutId: string, paymentUrl: string, status: string, expiresAt: string, amount: number, currency: string}>}
 * @throws {Error}
 */
async function createCheckout({
  amount,
  currency = PREMIUM_CURRENCY,
  description,
  returnUrl,
  cancelUrl,
  customerEmail,
  customerName,
  customerPhone,
  metadata = {},
}) {
  // Valider avant l'appel réseau
  validateAmount(amount, currency);

  const payload = {
    amount     : Number(amount),
    currency   : currency.toUpperCase(),
    description: description || 'OmniSMS Premium',
    return_url : returnUrl   || undefined,
    cancel_url : cancelUrl   || undefined,
    metadata,
  };

  // Champs optionnels client
  if (customerEmail) payload.customer_email = customerEmail;
  if (customerName)  payload.customer_name  = customerName;
  if (customerPhone) payload.customer_phone = customerPhone;

  logger.info('[LeekPay] Création checkout', {
    amount,
    currency: payload.currency,
    metadata: JSON.stringify(metadata),
  });

  const response = await withRetry(() =>
    axios.post(`${LEEKPAY_BASE_URL}/api/v1/checkout`, payload, {
      headers: buildHeaders(),
      timeout: LEEKPAY_TIMEOUT,
    })
  );

  const data = response.data?.data || response.data;

  if (!data?.id || !data?.payment_url) {
    logger.error('[LeekPay] Réponse API inattendue', { responseData: response.data });
    throw new Error('Réponse LeekPay invalide : champs id ou payment_url manquants.');
  }

  logger.info('[LeekPay] Checkout créé', {
    checkoutId: data.id,
    status    : data.status,
    expiresAt : data.expires_at,
  });

  return {
    checkoutId  : data.id,
    paymentUrl  : data.payment_url,   // URL complète de paiement
    status      : data.status || 'pending',
    expiresAt   : data.expires_at || null,
    amount      : data.amount || Number(amount),
    currency    : data.currency || currency.toUpperCase(),
    returnUrl   : data.return_url || returnUrl || null,
  };
}

// ── API : Statut d'un checkout ───────────────────────────────────

/**
 * Récupérer le statut d'un checkout LeekPay.
 *
 * @param {string} checkoutId - Identifiant checkout (checkout_xxx)
 * @returns {Promise<{checkoutId: string, status: string, amount: number, currency: string, paidAt: string|null, metadata: object}>}
 * @throws {Error}
 */
async function getCheckoutStatus(checkoutId) {
  if (!checkoutId || typeof checkoutId !== 'string') {
    throw new Error('checkoutId invalide.');
  }

  logger.info('[LeekPay] Vérification statut checkout', { checkoutId });

  const response = await withRetry(() =>
    axios.get(`${LEEKPAY_BASE_URL}/api/v1/checkout/${encodeURIComponent(checkoutId)}`, {
      headers: buildHeaders(),
      timeout: LEEKPAY_TIMEOUT,
    })
  );

  const data = response.data?.data || response.data;

  logger.info('[LeekPay] Statut checkout', {
    checkoutId,
    status: data?.status,
  });

  return {
    checkoutId   : data.id          || checkoutId,
    status       : data.status      || 'unknown',
    amount       : data.amount      || 0,
    currency     : data.currency    || PREMIUM_CURRENCY,
    paidAt       : data.paid_at     || null,
    paymentMethod: data.payment_method || null,
    metadata     : data.metadata    || {},
    customer     : data.customer    || {},
  };
}

// ── Webhook : Validation signature ───────────────────────────────

/**
 * Vérifier la signature HMAC d'un webhook LeekPay.
 *
 * LeekPay envoie : X-LeekPay-Signature: <hmac_sha256_hex>
 * Calcul          : HMAC-SHA256(rawBody, pk_live_xxx) en hex
 *
 * Si LEEKPAY_WEBHOOK_SECRET est défini, on l'utilise à la place de la clé publique.
 *
 * @param {string} rawBody   - Corps brut de la requête (UTF-8)
 * @param {string} signature - Valeur du header X-LeekPay-Signature
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature) {
  // Clé utilisée pour la signature : LEEKPAY_WEBHOOK_SECRET > LEEKPAY_API_KEY
  const signingKey = process.env.LEEKPAY_WEBHOOK_SECRET
    || process.env.LEEKPAY_API_KEY
    || '';

  if (!signingKey) {
    logger.warn('[LeekPay] LEEKPAY_API_KEY absent — signature webhook non vérifiable. Accepté en mode dégradé.');
    return true; // mode dégradé — accepter mais logger
  }

  if (!signature) {
    logger.error('[LeekPay] Header X-LeekPay-Signature absent dans le webhook.');
    return false;
  }

  try {
    const expected = crypto
      .createHmac('sha256', signingKey)
      .update(rawBody, 'utf8')
      .digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );

    if (!isValid) {
      logger.error('[LeekPay] Signature webhook invalide', {
        received: signature.substring(0, 16) + '…',
        expected: expected.substring(0, 16) + '…',
      });
    }

    return isValid;
  } catch (err) {
    logger.error('[LeekPay] Erreur vérification signature', { error: err.message });
    return false;
  }
}

// ── Exports ────────────────────────────────────────────────────

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
