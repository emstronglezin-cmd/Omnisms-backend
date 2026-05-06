'use strict';
/**
 * OmniSMS — PaymentController
 * ═══════════════════════════════════════════════════════════════
 *
 * Logique métier pour le système de paiement GeniusPay.
 *
 * Ce contrôleur est utilisé par :
 *   - routes/payment.js   → POST /api/payment/geniuspay
 *   - routes/webhook.js   → POST /api/payment/webhook
 *
 * Architecture :
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  Routes → Controller → Service (geniuspay.js) → API    │
 *   │                      ↘ usersStore (premium status)     │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Stockage :
 *   - usersStore : Map en mémoire (fallback si Firestore absent)
 *   - Firestore  : source principale si FIREBASE_SERVICE_ACCOUNT_JSON défini
 */

const geniuspay = require('../services/geniuspay');
const { logger } = require('../middleware/logger');

// ══════════════════════════════════════════════════════════════
//  STOCKAGE UTILISATEURS
//  Map en mémoire — persisté vers Firestore si disponible.
//  Structure : userId → { premium: bool, activatedAt, paymentId, orderId }
// ══════════════════════════════════════════════════════════════

/**
 * Stockage en mémoire des statuts premium.
 * Utilisé comme fallback si Firestore n'est pas disponible,
 * ou comme cache court terme.
 *
 * @type {Map<string, {premium: boolean, activatedAt: string|null, paymentId: string|null, orderId: string|null}>}
 */
const usersStore = new Map();

/**
 * Générer un orderId unique pour tracer un paiement.
 * Format : OMNI-GP-<timestamp>-<5 chars aléatoires>
 *
 * @returns {string}
 */
function generateOrderId() {
  return `OMNI-GP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

// ══════════════════════════════════════════════════════════════
//  HELPERS FIRESTORE (optionnel — non bloquant si absent)
// ══════════════════════════════════════════════════════════════

/**
 * Lire le statut premium d'un utilisateur depuis Firestore.
 * Si Firestore est indisponible, retourne null sans planter.
 *
 * @param {string} userId
 * @returns {Promise<boolean|null>} true/false si Firestore répond, null sinon
 */
async function readPremiumFromFirestore(userId) {
  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('users').doc(userId).get();
    if (!snap.exists) return false;
    return snap.data()?.isSubscribed === true;
  } catch {
    return null;  // Firestore non dispo — on utilise usersStore
  }
}

/**
 * Écrire le statut premium d'un utilisateur dans Firestore.
 * Non bloquant — les erreurs sont loguées mais ne propagent pas.
 *
 * @param {string} userId
 * @param {object} data
 */
async function writePremiumToFirestore(userId, data) {
  try {
    const db  = require('../config/firebase');
    const now = new Date().toISOString();
    await db.collection('users').doc(userId).set(
      {
        isSubscribed : true,
        subscribedAt : data.activatedAt || now,
        paymentMethod: 'geniuspay',
        paymentId    : data.paymentId   || null,
        orderId      : data.orderId     || null,
        updatedAt    : now,
      },
      { merge: true }
    );

    // Historique des abonnements
    await db.collection('subscriptions').add({
      userId,
      isSubscribed : true,
      subscribedAt : data.activatedAt || now,
      paymentMethod: 'geniuspay',
      paymentId    : data.paymentId   || null,
      orderId      : data.orderId     || null,
      amount       : geniuspay.PREMIUM_AMOUNT,
      currency     : geniuspay.PREMIUM_CURRENCY,
      app          : 'OmniSMS',
      createdAt    : now,
    });

    logger.info('[PaymentController] Firestore mis à jour — premium activé', { userId });
  } catch (err) {
    logger.warn('[PaymentController] Firestore indisponible — premium stocké en mémoire uniquement', {
      userId,
      error: err.message,
    });
  }
}

/**
 * Sauvegarder un paiement en cours dans Firestore.
 * Collection : geniuspay_payments / document : orderId
 *
 * @param {string} orderId
 * @param {object} data
 */
async function savePaymentToFirestore(orderId, data) {
  try {
    const db = require('../config/firebase');
    await db
      .collection('geniuspay_payments')
      .doc(orderId)
      .set(
        { ...data, updatedAt: new Date().toISOString() },
        { merge: true }
      );
  } catch (err) {
    logger.warn('[PaymentController] Impossible de sauvegarder paiement Firestore', {
      orderId,
      error: err.message,
    });
  }
}

// ══════════════════════════════════════════════════════════════
//  ACTION : CRÉER UN PAIEMENT
// ══════════════════════════════════════════════════════════════

/**
 * Créer un paiement GeniusPay et retourner l'URL Checkout.
 *
 * POST /api/payment/geniuspay
 * Body : { userId, amount? }
 *
 * @param {express.Request}  req
 * @param {express.Response} res
 */
async function createPayment(req, res) {
  const { userId, amount, phone } = req.body;

  // ── Validation de base ───────────────────────────────────────
  if (!userId || typeof userId !== 'string' || userId.trim().length < 1) {
    return res.status(400).json({
      success: false,
      error  : 'userId est requis.',
      code   : 'MISSING_USER_ID',
    });
  }

  const cleanUserId = userId.trim();

  // ── Vérification clés GeniusPay ──────────────────────────────
  if (!geniuspay.isConfigured()) {
    logger.error('[PaymentController] GeniusPay non configuré — clés manquantes');
    return res.status(503).json({
      success: false,
      error  : 'Système de paiement non disponible. Contactez l\'administrateur.',
      code   : 'GENIUSPAY_NOT_CONFIGURED',
    });
  }

  // ── Anti double-activation : vérifier si déjà premium ────────
  try {
    const alreadyPremium = usersStore.get(cleanUserId)?.premium
      || (await readPremiumFromFirestore(cleanUserId));

    if (alreadyPremium) {
      logger.info('[PaymentController] Utilisateur déjà premium', { userId: cleanUserId });
      return res.status(400).json({
        success          : false,
        error            : 'Cet utilisateur est déjà abonné OmniSMS Premium.',
        code             : 'ALREADY_SUBSCRIBED',
        alreadySubscribed: true,
      });
    }
  } catch (err) {
    logger.warn('[PaymentController] Impossible de vérifier le statut premium', { error: err.message });
    // On continue — mieux vaut laisser passer qu'bloquer
  }

  // ── Construire les URLs de callback ──────────────────────────
  const orderId    = generateOrderId();
  const backendUrl = process.env.BACKEND_URL || 'https://omnisms-backend.onrender.com';
  const returnUrl  = `${backendUrl}/api/payment/geniuspay/return?orderId=${encodeURIComponent(orderId)}&userId=${encodeURIComponent(cleanUserId)}`;
  const webhookUrl = `${backendUrl}/api/payment/webhook`;

  // ── Sauvegarder l'état "pending" avant l'appel API ───────────
  await savePaymentToFirestore(orderId, {
    userId   : cleanUserId,
    phone    : phone || null,
    status   : 'pending',
    amount   : geniuspay.PREMIUM_AMOUNT,
    currency : geniuspay.PREMIUM_CURRENCY,
    orderId,
    createdAt: new Date().toISOString(),
    ip       : req.ip || '0.0.0.0',
    source   : 'api',
  });

  // ── Appeler l'API GeniusPay ───────────────────────────────────
  let result;
  try {
    result = await geniuspay.createPayment({
      userId     : cleanUserId,
      amount     : amount || geniuspay.PREMIUM_AMOUNT,
      phone,
      orderId,
      returnUrl,
      webhookUrl,
      description: 'OmniSMS abonnement',
    });
  } catch (err) {
    await savePaymentToFirestore(orderId, { status: 'error', errorMessage: err.message });

    logger.error('[PaymentController] Erreur API GeniusPay', {
      userId: cleanUserId,
      error : err.message,
      code  : err.response?.data?.code || 'UNKNOWN',
    });

    return res.status(502).json({
      success: false,
      error  : 'Impossible de contacter le service de paiement. Réessayez dans quelques instants.',
      code   : 'GENIUSPAY_API_ERROR',
      detail : process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }

  // ── Mettre à jour Firestore avec le paymentId reçu ───────────
  await savePaymentToFirestore(orderId, {
    paymentId  : result.paymentId,
    checkoutUrl: result.checkout_url,
    status     : 'pending',
  });

  logger.info('[PaymentController] Paiement initié', {
    userId  : cleanUserId,
    orderId,
    paymentId: result.paymentId,
  });

  // ── Réponse au frontend ───────────────────────────────────────
  return res.status(200).json({
    success     : true,
    checkout_url: result.checkout_url,   // Champ exact demandé dans les specs
    checkoutUrl : result.checkout_url,   // Alias camelCase
    paymentId   : result.paymentId,
    orderId,
    amount      : geniuspay.PREMIUM_AMOUNT,
    currency    : geniuspay.PREMIUM_CURRENCY,
    message     : 'Paiement initié. Redirigez l\'utilisateur vers checkout_url.',
  });
}

// ══════════════════════════════════════════════════════════════
//  ACTION : TRAITER LE WEBHOOK
// ══════════════════════════════════════════════════════════════

/**
 * Traiter une notification webhook de GeniusPay.
 *
 * POST /api/payment/webhook
 *
 * Flux :
 *   1. Log immédiat de la réception
 *   2. Vérification signature HMAC (si GENIUSPAY_WEBHOOK_SECRET défini)
 *   3. Vérification payment.status === "success"
 *   4. Extraction userId depuis metadata
 *   5. Activation premium utilisateur (usersStore + Firestore)
 *   6. Réponse 200 immédiate à GeniusPay
 *
 * @param {express.Request}  req
 * @param {express.Response} res
 */
async function handleWebhook(req, res) {
  const rawBody   = req.rawBody || JSON.stringify(req.body || {});
  const signature = req.headers['x-genius-signature'] || req.headers['x-geniuspay-signature'] || '';
  const body      = req.body || {};

  // ── Log de toute réception webhook ──────────────────────────
  logger.info('[Webhook] Réception GeniusPay', {
    ip       : req.ip,
    status   : body.status,
    reference: body.id || body.reference || body.payment_id,
    amount   : body.amount,
    headers  : {
      signature: signature ? signature.substring(0, 20) + '…' : 'absent',
      contentType: req.headers['content-type'],
    },
  });

  // ── Réponse immédiate 200 à GeniusPay (évite les timeouts) ──
  // Le traitement se fait en setImmediate pour ne pas bloquer
  res.status(200).json({ received: true, timestamp: new Date().toISOString() });

  // ── Traitement asynchrone ─────────────────────────────────
  setImmediate(async () => {
    try {
      await processWebhookPayload(body, rawBody, signature);
    } catch (err) {
      logger.error('[Webhook] Erreur traitement asynchrone', { error: err.message });
    }
  });
}

/**
 * Traiter le payload webhook de façon asynchrone.
 * Séparé de handleWebhook pour faciliter les tests.
 *
 * @param {object} body      - Corps JSON du webhook
 * @param {string} rawBody   - Corps brut (pour HMAC)
 * @param {string} signature - Header de signature
 */
async function processWebhookPayload(body, rawBody, signature) {
  // ── 1. Vérification signature HMAC ───────────────────────────
  if (!geniuspay.verifyWebhookSignature(rawBody, signature)) {
    logger.error('[Webhook] Signature invalide — webhook ignoré', {
      signature: signature ? signature.substring(0, 20) + '…' : 'absent',
    });
    return;
  }

  // ── 2. Extraire les champs clés ──────────────────────────────
  const status    = (body.status   || '').toLowerCase();
  const amount    = Number(body.amount) || 0;
  const paymentId = body.id             || body.payment_id  || body.reference || null;
  const metadata  = body.metadata       || body.meta        || {};
  const userId    = metadata.userId     || body.userId       || body.customer?.userId || null;
  const orderId   = metadata.orderId    || body.orderId      || paymentId || 'unknown';

  logger.info('[Webhook] Payload décodé', { status, paymentId, userId, orderId, amount });

  // ── 3. Vérifier que le paiement est bien un succès ───────────
  const isSuccess = ['success', 'paid', 'completed', 'successful'].includes(status);
  const isFailed  = ['failed', 'cancelled', 'expired', 'refunded'].includes(status);
  const isPending = ['pending', 'processing', 'initiated'].includes(status);

  if (isSuccess) {
    await handleSuccessfulPayment({ paymentId, userId, orderId, amount, status, body });

  } else if (isFailed) {
    logger.info('[Webhook] Paiement ÉCHOUÉ/ANNULÉ', { orderId, paymentId, status });
    await savePaymentToFirestore(orderId, {
      status      : 'failed',
      paymentId,
      userId,
      failedAt    : new Date().toISOString(),
      webhookStatus: status,
    });

  } else if (isPending) {
    logger.info('[Webhook] Paiement EN ATTENTE', { orderId, status });
    await savePaymentToFirestore(orderId, {
      status      : 'processing',
      paymentId,
      userId,
      webhookStatus: status,
    });

  } else {
    logger.info('[Webhook] Statut inconnu — ignoré', { status, orderId, paymentId });
  }
}

/**
 * Gérer un paiement confirmé avec succès.
 * Active le premium utilisateur de façon idempotente.
 *
 * @param {object} params
 */
async function handleSuccessfulPayment({ paymentId, userId, orderId, amount, status, body }) {
  logger.info('[Webhook] Paiement CONFIRMÉ ✅', { orderId, paymentId, userId, amount });

  // Mettre à jour Firestore avec le statut "paid"
  await savePaymentToFirestore(orderId, {
    status      : 'paid',
    paymentId,
    userId,
    amount,
    paidAt      : new Date().toISOString(),
    webhookStatus: status,
    rawWebhook  : body,
  });

  if (!userId) {
    logger.warn('[Webhook] Paiement confirmé mais userId absent dans metadata', {
      orderId,
      paymentId,
      hint: 'Vérifiez que le champ metadata.userId est bien envoyé lors de la création du paiement.',
    });
    return;
  }

  // ── Activation premium — idempotente ──────────────────────────
  // Vérifier d'abord le flag premiumActivated dans Firestore
  try {
    const db      = require('../config/firebase');
    const paySnap = await db.collection('geniuspay_payments').doc(orderId).get();
    if (paySnap.exists && paySnap.data()?.premiumActivated === true) {
      logger.info('[Webhook] Premium déjà activé pour ce paiement (idempotence)', { orderId, userId });
      return;
    }
  } catch { /* Firestore non dispo — continuer */ }

  // Activer en mémoire immédiatement
  const now = new Date().toISOString();
  usersStore.set(userId, {
    premium    : true,
    activatedAt: now,
    paymentId,
    orderId,
  });

  logger.info('[Webhook] Premium activé en mémoire', { userId });

  // Persister dans Firestore
  await writePremiumToFirestore(userId, { activatedAt: now, paymentId, orderId });

  // Marquer le paiement comme ayant déclenché l'activation
  await savePaymentToFirestore(orderId, {
    premiumActivated: true,
    activatedAt     : now,
  });

  logger.info('[Webhook] Activation premium terminée ✅', { userId, orderId });
}

// ══════════════════════════════════════════════════════════════
//  ACTION : VÉRIFIER LE STATUT PREMIUM
// ══════════════════════════════════════════════════════════════

/**
 * Retourner le statut premium d'un utilisateur.
 *
 * GET /api/user/status?userId=xxx
 * Réponse : { premium: true/false }
 *
 * Priorité de lecture : usersStore (mémoire) → Firestore → false
 *
 * @param {express.Request}  req
 * @param {express.Response} res
 */
async function getUserStatus(req, res) {
  // req.cleanedQuery = sanitized query (req.query is getter-only in Node/Express 5)
  const cq = req.cleanedQuery || {};
  const userId = (cq.userId || (req.query && req.query.userId) || req.body?.userId || req._userId || '').trim();

  if (!userId) {
    return res.status(400).json({
      success: false,
      error  : 'userId requis (?userId=XXX)',
      code   : 'MISSING_USER_ID',
    });
  }

  // ── 1. Vérifier en mémoire ───────────────────────────────────
  const inMemory = usersStore.get(userId);
  if (inMemory?.premium === true) {
    return res.status(200).json({
      success     : true,
      userId,
      premium     : true,
      isSubscribed: true,
      activatedAt : inMemory.activatedAt  || null,
      source      : 'memory',
    });
  }

  // ── 2. Vérifier dans Firestore ───────────────────────────────
  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('users').doc(userId).get();

    if (snap.exists) {
      const user    = snap.data();
      const premium = user.isSubscribed === true;

      // Synchroniser en mémoire si premium
      if (premium) {
        usersStore.set(userId, {
          premium    : true,
          activatedAt: user.subscribedAt || null,
          paymentId  : user.paymentId    || null,
          orderId    : user.orderId      || null,
        });
      }

      return res.status(200).json({
        success      : true,
        userId,
        premium,
        isSubscribed : premium,
        subscribedAt : user.subscribedAt   || null,
        paymentMethod: user.paymentMethod  || null,
        source       : 'firestore',
      });
    }
  } catch (err) {
    logger.warn('[UserStatus] Firestore indisponible — fallback mémoire', { error: err.message, userId });
  }

  // ── 3. Fallback : utilisateur non trouvé ──────────────────────
  return res.status(200).json({
    success     : true,
    userId,
    premium     : false,
    isSubscribed: false,
    source      : 'not_found',
  });
}

// ══════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════
module.exports = {
  createPayment,
  handleWebhook,
  getUserStatus,
  processWebhookPayload,  // Exporté pour les tests
  usersStore,             // Exporté pour inspection / tests
  generateOrderId,
};
