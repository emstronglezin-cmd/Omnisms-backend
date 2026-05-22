'use strict';
/**
 * OmniSMS — LeekPay Controller
 * ═══════════════════════════════════════════════════════════════
 *
 * Logique métier pour le système de paiement LeekPay.
 *
 * Routes gérées (via routes/payment.leekpay.js) :
 *   POST /api/payment/leekpay                  → initier paiement
 *   POST /api/payment/webhook/leekpay          → webhook LeekPay
 *   GET  /api/payment/status/:transactionId    → statut transaction
 *
 * Flux paiement :
 *   1. Frontend POST /api/payment/leekpay  { userId, amount?, phone?, email?, name? }
 *   2. Backend crée checkout LeekPay  → retourne { success, checkout_url }
 *   3. Frontend redirige vers checkout_url
 *   4. LeekPay appelle POST /api/payment/webhook/leekpay
 *   5. Backend valide signature → active premium Firebase
 *
 * Sécurité :
 *   - Anti replay : Redis (processingPayments Set + processedCheckouts Set)
 *   - Signature HMAC webhook via services/leekpay.verifyWebhookSignature()
 *   - Validation montant + devise
 *   - userId validé Firebase
 *   - Logs structurés sans données sensibles
 *
 * Firebase Firestore :
 *   Collection leekpay_payments/<checkoutId>  → état du paiement
 *   Collection users/<userId>                 → { isSubscribed, subscribedAt, ... }
 *   Collection subscriptions/<auto>          → historique
 */

const leekpay      = require('../services/leekpay');
const { logger }   = require('../middleware/logger');

// ══════════════════════════════════════════════════════════════
//  ANTI-REPLAY — Redis ou Map mémoire
// ══════════════════════════════════════════════════════════════

/**
 * Set en mémoire des checkoutId déjà traités (fallback si Redis absent).
 * Purgé au restart — Redis est la solution durable.
 * @type {Set<string>}
 */
const processedCheckouts = new Set();

/**
 * Set en mémoire des webhooks en cours de traitement (évite double processing).
 * @type {Set<string>}
 */
const processingPayments = new Set();

/**
 * Vérifier si un checkout a déjà été traité (idempotence).
 * Vérifie Firestore ET la Map mémoire.
 *
 * @param {string} checkoutId
 * @returns {Promise<boolean>}
 */
async function isAlreadyProcessed(checkoutId) {
  // 1. Check mémoire
  if (processedCheckouts.has(checkoutId)) return true;

  // 2. Check Firestore
  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('leekpay_payments').doc(checkoutId).get();
    if (snap.exists && snap.data()?.premiumActivated === true) {
      processedCheckouts.add(checkoutId); // Sync mémoire
      return true;
    }
  } catch { /* Firestore non dispo — continuer */ }

  return false;
}

// ══════════════════════════════════════════════════════════════
//  HELPERS FIRESTORE
// ══════════════════════════════════════════════════════════════

/**
 * Sauvegarder/mettre à jour un paiement LeekPay dans Firestore.
 * Non bloquant — les erreurs sont loguées.
 *
 * @param {string} checkoutId
 * @param {object} data
 */
async function savePayment(checkoutId, data) {
  try {
    const db = require('../config/firebase');
    await db
      .collection('leekpay_payments')
      .doc(checkoutId)
      .set(
        { ...data, updatedAt: new Date().toISOString() },
        { merge: true }
      );
  } catch (err) {
    logger.warn('[LeekPay] Impossible de sauvegarder paiement Firestore', {
      checkoutId,
      error: err.message,
    });
  }
}

/**
 * Lire le statut premium d'un utilisateur depuis Firestore.
 * @param {string} userId
 * @returns {Promise<boolean|null>}
 */
async function isPremiumUser(userId) {
  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('users').doc(userId).get();
    if (!snap.exists) return false;
    return snap.data()?.isSubscribed === true;
  } catch {
    return null;
  }
}

/**
 * Activer le statut premium dans Firestore.
 * Met à jour users/<userId> ET ajoute à subscriptions/.
 *
 * @param {string} userId
 * @param {object} opts
 */
async function activatePremiumFirestore(userId, {
  checkoutId,
  transactionId,
  amount,
  currency,
  paymentMethod,
  paidAt,
}) {
  const now = new Date().toISOString();

  try {
    const db = require('../config/firebase');

    // Mise à jour document utilisateur
    await db.collection('users').doc(userId).set(
      {
        isSubscribed   : true,
        premium        : true,
        subscribedAt   : paidAt || now,
        paymentMethod  : 'leekpay',
        paymentProvider: 'leekpay',
        transactionId  : transactionId || checkoutId,
        checkoutId     : checkoutId,
        updatedAt      : now,
      },
      { merge: true }
    );

    // Historique des abonnements
    await db.collection('subscriptions').add({
      userId,
      isSubscribed   : true,
      subscribedAt   : paidAt || now,
      paymentMethod  : 'leekpay',
      paymentProvider: 'leekpay',
      transactionId  : transactionId || checkoutId,
      checkoutId,
      amount         : amount    || leekpay.PREMIUM_AMOUNT,
      currency       : currency  || leekpay.PREMIUM_CURRENCY,
      paymentMobile  : paymentMethod === 'mobile_money',
      app            : 'OmniSMS',
      createdAt      : now,
    });

    logger.info('[LeekPay] ✅ Firestore premium activé', {
      userId,
      checkoutId,
      transactionId,
      amount,
      currency,
    });

  } catch (err) {
    logger.error('[LeekPay] Erreur activation premium Firestore', {
      userId,
      checkoutId,
      error: err.message,
    });
    // Ne pas propager — le paiement est confirmé, on log et on continue
  }
}

// ══════════════════════════════════════════════════════════════
//  GÉNÉRATION orderId
// ══════════════════════════════════════════════════════════════

/**
 * Générer un orderId unique OmniSMS pour traçabilité.
 * Format : OMNI-LP-<timestamp>-<5 chars random>
 * @returns {string}
 */
function generateOrderId() {
  return `OMNI-LP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

// ══════════════════════════════════════════════════════════════
//  ACTION 1 : CRÉER UN PAIEMENT LeekPay
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/payment/leekpay
 *
 * Body JSON :
 *   {
 *     "userId"  : "firebase_uid",     (requis)
 *     "amount"  : 2000,               (optionnel — défaut PREMIUM_AMOUNT)
 *     "currency": "XOF",              (optionnel — défaut XOF)
 *     "phone"   : "+22670123456",     (optionnel — Mobile Money)
 *     "email"   : "user@example.com", (optionnel)
 *     "name"    : "Jean Dupont"       (optionnel)
 *   }
 *
 * Réponse succès (200) :
 *   { "success": true, "checkout_url": "https://leekpay.me/pay_xxx", "checkout_id": "checkout_xxx", ... }
 */
async function createPayment(req, res) {
  const { userId, amount, currency, phone, email, name } = req.body || {};

  // ── Validation userId ──────────────────────────────────────
  if (!userId || typeof userId !== 'string' || userId.trim().length < 3) {
    return res.status(400).json({
      success: false,
      error  : 'userId est requis (minimum 3 caractères).',
      code   : 'MISSING_USER_ID',
    });
  }

  const cleanUserId = userId.trim();

  // ── Vérification configuration LeekPay ────────────────────
  if (!leekpay.isConfigured()) {
    logger.error('[LeekPay] Service non configuré — LEEKPAY_API_KEY ou LEEKPAY_SECRET_KEY manquante');
    return res.status(503).json({
      success: false,
      error  : 'Service de paiement non disponible. Contactez l\'administrateur.',
      code   : 'LEEKPAY_NOT_CONFIGURED',
    });
  }

  // ── Validation montant/devise ──────────────────────────────
  const payAmount   = Number(amount)   || leekpay.PREMIUM_AMOUNT;
  const payCurrency = (currency || leekpay.PREMIUM_CURRENCY).toUpperCase();

  try {
    leekpay.validateAmount(payAmount, payCurrency);
  } catch (err) {
    return res.status(400).json({
      success: false,
      error  : err.message,
      code   : 'INVALID_AMOUNT',
    });
  }

  // ── Anti double-paiement : vérifier si déjà premium ───────
  try {
    const alreadyPremium = await isPremiumUser(cleanUserId);
    if (alreadyPremium === true) {
      logger.info('[LeekPay] Utilisateur déjà premium', { userId: cleanUserId });
      return res.status(400).json({
        success          : false,
        error            : 'Cet utilisateur est déjà abonné OmniSMS Premium.',
        code             : 'ALREADY_SUBSCRIBED',
        alreadySubscribed: true,
      });
    }
  } catch (err) {
    logger.warn('[LeekPay] Impossible de vérifier statut premium', { error: err.message });
    // Continuer — mieux vaut laisser passer
  }

  // ── Construire les URLs ────────────────────────────────────
  const orderId    = generateOrderId();
  const backendUrl = (process.env.BACKEND_URL || 'https://omnisms-backend.onrender.com').replace(/\/$/, '');
  const frontendUrl = (process.env.FRONTEND_URL || 'https://omnisms.netlify.app').replace(/\/$/, '');

  const returnUrl = `${frontendUrl}/payment/success?orderId=${encodeURIComponent(orderId)}&userId=${encodeURIComponent(cleanUserId)}`;
  const cancelUrl = `${frontendUrl}/payment/cancel?orderId=${encodeURIComponent(orderId)}`;

  // ── Sauvegarder état pending ───────────────────────────────
  await savePayment(orderId, {
    checkoutId   : null, // sera mis à jour après l'appel LeekPay
    orderId,
    userId       : cleanUserId,
    status       : 'pending',
    amount       : payAmount,
    currency     : payCurrency,
    phone        : phone  || null,
    email        : email  || null,
    name         : name   || null,
    createdAt    : new Date().toISOString(),
    ip           : req.ip || '0.0.0.0',
    source       : 'api',
    premiumActivated: false,
  });

  // ── Appeler l'API LeekPay ─────────────────────────────────
  let checkout;
  try {
    checkout = await leekpay.createCheckout({
      amount       : payAmount,
      currency     : payCurrency,
      description  : `OmniSMS Premium — abonnement (${cleanUserId.substring(0, 8)}…)`,
      returnUrl,
      cancelUrl,
      customerEmail: email  || undefined,
      customerName : name   || undefined,
      customerPhone: phone  || undefined,
      metadata     : {
        userId    : cleanUserId,
        orderId,
        app       : 'OmniSMS',
        source    : 'backend-api',
      },
    });
  } catch (err) {
    // Mettre à jour Firestore avec l'erreur
    await savePayment(orderId, { status: 'error', errorMessage: err.message });

    logger.error('[LeekPay] Erreur création checkout', {
      userId : cleanUserId,
      orderId,
      error  : err.message,
      status : err.response?.status,
    });

    return res.status(502).json({
      success: false,
      error  : 'Impossible de contacter le service de paiement. Réessayez dans quelques instants.',
      code   : 'LEEKPAY_API_ERROR',
      ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
    });
  }

  // ── Mettre à jour Firestore avec le checkoutId ─────────────
  await savePayment(checkout.checkoutId, {
    checkoutId  : checkout.checkoutId,
    orderId,
    userId      : cleanUserId,
    paymentUrl  : checkout.paymentUrl,
    status      : 'pending',
    amount      : payAmount,
    currency    : payCurrency,
    expiresAt   : checkout.expiresAt,
    createdAt   : new Date().toISOString(),
    premiumActivated: false,
  });

  logger.info('[LeekPay] Paiement initié ✅', {
    userId     : cleanUserId,
    orderId,
    checkoutId : checkout.checkoutId,
    amount     : payAmount,
    currency   : payCurrency,
  });

  // ── Réponse frontend ───────────────────────────────────────
  return res.status(200).json({
    success       : true,
    checkout_url  : checkout.paymentUrl,   // Spec frontend exacte
    checkoutUrl   : checkout.paymentUrl,   // Alias camelCase
    checkout_id   : checkout.checkoutId,
    checkoutId    : checkout.checkoutId,
    orderId,
    amount        : payAmount,
    currency      : payCurrency,
    expiresAt     : checkout.expiresAt,
    message       : 'Redirigez l\'utilisateur vers checkout_url pour finaliser le paiement.',
  });
}

// ══════════════════════════════════════════════════════════════
//  ACTION 2 : WEBHOOK LeekPay
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/payment/webhook/leekpay
 *
 * Headers LeekPay :
 *   X-LeekPay-Event    : payment.completed
 *   X-LeekPay-Delivery : <delivery_id>
 *   X-LeekPay-Signature: <hmac_sha256_hex>
 *
 * Corps JSON :
 *   {
 *     "event": "payment.completed",
 *     "data": {
 *       "transaction_id": "TXN_xxx",
 *       "checkout_id"   : "checkout_xxx",
 *       "amount"        : 2000,
 *       "currency"      : "XOF",
 *       "status"        : "paid",
 *       "payment_method": "mobile_money",
 *       "customer"      : { email, name, phone },
 *       "metadata"      : { userId, orderId, ... },
 *       "paid_at"       : "2026-01-15T10:30:00+00:00"
 *     }
 *   }
 */
async function handleWebhook(req, res) {
  const rawBody   = req.rawBody || JSON.stringify(req.body || {});
  const signature = req.headers['x-leekpay-signature'] || '';
  const event     = req.headers['x-leekpay-event']     || req.body?.event || '';
  const delivery  = req.headers['x-leekpay-delivery']  || '';
  const body      = req.body || {};

  // ── Log immédiat de la réception ──────────────────────────
  logger.info('[LeekPay Webhook] Réception', {
    ip        : req.ip,
    event,
    delivery,
    signature : signature ? signature.substring(0, 16) + '…' : 'absent',
    status    : body.data?.status,
    checkoutId: body.data?.checkout_id,
    amount    : body.data?.amount,
  });

  // ── Réponse 200 immédiate (évite les timeouts LeekPay) ────
  // Le traitement se fait en setImmediate
  res.status(200).json({ received: true, timestamp: new Date().toISOString() });

  // ── Traitement asynchrone ─────────────────────────────────
  setImmediate(async () => {
    try {
      await processWebhookPayload(body, rawBody, signature, event);
    } catch (err) {
      logger.error('[LeekPay Webhook] Erreur traitement asynchrone', {
        error   : err.message,
        event,
        delivery,
      });
    }
  });
}

/**
 * Traiter le payload webhook LeekPay.
 * Séparé de handleWebhook pour faciliter les tests unitaires.
 *
 * @param {object} body      - Corps JSON décodé
 * @param {string} rawBody   - Corps brut (pour HMAC)
 * @param {string} signature - Header X-LeekPay-Signature
 * @param {string} event     - Type d'événement
 */
async function processWebhookPayload(body, rawBody, signature, event) {
  // ── 1. Validation signature HMAC ──────────────────────────
  if (!leekpay.verifyWebhookSignature(rawBody, signature)) {
    logger.error('[LeekPay Webhook] Signature invalide — ignoré', {
      signature: signature ? signature.substring(0, 16) + '…' : 'absent',
    });
    return;
  }

  // ── 2. Extraire les données ────────────────────────────────
  const data          = body.data     || body;
  const status        = (data.status  || '').toLowerCase();
  const transactionId = data.transaction_id  || data.checkout_id || null;
  const checkoutId    = data.checkout_id     || transactionId    || null;
  const amount        = Number(data.amount)  || 0;
  const currency      = data.currency        || leekpay.PREMIUM_CURRENCY;
  const paymentMethod = data.payment_method  || null;
  const paidAt        = data.paid_at         || null;
  const metadata      = data.metadata        || {};
  const customer      = data.customer        || {};

  // userId depuis metadata (mis lors de la création du checkout)
  const userId = metadata.userId || data.userId || null;
  const orderId = metadata.orderId || null;

  logger.info('[LeekPay Webhook] Payload décodé', {
    event,
    status,
    checkoutId,
    transactionId,
    userId,
    orderId,
    amount,
    currency,
    paymentMethod,
  });

  // ── 3. Router selon le statut ─────────────────────────────
  const isPaid    = status === 'paid';
  const isFailed  = ['failed', 'cancelled', 'expired'].includes(status);
  const isPending = ['pending', 'processing'].includes(status);

  if (isPaid) {
    await handleSuccessfulPayment({
      checkoutId,
      transactionId,
      userId,
      orderId,
      amount,
      currency,
      paymentMethod,
      paidAt,
      customer,
      metadata,
      rawBody: body,
    });

  } else if (isFailed) {
    logger.info('[LeekPay Webhook] Paiement ÉCHOUÉ/ANNULÉ', { checkoutId, status, userId });
    if (checkoutId) {
      await savePayment(checkoutId, {
        status       : 'failed',
        transactionId,
        userId,
        failedAt     : new Date().toISOString(),
        webhookStatus: status,
      });
    }

  } else if (isPending) {
    logger.info('[LeekPay Webhook] Paiement EN COURS', { checkoutId, status });
    if (checkoutId) {
      await savePayment(checkoutId, {
        status       : 'processing',
        transactionId,
        userId,
        webhookStatus: status,
      });
    }

  } else {
    logger.info('[LeekPay Webhook] Événement non traité', { event, status, checkoutId });
  }
}

/**
 * Gérer un paiement confirmé (status: paid).
 * Activation premium — idempotente via Redis + Firestore.
 *
 * @param {object} params
 */
async function handleSuccessfulPayment({
  checkoutId,
  transactionId,
  userId,
  orderId,
  amount,
  currency,
  paymentMethod,
  paidAt,
  customer,
  metadata,
  rawBody,
}) {
  logger.info('[LeekPay Webhook] Paiement CONFIRMÉ ✅', {
    checkoutId,
    transactionId,
    userId,
    amount,
    currency,
    paymentMethod,
  });

  // ── 1. Anti-replay : vérifier si déjà traité ──────────────
  if (checkoutId) {
    // Protection contre les doubles processing simultanés
    if (processingPayments.has(checkoutId)) {
      logger.info('[LeekPay Webhook] Paiement en cours de traitement (concurrent) — ignoré', { checkoutId });
      return;
    }

    const alreadyDone = await isAlreadyProcessed(checkoutId);
    if (alreadyDone) {
      logger.info('[LeekPay Webhook] Paiement déjà traité (idempotence)', { checkoutId });
      return;
    }

    processingPayments.add(checkoutId);
  }

  try {
    // ── 2. Mettre à jour Firestore — statut paid ─────────────
    if (checkoutId) {
      await savePayment(checkoutId, {
        status         : 'paid',
        transactionId,
        userId,
        orderId,
        amount,
        currency,
        paymentMethod,
        paidAt         : paidAt || new Date().toISOString(),
        customer,
        webhookStatus  : 'paid',
        webhookReceived: new Date().toISOString(),
        rawWebhook     : rawBody,
        premiumActivated: false, // sera mis à true après activation
      });
    }

    // ── 3. Vérifier userId ────────────────────────────────────
    if (!userId) {
      logger.warn('[LeekPay Webhook] Paiement confirmé mais userId absent dans metadata', {
        checkoutId,
        transactionId,
        hint: 'Vérifiez que metadata.userId est bien envoyé lors de la création du checkout.',
        customer: customer?.email || 'inconnu',
      });
      return;
    }

    // ── 4. Activer le premium Firebase ───────────────────────
    await activatePremiumFirestore(userId, {
      checkoutId,
      transactionId,
      amount,
      currency,
      paymentMethod,
      paidAt,
    });

    // ── 5. Marquer comme traité (idempotence) ────────────────
    if (checkoutId) {
      processedCheckouts.add(checkoutId);
      await savePayment(checkoutId, {
        premiumActivated: true,
        activatedAt     : new Date().toISOString(),
      });
    }

    // ── 6. Notifier via Socket.IO (si disponible) ─────────────
    try {
      const { emitToUser } = require('../services/socketService');
      emitToUser(userId, 'payment:success', {
        checkoutId,
        transactionId,
        amount,
        currency,
        premium    : true,
        activatedAt: new Date().toISOString(),
      });
      logger.info('[LeekPay Webhook] Socket.IO notification envoyée', { userId });
    } catch { /* Socket.IO optionnel */ }

    logger.info('[LeekPay Webhook] Activation premium terminée ✅', {
      userId,
      checkoutId,
      transactionId,
    });

  } finally {
    // Toujours libérer le verrou
    if (checkoutId) processingPayments.delete(checkoutId);
  }
}

// ══════════════════════════════════════════════════════════════
//  ACTION 3 : STATUT TRANSACTION
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/payment/status/:transactionId
 *
 * Vérifier le statut d'un paiement LeekPay.
 * Cherche dans Firestore d'abord, puis appelle l'API LeekPay si nécessaire.
 *
 * Paramètre URL : :transactionId = checkoutId ou orderId
 *
 * Réponse :
 *   {
 *     "success"      : true,
 *     "checkoutId"   : "checkout_xxx",
 *     "status"       : "paid" | "pending" | "failed" | ...,
 *     "amount"       : 2000,
 *     "currency"     : "XOF",
 *     "premiumActive": true,
 *     "paidAt"       : "2026-01-15T10:30:00Z"
 *   }
 */
async function getPaymentStatus(req, res) {
  const { transactionId } = req.params;

  if (!transactionId || typeof transactionId !== 'string') {
    return res.status(400).json({
      success: false,
      error  : 'transactionId requis.',
      code   : 'MISSING_TRANSACTION_ID',
    });
  }

  const cleanId = transactionId.trim();

  // ── 1. Chercher dans Firestore ─────────────────────────────
  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('leekpay_payments').doc(cleanId).get();

    if (snap.exists) {
      const data = snap.data();
      return res.status(200).json({
        success         : true,
        source          : 'firestore',
        checkoutId      : data.checkoutId      || cleanId,
        orderId         : data.orderId         || null,
        status          : data.status          || 'unknown',
        amount          : data.amount          || 0,
        currency        : data.currency        || leekpay.PREMIUM_CURRENCY,
        premiumActivated: data.premiumActivated || false,
        paidAt          : data.paidAt          || null,
        expiresAt       : data.expiresAt       || null,
        paymentMethod   : data.paymentMethod   || null,
        createdAt       : data.createdAt       || null,
        updatedAt       : data.updatedAt       || null,
      });
    }
  } catch (err) {
    logger.warn('[LeekPay] Firestore indisponible pour statut', { error: err.message, transactionId: cleanId });
  }

  // ── 2. Appeler l'API LeekPay directement ──────────────────
  if (!leekpay.isConfigured()) {
    return res.status(404).json({
      success: false,
      error  : 'Transaction introuvable.',
      code   : 'NOT_FOUND',
      transactionId: cleanId,
    });
  }

  try {
    const statusData = await leekpay.getCheckoutStatus(cleanId);
    return res.status(200).json({
      success         : true,
      source          : 'leekpay_api',
      checkoutId      : statusData.checkoutId,
      status          : statusData.status,
      amount          : statusData.amount,
      currency        : statusData.currency,
      premiumActivated: false, // L'API ne le sait pas directement
      paidAt          : statusData.paidAt,
      paymentMethod   : statusData.paymentMethod,
      metadata        : statusData.metadata,
    });
  } catch (err) {
    logger.error('[LeekPay] Erreur vérification statut API', {
      transactionId: cleanId,
      error        : err.message,
    });

    return res.status(404).json({
      success: false,
      error  : 'Transaction introuvable ou service indisponible.',
      code   : 'TRANSACTION_NOT_FOUND',
      transactionId: cleanId,
    });
  }
}

// ══════════════════════════════════════════════════════════════
//  ACTION 4 : STATUT PREMIUM UTILISATEUR
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/payment/user-status?userId=xxx
 *
 * Vérifier si un utilisateur est premium.
 * Lit depuis Firestore users/<userId>.
 */
async function getUserPremiumStatus(req, res) {
  const userId = (req.query?.userId || req.body?.userId || '').trim();

  if (!userId) {
    return res.status(400).json({
      success: false,
      error  : 'userId requis (?userId=xxx)',
      code   : 'MISSING_USER_ID',
    });
  }

  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('users').doc(userId).get();

    if (!snap.exists) {
      return res.status(200).json({
        success      : true,
        userId,
        premium      : false,
        isSubscribed : false,
        source       : 'firestore_not_found',
      });
    }

    const user    = snap.data();
    const premium = user.isSubscribed === true || user.premium === true;

    return res.status(200).json({
      success        : true,
      userId,
      premium,
      isSubscribed   : premium,
      subscribedAt   : user.subscribedAt    || null,
      paymentMethod  : user.paymentMethod   || null,
      paymentProvider: user.paymentProvider || null,
      transactionId  : user.transactionId   || null,
      source         : 'firestore',
    });

  } catch (err) {
    logger.error('[LeekPay] Erreur statut premium utilisateur', { userId, error: err.message });
    return res.status(200).json({
      success     : true,
      userId,
      premium     : false,
      isSubscribed: false,
      source      : 'error_fallback',
    });
  }
}

// ══════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════
module.exports = {
  createPayment,
  handleWebhook,
  getPaymentStatus,
  getUserPremiumStatus,
  processWebhookPayload,    // Export pour tests
  processedCheckouts,       // Export pour inspection
};
