'use strict';
/**
 * OmniSMS — Service GeniusPay
 * ═══════════════════════════════════════════════════════════════
 *
 * Encapsule tous les appels à l'API GeniusPay.
 * AUCUNE clé n'est codée en dur — tout vient des variables d'environnement.
 *
 * Variables d'environnement acceptées :
 *   GENIUSPAY_PUBLIC_KEY     → Clé publique  (X-API-Key)   [priorité 1]
 *   GENIUSPAY_API_KEY        → Alias clé publique          [priorité 2]
 *   GENIUSPAY_SECRET_KEY     → Clé secrète  (X-API-Secret) [priorité 1]
 *   GENIUSPAY_API_SECRET     → Alias clé secrète           [priorité 2]
 *   GENIUSPAY_WEBHOOK_SECRET → Secret HMAC pour les webhooks (optionnel)
 *
 * Endpoints utilisés :
 *   POST https://pay.genius.ci/api/v1/merchant/payments      → Créer paiement
 *   GET  https://pay.genius.ci/api/v1/merchant/payments/:id  → Statut paiement
 */

const axios  = require('axios');
const crypto = require('crypto');
const { logger } = require('../middleware/logger');

// ── Configuration ──────────────────────────────────────────────
const GENIUSPAY_BASE_URL = 'https://pay.genius.ci/api/v1/merchant';
const GENIUSPAY_TIMEOUT  = 15_000; // 15 secondes max

// Montant abonnement OmniSMS Premium (fixe)
const PREMIUM_AMOUNT   = 2000;
const PREMIUM_CURRENCY = 'XOF';

// ── Helpers internes ───────────────────────────────────────────

/**
 * Résoudre les noms de variables d'environnement GeniusPay.
 * Accepte GENIUSPAY_PUBLIC_KEY OU GENIUSPAY_API_KEY (alias).
 *
 * @returns {{ apiKey: string, apiSecret: string }}
 * @throws {Error} si les clés sont absentes
 */
function resolveKeys() {
  const apiKey    = process.env.GENIUSPAY_PUBLIC_KEY  || process.env.GENIUSPAY_API_KEY    || '';
  const apiSecret = process.env.GENIUSPAY_SECRET_KEY  || process.env.GENIUSPAY_API_SECRET || '';

  if (!apiKey || !apiSecret) {
    throw new Error(
      'GeniusPay non configuré. Définissez GENIUSPAY_PUBLIC_KEY et GENIUSPAY_SECRET_KEY dans vos variables d\'environnement.'
    );
  }

  return { apiKey, apiSecret };
}

/**
 * Construire les headers HTTP pour l'API GeniusPay.
 *
 * @returns {object} headers
 */
function buildHeaders() {
  const { apiKey, apiSecret } = resolveKeys();

  return {
    'Content-Type' : 'application/json',
    'X-API-Key'    : apiKey,
    'X-API-Secret' : apiSecret,
  };
}

/**
 * Vérifier la signature HMAC d'un webhook GeniusPay.
 *
 * GeniusPay envoie le header : X-Genius-Signature: sha256=<hmac_hex>
 * Si GENIUSPAY_WEBHOOK_SECRET n'est pas défini → mode dégradé (accepte tout, log alerte).
 *
 * @param {string} rawBody   - Corps brut de la requête (string UTF-8)
 * @param {string} signature - Valeur du header X-Genius-Signature
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.GENIUSPAY_WEBHOOK_SECRET;

  // Mode dégradé : secret non configuré → accepte mais avertit
  if (!secret) {
    logger.warn('[GeniusPay] GENIUSPAY_WEBHOOK_SECRET absent — vérification signature ignorée. Configurez-le pour une sécurité maximale.');
    return true;
  }

  if (!signature) {
    logger.warn('[GeniusPay] Webhook reçu sans header X-Genius-Signature — rejeté.');
    return false;
  }

  // Supprimer le préfixe "sha256=" si présent
  const sigHash = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
      .digest('hex');

    // Comparaison en temps constant — protection contre les timing attacks
    const sigBuf = Buffer.from(sigHash,  'hex');
    const expBuf = Buffer.from(expected, 'hex');

    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);

  } catch (err) {
    logger.error('[GeniusPay] Erreur vérification signature HMAC', { error: err.message });
    return false;
  }
}

/**
 * Vérifier si GeniusPay est correctement configuré.
 *
 * @returns {boolean}
 */
function isConfigured() {
  const apiKey    = process.env.GENIUSPAY_PUBLIC_KEY  || process.env.GENIUSPAY_API_KEY    || '';
  const apiSecret = process.env.GENIUSPAY_SECRET_KEY  || process.env.GENIUSPAY_API_SECRET || '';
  return !!(apiKey && apiSecret);
}

// ── API GeniusPay ──────────────────────────────────────────────

/**
 * Créer un paiement GeniusPay (mode Checkout).
 *
 * Appelle : POST https://pay.genius.ci/api/v1/merchant/payments
 *
 * @param {object}  params
 * @param {string}  params.userId      - Identifiant utilisateur (stocké dans metadata)
 * @param {number}  [params.amount]    - Montant (défaut : PREMIUM_AMOUNT = 2000)
 * @param {string}  [params.phone]     - Numéro de téléphone du client
 * @param {string}  [params.orderId]   - Identifiant de commande unique (généré si absent)
 * @param {string}  [params.returnUrl] - URL de retour après paiement GeniusPay
 * @param {string}  [params.webhookUrl]- URL de webhook de confirmation
 * @param {string}  [params.description]- Description du paiement
 *
 * @returns {Promise<{checkout_url:string, checkoutUrl:string, paymentId:string, orderId:string, status:string}>}
 * @throws {Error} si l'API échoue ou retourne une réponse invalide
 */
async function createPayment({ userId, amount, phone, orderId, returnUrl, webhookUrl, description }) {
  const headers = buildHeaders();

  const paymentAmount = amount || PREMIUM_AMOUNT;

  const payload = {
    amount     : paymentAmount,
    currency   : PREMIUM_CURRENCY,
    description: description || 'OmniSMS abonnement',
    // Metadata : permettra de retrouver l'utilisateur dans le webhook
    metadata: {
      userId : userId,
      orderId: orderId || null,
      app    : 'OmniSMS',
    },
    // Mode Checkout : aucun payment_method → GeniusPay génère sa propre page
    // customer (optionnel)
    ...(phone && {
      customer: {
        phone: String(phone).replace(/[\s\-().]/g, ''),
      },
    }),
    // URLs de redirection (optionnelles)
    ...(returnUrl   && { return_url : returnUrl  }),
    ...(webhookUrl  && { webhook_url: webhookUrl }),
  };

  logger.info('[GeniusPay] Initiation paiement', {
    userId,
    amount : paymentAmount,
    orderId,
    phone  : phone ? `***${String(phone).slice(-3)}` : null,
  });

  const response = await axios.post(
    `${GENIUSPAY_BASE_URL}/payments`,
    payload,
    { headers, timeout: GENIUSPAY_TIMEOUT }
  );

  const data = response.data;

  // GeniusPay peut retourner l'URL sous plusieurs noms selon les versions
  const checkoutUrl = data.checkout_url || data.payment_url || data.url || null;
  const paymentId   = data.id           || data.payment_id  || data.reference || null;

  if (!checkoutUrl) {
    logger.error('[GeniusPay] Réponse API sans checkout_url', {
      status: response.status,
      data  : JSON.stringify(data).substring(0, 200),
    });
    throw new Error('GeniusPay n\'a pas retourné d\'URL de paiement. Vérifiez vos clés API.');
  }

  logger.info('[GeniusPay] Paiement créé avec succès', {
    paymentId,
    userId,
    checkoutUrl: checkoutUrl.substring(0, 80) + '…',
  });

  return {
    checkout_url: checkoutUrl,   // Nom exact tel que décrit dans les specs
    checkoutUrl,                  // Alias camelCase pour usage interne
    paymentId   : paymentId || orderId,
    orderId     : orderId   || paymentId,
    status      : data.status || 'pending',
    raw         : data,
  };
}

/**
 * Vérifier le statut d'un paiement GeniusPay.
 *
 * Appelle : GET https://pay.genius.ci/api/v1/merchant/payments/:id
 *
 * @param {string} paymentId - ID ou référence du paiement
 * @returns {Promise<{status:string, isPaid:boolean, amount:number, userId:string|null, raw:object}>}
 */
async function getPaymentStatus(paymentId) {
  const headers = buildHeaders();

  const response = await axios.get(
    `${GENIUSPAY_BASE_URL}/payments/${paymentId}`,
    { headers, timeout: GENIUSPAY_TIMEOUT }
  );

  const data   = response.data;
  const status = (data.status || '').toLowerCase();
  const isPaid = ['paid', 'success', 'completed', 'successful'].includes(status);

  logger.info('[GeniusPay] Statut paiement', { paymentId, status, isPaid });

  return {
    status,
    isPaid,
    amount: data.amount  || null,
    userId: data.metadata?.userId || null,
    raw   : data,
  };
}

// ── Exports ────────────────────────────────────────────────────
module.exports = {
  createPayment,
  getPaymentStatus,
  verifyWebhookSignature,
  isConfigured,
  resolveKeys,
  PREMIUM_AMOUNT,
  PREMIUM_CURRENCY,
};
