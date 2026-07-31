'use strict';
/**
 * OmniSMS — LeekPay Controller
 * ═══════════════════════════════════════════════════════════════
 *
 * Documentation officielle LeekPay : https://leekpay.fr/docs
 *
 * Flux paiement :
 *   1. POST /api/payment/leekpay  { userId, amount?, currency?, phone?, email?, name? }
 *   2. Backend → POST https://leekpay.fr/api/v1/checkout → { data: { id, payment_url } }
 *   3. Frontend ouvre data.payment_url
 *   4. LeekPay → POST /api/payment/webhook/leekpay { event: "payment.completed", data: { status: "paid" } }
 *   5. Si aucun webhook → polling GET /api/v1/checkout/:id jusqu'à status = "paid"
 *
 * Activation premium : Firestore users/<userId>.isSubscribed = true
 */

const leekpay    = require('../services/leekpay');
const { logger } = require('../middleware/logger');

/* ═══════════════════════════════════════════════════════════════
   Anti-replay (mémoire + Firestore)
══════════════════════════════════════════════════════════════════ */
const processedCheckouts = new Set();   // checkoutId déjà activés
const processingPayments = new Set();   // en cours (anti-concurrent)

async function isAlreadyProcessed(checkoutId) {
  if (processedCheckouts.has(checkoutId)) return true;
  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('leekpay_payments').doc(checkoutId).get();
    if (snap.exists && snap.data()?.premiumActivated === true) {
      processedCheckouts.add(checkoutId);
      return true;
    }
  } catch (_) {}
  return false;
}

/* ═══════════════════════════════════════════════════════════════
   Helpers Firestore
══════════════════════════════════════════════════════════════════ */
async function savePayment(docId, data) {
  if (!docId) return;
  try {
    const db = require('../config/firebase');
    await db.collection('leekpay_payments').doc(String(docId)).set(
      { ...data, updatedAt: new Date().toISOString() },
      { merge: true }
    );
  } catch (err) {
    logger.warn('[LeekPay] Firestore savePayment error', { docId, error: err.message });
  }
}

async function isPremiumUser(userId) {
  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('users').doc(userId).get();
    return snap.exists ? snap.data()?.isSubscribed === true : false;
  } catch { return false; }
}

async function activatePremiumFirestore(userId, { checkoutId, transactionId, amount, currency, paymentMethod, paidAt }) {
  const now = new Date().toISOString();
  try {
    const db = require('../config/firebase');

    await db.collection('users').doc(userId).set({
      isSubscribed    : true,
      premium         : true,
      subscribedAt    : paidAt || now,
      paymentMethod   : 'leekpay',
      paymentProvider : 'leekpay',
      transactionId   : transactionId || checkoutId,
      checkoutId,
      updatedAt       : now,
    }, { merge: true });

    await db.collection('subscriptions').add({
      userId,
      isSubscribed  : true,
      subscribedAt  : paidAt || now,
      paymentMethod : 'leekpay',
      transactionId : transactionId || checkoutId,
      checkoutId,
      amount        : amount   || leekpay.PREMIUM_AMOUNT,
      currency      : currency || leekpay.PREMIUM_CURRENCY,
      app           : 'OmniSMS',
      createdAt     : now,
    });

    logger.info('[LeekPay] ✅ Premium activé', { userId, checkoutId, transactionId });
  } catch (err) {
    logger.error('[LeekPay] Erreur activation premium Firestore', { userId, checkoutId, error: err.message });
  }
}

function generateOrderId() {
  return `OMNI-LP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

/* ═══════════════════════════════════════════════════════════════
   POLLING — vérifier le statut après retour frontend
   Appelé si aucun webhook reçu (fallback officiel)
   Utilise GET /api/v1/checkout/:id jusqu'à status = "paid"
══════════════════════════════════════════════════════════════════ */
async function pollCheckoutStatus(checkoutId, userId, orderId, maxAttempts = 10, intervalMs = 5000) {
  let attempts = 0;

  const poll = async () => {
    attempts++;
    if (attempts > maxAttempts) {
      logger.warn('[LeekPay] Polling max attempts atteint', { checkoutId, userId });
      return;
    }

    try {
      const statusData = await leekpay.getCheckoutStatus(checkoutId);
      logger.info('[LeekPay] Polling statut', { checkoutId, status: statusData.status, attempt: attempts });

      if (statusData.isPaid || statusData.status === 'paid') {
        // Paiement confirmé → activer le premium
        const alreadyDone = await isAlreadyProcessed(checkoutId);
        if (!alreadyDone) {
          await handleSuccessfulPayment({
            checkoutId,
            transactionId: statusData.checkoutId,
            userId,
            orderId,
            amount       : statusData.amount,
            currency     : statusData.currency,
            paymentMethod: statusData.paymentMethod,
            paidAt       : statusData.paidAt,
            customer     : statusData.customer || {},
          });
        }
        return;  // polling terminé
      }

      if (['failed', 'cancelled', 'expired'].includes(statusData.status)) {
        logger.info('[LeekPay] Polling : paiement échoué/annulé', { checkoutId, status: statusData.status });
        await savePayment(checkoutId, { status: statusData.status, userId, pollEnded: true });
        return;
      }

      // Encore en cours → réessayer
      setTimeout(poll, intervalMs);

    } catch (err) {
      logger.error('[LeekPay] Erreur polling', { checkoutId, attempt: attempts, error: err.message });
      if (attempts < maxAttempts) setTimeout(poll, intervalMs * 2);
    }
  };

  setTimeout(poll, intervalMs);
}

/* ═══════════════════════════════════════════════════════════════
   ACTION 1 — Créer un paiement
   POST /api/payment/leekpay
══════════════════════════════════════════════════════════════════ */
async function createPayment(req, res) {
  const { userId, amount, currency, phone, email, name } = req.body || {};

  if (!userId || typeof userId !== 'string' || userId.trim().length < 3) {
    return res.status(400).json({
      success: false,
      error  : 'userId requis.',
      code   : 'MISSING_USER_ID',
    });
  }

  if (!leekpay.isConfigured()) {
    logger.error('[LeekPay] Non configuré — LEEKPAY_SECRET_KEY ou LEEKPAY_API_KEY manquante');
    return res.status(503).json({
      success: false,
      error  : 'Service de paiement non disponible.',
      code   : 'LEEKPAY_NOT_CONFIGURED',
    });
  }

  const cleanUserId = userId.trim();
  const payAmount   = Number(amount)   || leekpay.PREMIUM_AMOUNT;
  const payCurrency = (currency || leekpay.PREMIUM_CURRENCY).toUpperCase();

  try { leekpay.validateAmount(payAmount, payCurrency); }
  catch (err) {
    return res.status(400).json({ success: false, error: err.message, code: 'INVALID_AMOUNT' });
  }

  // Vérifier si déjà premium
  if (await isPremiumUser(cleanUserId)) {
    return res.status(400).json({
      success          : false,
      error            : 'Utilisateur déjà abonné OmniSMS Premium.',
      code             : 'ALREADY_SUBSCRIBED',
      alreadySubscribed: true,
    });
  }

  const orderId      = generateOrderId();
  const backendUrl   = (process.env.BACKEND_URL   || 'https://omnisms-backend.onrender.com').replace(/\/$/, '');
  const frontendUrl  = (process.env.FRONTEND_URL  || 'https://omnisms-frontend.vercel.app').replace(/\/$/, '');

  const returnUrl    = `${frontendUrl}/payment/success?orderId=${encodeURIComponent(orderId)}&userId=${encodeURIComponent(cleanUserId)}`;
  const cancelUrl    = `${frontendUrl}/payment/cancel?orderId=${encodeURIComponent(orderId)}`;
  const webhookUrl   = `${backendUrl}/api/payment/webhook/leekpay`;

  // Sauvegarder état pending avant l'appel API
  await savePayment(orderId, {
    orderId,
    userId     : cleanUserId,
    status     : 'pending',
    amount     : payAmount,
    currency   : payCurrency,
    phone      : phone || null,
    email      : email || null,
    name       : name  || null,
    createdAt  : new Date().toISOString(),
    premiumActivated: false,
  });

  // Appeler l'API LeekPay → POST /api/v1/checkout
  let checkout;
  try {
    checkout = await leekpay.createCheckout({
      amount       : payAmount,
      currency     : payCurrency,
      description  : `OmniSMS Premium — ${cleanUserId.substring(0, 8)}`,
      returnUrl,
      cancelUrl,
      customerEmail: email  || undefined,
      customerName : name   || undefined,
      customerPhone: phone  || undefined,
      metadata: {
        userId    : cleanUserId,
        orderId,
        app       : 'OmniSMS',
        webhookUrl,
      },
    });
  } catch (err) {
    await savePayment(orderId, { status: 'error', errorMessage: err.message });
    logger.error('[LeekPay] Erreur création checkout', { userId: cleanUserId, orderId, error: err.message });
    return res.status(502).json({
      success: false,
      error  : 'Impossible de contacter le service de paiement. Réessayez.',
      code   : 'LEEKPAY_API_ERROR',
      detail : process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }

  // Sauvegarder le checkoutId
  await savePayment(checkout.checkoutId, {
    checkoutId  : checkout.checkoutId,
    orderId,
    userId      : cleanUserId,
    paymentUrl  : checkout.paymentUrl,   // data.payment_url
    status      : 'pending',
    amount      : payAmount,
    currency    : payCurrency,
    expiresAt   : checkout.expiresAt,
    createdAt   : new Date().toISOString(),
    premiumActivated: false,
  });

  logger.info('[LeekPay] Checkout créé ✅', {
    userId    : cleanUserId,
    orderId,
    checkoutId: checkout.checkoutId,
    paymentUrl: checkout.paymentUrl,
  });

  // Lancer le polling en background (fallback si webhook non reçu)
  // Polling commence après 30s, max 12 tentatives toutes les 10s
  setTimeout(() => {
    pollCheckoutStatus(checkout.checkoutId, cleanUserId, orderId, 12, 10000);
  }, 30000);

  // Réponse au frontend
  // Le frontend doit ouvrir checkout.paymentUrl (data.payment_url)
  return res.status(200).json({
    success      : true,
    // Champ officiel de la documentation LeekPay
    payment_url  : checkout.paymentUrl,   // ← data.payment_url
    // Aliases pour compatibilité frontend
    checkout_url : checkout.paymentUrl,
    checkoutUrl  : checkout.paymentUrl,
    // Identifiants
    checkout_id  : checkout.checkoutId,
    checkoutId   : checkout.checkoutId,
    orderId,
    // Montant
    amount       : payAmount,
    currency     : payCurrency,
    expiresAt    : checkout.expiresAt,
    message      : 'Ouvrez payment_url pour finaliser le paiement.',
  });
}

/* ═══════════════════════════════════════════════════════════════
   ACTION 2 — Webhook LeekPay
   POST /api/payment/webhook/leekpay
   Event : payment.completed
══════════════════════════════════════════════════════════════════ */
async function handleWebhook(req, res) {
  const rawBody   = req.rawBody || JSON.stringify(req.body || {});
  const signature = req.headers['x-leekpay-signature'] || '';
  const event     = req.headers['x-leekpay-event']     || req.body?.event || '';
  const delivery  = req.headers['x-leekpay-delivery']  || '';
  const body      = req.body || {};

  logger.info('[LeekPay Webhook] Réception', {
    event,
    delivery,
    status    : body.data?.status || body.status,
    checkoutId: body.data?.checkout_id || body.data?.id,
  });

  // Répondre 200 immédiatement (évite timeout LeekPay)
  res.status(200).json({ received: true, timestamp: new Date().toISOString() });

  // Traitement asynchrone
  setImmediate(async () => {
    try {
      await processWebhookPayload(body, rawBody, signature, event);
    } catch (err) {
      logger.error('[LeekPay Webhook] Erreur traitement', { error: err.message, event, delivery });
    }
  });
}

async function processWebhookPayload(body, rawBody, signature, event) {
  // Vérification signature HMAC
  if (!leekpay.verifyWebhookSignature(rawBody, signature)) {
    logger.error('[LeekPay Webhook] Signature invalide — ignoré');
    return;
  }

  // Extraire les données
  const data          = body.data || body;
  const status        = (data.status || '').toLowerCase();
  // checkout_id peut être dans data.checkout_id ou data.id
  const checkoutId    = data.checkout_id || data.id || null;
  const transactionId = data.transaction_id || checkoutId;
  const amount        = Number(data.amount) || 0;
  const currency      = data.currency       || leekpay.PREMIUM_CURRENCY;
  const paymentMethod = data.payment_method || null;
  const paidAt        = data.paid_at        || null;
  const metadata      = data.metadata       || {};
  const customer      = data.customer       || {};

  // userId dans metadata (envoyé lors de la création du checkout)
  const userId  = metadata.userId  || data.userId  || null;
  const orderId = metadata.orderId || data.orderId || null;

  logger.info('[LeekPay Webhook] Payload', {
    event, status, checkoutId, transactionId, userId, amount, currency,
  });

  if (status === 'paid') {
    await handleSuccessfulPayment({
      checkoutId, transactionId, userId, orderId,
      amount, currency, paymentMethod, paidAt, customer,
    });

  } else if (['failed', 'cancelled', 'expired'].includes(status)) {
    logger.info('[LeekPay Webhook] Paiement ÉCHOUÉ', { checkoutId, status, userId });
    if (checkoutId) {
      await savePayment(checkoutId, { status, transactionId, userId, failedAt: new Date().toISOString() });
    }

  } else if (['pending', 'processing'].includes(status)) {
    logger.info('[LeekPay Webhook] Paiement EN COURS', { checkoutId, status });
    if (checkoutId) {
      await savePayment(checkoutId, { status: 'processing', transactionId, userId });
    }

  } else {
    logger.info('[LeekPay Webhook] Événement non traité', { event, status, checkoutId });
  }
}

async function handleSuccessfulPayment({ checkoutId, transactionId, userId, orderId, amount, currency, paymentMethod, paidAt, customer }) {
  logger.info('[LeekPay] Paiement confirmé (paid) ✅', { checkoutId, transactionId, userId, amount, currency });

  // Anti-concurrent
  if (checkoutId && processingPayments.has(checkoutId)) {
    logger.info('[LeekPay] Traitement concurrent — ignoré', { checkoutId });
    return;
  }

  // Anti-replay
  if (checkoutId && await isAlreadyProcessed(checkoutId)) {
    logger.info('[LeekPay] Déjà traité (idempotence)', { checkoutId });
    return;
  }

  if (checkoutId) processingPayments.add(checkoutId);

  try {
    if (checkoutId) {
      await savePayment(checkoutId, {
        status          : 'paid',
        transactionId,
        userId,
        orderId,
        amount,
        currency,
        paymentMethod,
        paidAt          : paidAt || new Date().toISOString(),
        customer,
        webhookReceived : new Date().toISOString(),
        premiumActivated: false,
      });
    }

    if (!userId) {
      logger.warn('[LeekPay] userId absent dans metadata — activation impossible', {
        checkoutId, hint: 'Vérifier metadata.userId dans createCheckout()',
      });
      return;
    }

    await activatePremiumFirestore(userId, {
      checkoutId, transactionId, amount, currency, paymentMethod, paidAt,
    });

    if (checkoutId) {
      processedCheckouts.add(checkoutId);
      await savePayment(checkoutId, {
        premiumActivated: true,
        activatedAt     : new Date().toISOString(),
      });
    }

    // Notifier via Socket.IO
    try {
      const { emitToUser } = require('../services/socketService');
      emitToUser(userId, 'payment:success', {
        checkoutId, transactionId, amount, currency, premium: true,
        activatedAt: new Date().toISOString(),
      });
    } catch (_) {}

    logger.info('[LeekPay] Activation terminée ✅', { userId, checkoutId });

  } finally {
    if (checkoutId) processingPayments.delete(checkoutId);
  }
}

/* ═══════════════════════════════════════════════════════════════
   ACTION 3 — Statut d'un paiement
   GET /api/payment/status/:transactionId
══════════════════════════════════════════════════════════════════ */
async function getPaymentStatus(req, res) {
  const { transactionId } = req.params;
  if (!transactionId) {
    return res.status(400).json({ success: false, error: 'transactionId requis.', code: 'MISSING_ID' });
  }

  const cleanId = transactionId.trim();

  // 1. Chercher dans Firestore
  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('leekpay_payments').doc(cleanId).get();
    if (snap.exists) {
      const d = snap.data();
      return res.status(200).json({
        success         : true,
        source          : 'firestore',
        checkoutId      : d.checkoutId   || cleanId,
        orderId         : d.orderId      || null,
        status          : d.status       || 'unknown',
        amount          : d.amount       || 0,
        currency        : d.currency     || leekpay.PREMIUM_CURRENCY,
        premiumActivated: d.premiumActivated || false,
        paidAt          : d.paidAt       || null,
        paymentMethod   : d.paymentMethod || null,
        updatedAt       : d.updatedAt    || null,
      });
    }
  } catch (err) {
    logger.warn('[LeekPay] Firestore indisponible pour statut', { error: err.message, transactionId: cleanId });
  }

  // 2. Appeler GET /api/v1/checkout/:id
  if (!leekpay.isConfigured()) {
    return res.status(404).json({ success: false, error: 'Transaction introuvable.', code: 'NOT_FOUND' });
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
      premiumActivated: false,
      paidAt          : statusData.paidAt,
      paymentMethod   : statusData.paymentMethod,
      isPaid          : statusData.isPaid,
    });
  } catch (err) {
    return res.status(404).json({
      success: false,
      error  : 'Transaction introuvable.',
      code   : 'NOT_FOUND',
      transactionId: cleanId,
    });
  }
}

/* ═══════════════════════════════════════════════════════════════
   ACTION 4 — Statut premium utilisateur
   GET /api/payment/user-status?userId=xxx
══════════════════════════════════════════════════════════════════ */
async function getUserPremiumStatus(req, res) {
  const userId = (req.query?.userId || req.body?.userId || '').trim();
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId requis.', code: 'MISSING_USER_ID' });
  }

  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('users').doc(userId).get();

    if (!snap.exists) {
      return res.status(200).json({
        success: true, userId, premium: false, isSubscribed: false, source: 'not_found',
      });
    }

    const user    = snap.data();
    const premium = user.isSubscribed === true || user.premium === true;

    return res.status(200).json({
      success        : true,
      userId,
      premium,
      isSubscribed   : premium,
      subscribedAt   : user.subscribedAt   || null,
      paymentMethod  : user.paymentMethod  || null,
      transactionId  : user.transactionId  || null,
      source         : 'firestore',
    });

  } catch (err) {
    logger.error('[LeekPay] Erreur statut premium', { userId, error: err.message });
    return res.status(200).json({
      success: true, userId, premium: false, isSubscribed: false, source: 'error',
    });
  }
}

/* ═══════════════════════════════════════════════════════════════
   ACTION 5 — Polling manuel (appelé depuis le frontend après retour)
   POST /api/payment/poll/:checkoutId
══════════════════════════════════════════════════════════════════ */
async function pollPayment(req, res) {
  const { checkoutId } = req.params;
  const { userId }     = req.body || {};

  if (!checkoutId) {
    return res.status(400).json({ success: false, error: 'checkoutId requis.' });
  }

  if (!leekpay.isConfigured()) {
    return res.status(503).json({ success: false, error: 'LeekPay non configuré.' });
  }

  try {
    const statusData = await leekpay.getCheckoutStatus(checkoutId);
    const isPaid     = statusData.isPaid || statusData.status === 'paid';

    if (isPaid && userId) {
      const alreadyDone = await isAlreadyProcessed(checkoutId);
      if (!alreadyDone) {
        await handleSuccessfulPayment({
          checkoutId,
          transactionId: statusData.checkoutId,
          userId,
          orderId      : null,
          amount       : statusData.amount,
          currency     : statusData.currency,
          paymentMethod: statusData.paymentMethod,
          paidAt       : statusData.paidAt,
          customer     : statusData.customer || {},
        });
      }
    }

    return res.status(200).json({
      success : true,
      status  : statusData.status,
      isPaid,
      premium : isPaid,
      checkoutId,
    });

  } catch (err) {
    logger.error('[LeekPay] Erreur poll payment', { checkoutId, error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
}

/* ── Exports ─────────────────────────────────────────────────── */
module.exports = {
  createPayment,
  handleWebhook,
  getPaymentStatus,
  getUserPremiumStatus,
  pollPayment,
  processWebhookPayload,  // pour tests
  processedCheckouts,
};
