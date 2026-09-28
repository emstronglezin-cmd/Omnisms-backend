'use strict';
/**
 * OmniSMS — LeekPay Controller (legacy — même moteur que saaspayController)
 * ═══════════════════════════════════════════════════════════════
 *
 * Alias legacy du moteur de paiement — voir controllers/saaspayController.js (même logique, service services/leekpay)
 *
 * Flux paiement :
 *   1. POST /api/payment/leekpay  { userId, amount?, currency?, phone?, email?, name? }
 *   2. Backend → POST https://saaspay.me/api/v1/checkout → { data: { id, payment_url } }
 *   3. Frontend ouvre data.payment_url
 *   4. SaaSPay → POST /api/payment/webhook/saaspay { event: "payment.completed", data: { status: "paid" } }
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
    logger.warn('[SaaSPay] Firestore savePayment error', { docId, error: err.message });
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

    logger.info('[PAYMENT_PREMIUM] Premium activé (legacy)', { userId, checkoutId, transactionId, amount: amount || leekpay.PREMIUM_AMOUNT, currency: currency || leekpay.PREMIUM_CURRENCY });
  } catch (err) {
    logger.error('[PAYMENT_ERROR] Erreur activation premium Firestore', { userId, checkoutId, error: err.message });
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
      logger.warn('[SaaSPay] Polling max attempts atteint', { checkoutId, userId });
      return;
    }

    try {
      const statusData = await leekpay.getCheckoutStatus(checkoutId);
      logger.info('[SaaSPay] Polling statut', { checkoutId, status: statusData.status, attempt: attempts });

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
            signatureValid: null,
            source       : 'polling',
          });
        }
        return;  // polling terminé
      }

      if (['failed', 'cancelled', 'expired'].includes(statusData.status)) {
        logger.info('[SaaSPay] Polling : paiement échoué/annulé', { checkoutId, status: statusData.status });
        await savePayment(checkoutId, { status: statusData.status, userId, pollEnded: true });
        return;
      }

      // Encore en cours → réessayer
      setTimeout(poll, intervalMs);

    } catch (err) {
      logger.error('[SaaSPay] Erreur polling', { checkoutId, attempt: attempts, error: err.message });
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
    logger.error('[PAYMENT_CONFIG] SaaSPay non configuré — SAASPAY_SECRET_KEY ou SAASPAY_API_KEY manquante');
    return res.status(503).json({
      success: false,
      error  : 'Service de paiement non disponible.',
      code   : 'SAASPAY_NOT_CONFIGURED',
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
  const webhookUrl   = `${backendUrl}/api/payment/webhook/saaspay`;

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
    logger.error('[PAYMENT_ERROR] Erreur création checkout', { userId: cleanUserId, orderId, error: err.message });
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

  logger.info('[PAYMENT] Checkout créé (legacy)', {
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
   POST /api/payment/webhook/saaspay
   Event : payment.completed
══════════════════════════════════════════════════════════════════ */
async function handleWebhook(req, res) {
  const body      = req.body || {};
  const rawBody   = req.rawBody || JSON.stringify(body);
  // En-têtes SaaSPay (nouveau) + LeekPay (legacy) — compatibles
  const signature = req.headers['x-saaspay-signature'] || req.headers['x-leekpay-signature'] || '';
  const event     = req.headers['x-saaspay-event']     || req.headers['x-leekpay-event']
                 || body.event || '';
  const delivery  = req.headers['x-saaspay-delivery']  || req.headers['x-leekpay-delivery']  || '';

  logger.info('[PAYMENT] Webhook reçu', {
    event,
    delivery,
    signaturePresent: !!signature,
    status    : body.data?.status || body.status,
    checkoutId: body.data?.checkout_id || body.data?.id,
  });

  // Répondre 200 immédiatement (évite le timeout du fournisseur)
  res.status(200).json({ received: true, timestamp: new Date().toISOString() });

  // Traitement asynchrone
  setImmediate(async () => {
    try {
      await processWebhookPayload(body, rawBody, signature, event);
    } catch (err) {
      logger.error('[PAYMENT_ERROR] Erreur traitement webhook', { error: err.message, event, delivery });
    }
  });
}

async function processWebhookPayload(body, rawBody, signature, event, options = {}) {
  // Vérification signature HMAC (fail-closed).
  // Une signature invalide n'interrompt PLUS le traitement : la décision
  // d'activer Premium est prise dans handleSuccessfulPayment(), qui exige
  // alors une confirmation du statut auprès de l'API SaaSPay.
  const signatureValid = typeof options.signatureValid === 'boolean'
    ? options.signatureValid
    : leekpay.verifyWebhookSignature(rawBody, signature);

  if (!signatureValid) {
    logger.warn('[PAYMENT_VERIFY] Webhook sans signature valide — confirmation fournisseur obligatoire', {
      hasSignature: !!signature,
      event,
    });
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

  logger.info('[PAYMENT] Webhook reçu', {
    event, status, checkoutId, transactionId, amount, currency,
    signatureValid,
    hasUserId: !!userId,
  });

  if (status === 'paid') {
    await handleSuccessfulPayment({
      checkoutId, transactionId, userId, orderId,
      amount, currency, paymentMethod, paidAt, customer,
      signatureValid,
      source: 'webhook',
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

/* ═══════════════════════════════════════════════════════════════
   HELPERS AUTHENTIFICATION PAIEMENT (côté SERVEUR)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Recherche l'enregistrement serveur d'un paiement (source de vérité).
 * 1) leekpay_payments/{checkoutId|orderId}
 * 2) query leekpay_payments.where('checkoutId','==',id)
 * @returns {Promise<object|null>}
 */
async function findStoredPayment(id) {
  if (!id) return null;
  const key = String(id);

  try {
    const db   = require('../config/firebase');
    const snap = await db.collection('leekpay_payments').doc(key).get();
    if (snap.exists) return { id: key, ...(snap.data() || {}) };
  } catch (err) {
    logger.warn('[PAYMENT] Lecture Firestore leekpay_payments/{id} impossible', { id: key, error: err.message });
  }

  try {
    const db        = require('../config/firebase');
    const querySnap = await db.collection('leekpay_payments')
      .where('checkoutId', '==', key)
      .limit(1)
      .get();
    if (!querySnap.empty) {
      const doc = querySnap.docs[0];
      return { id: doc.id, ...(doc.data() || {}) };
    }
  } catch (err) {
    logger.warn('[PAYMENT] Query Firestore leekpay_payments.checkoutId impossible', { id: key, error: err.message });
  }

  return null;
}

/**
 * Identifie l'utilisateur à créditer CÔTÉ SERVEUR.
 * L'enregistrement Firestore créé par createPayment() fait foi ;
 * le userId fourni par le client/webhook n'est qu'un indice.
 */
async function resolvePaymentUser({ checkoutId, orderId, claimedUserId, providerMetadataUserId, storedPayment = undefined }) {
  const stored = storedPayment !== undefined
    ? storedPayment
    : ((await findStoredPayment(checkoutId)) || (await findStoredPayment(orderId)) || null);
  const storedUserId = stored?.userId || null;

  if (storedUserId && claimedUserId && claimedUserId !== storedUserId) {
    logger.error('[PAYMENT_ERROR] userId du webhook différent de l\'enregistrement serveur — l\'enregistrement serveur fait foi', {
      checkoutId, orderId, claimedUserId, storedUserId,
    });
  }

  if (storedUserId && providerMetadataUserId && providerMetadataUserId !== storedUserId) {
    logger.error('[PAYMENT_ERROR] userId métadonnées fournisseur différent de l\'enregistrement serveur — l\'enregistrement serveur fait foi', {
      checkoutId, orderId, providerMetadataUserId, storedUserId,
    });
  }

  const userId = storedUserId || providerMetadataUserId || claimedUserId || null;

  return {
    userId,
    source          : storedUserId ? 'firestore' : (providerMetadataUserId ? 'provider_metadata' : 'payload'),
    expectedAmount  : stored?.amount   || null,
    expectedCurrency: stored?.currency || null,
    stored,
  };
}

/**
 * Vérification autoritative du paiement.
 *  - signature HMAC valide  → payload authentique (accepté)
 *  - sinon                  → confirmation du statut + du montant auprès de l'API SaaSPay
 * @returns {Promise<{verified:boolean, via:string, reason:string|null, amount:number, currency:string,
 *                    metadataUserId:string|null, paymentMethod:string|null}>}
 */
async function verifyPaymentWithProvider({ checkoutId, expectedAmount, expectedCurrency, signatureValid }) {
  if (!checkoutId) {
    return { verified: false, via: 'none', reason: 'NO_CHECKOUT_ID', amount: 0, currency: null, metadataUserId: null };
  }

  if (signatureValid === true) {
    logger.info('[PAYMENT_VERIFY] Signature webhook valide — payload authentifié', { checkoutId });
    return { verified: true, via: 'signature', reason: null, amount: Number(expectedAmount) || 0, currency: expectedCurrency || null, metadataUserId: null };
  }

  const configured = typeof leekpay.isConfigured === 'function' ? leekpay.isConfigured() : false;
  if (!configured) {
    logger.error('[PAYMENT_ERROR] Fournisseur non configuré — vérification serveur impossible', { checkoutId });
    return { verified: false, via: 'none', reason: 'PROVIDER_NOT_CONFIGURED', amount: 0, currency: null, metadataUserId: null };
  }

  try {
    const statusData = await leekpay.getCheckoutStatus(checkoutId);
    const isPaid     = statusData.isPaid === true || String(statusData.status || '').toLowerCase() === 'paid';
    const amount     = Number(statusData.amount) || 0;
    const currency   = statusData.currency ? String(statusData.currency).toUpperCase() : null;
    const expected   = Number(expectedAmount) || 0;

    const amountOk   = !expected || !amount || amount >= expected;   // tolérance : frais éventuels
    const currencyOk = !expectedCurrency || !currency || currency === String(expectedCurrency).toUpperCase();
    const verified   = isPaid && amountOk && currencyOk;

    const reason = verified ? null
                 : (!isPaid ? 'PROVIDER_NOT_PAID'
                 : (!amountOk ? 'PROVIDER_AMOUNT_MISMATCH' : 'PROVIDER_CURRENCY_MISMATCH'));

    logger.info('[PAYMENT_VERIFY] Confirmation fournisseur', {
      checkoutId,
      status  : statusData.status,
      isPaid,
      amount,
      currency,
      expectedAmount : expected,
      expectedCurrency,
      amountOk,
      currencyOk,
      verified,
      reason,
    });

    return {
      verified,
      via            : 'provider',
      reason,
      amount,
      currency,
      metadataUserId : statusData.metadata?.userId || null,
      paymentMethod  : statusData.paymentMethod || null,
    };

  } catch (err) {
    logger.error('[PAYMENT_ERROR] Vérification fournisseur impossible', { checkoutId, error: err.message });
    return { verified: false, via: 'provider', reason: 'PROVIDER_ERROR', amount: 0, currency: null, metadataUserId: null };
  }
}

/* ═══════════════════════════════════════════════════════════════
   ACTION 2bis — Traitement d'un paiement confirmé
   ═══════════════════════════════════════════════════════════════
   Le backend reste SEUL juge :
     1. enregistrement du paiement (traçabilité)
     2. identification serveur de l'utilisateur
     3. vérification signature HMAC OU confirmation fournisseur
     4. contrôle du montant / de la devise
     5. activation Premium (une seule fois — idempotence)
══════════════════════════════════════════════════════════════════ */
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
  signatureValid = null,
  source         = 'webhook',
}) {
  logger.info('[PAYMENT] Paiement confirmé (paid) — traitement', {
    checkoutId, transactionId, userId, orderId, amount, currency, source,
    signatureValid,
  });

  /* ── Anti-concurrent ─────────────────────────────────────── */
  if (checkoutId && processingPayments.has(checkoutId)) {
    logger.info('[PAYMENT] Traitement concurrent en cours — ignoré', { checkoutId });
    return { activated: false, reason: 'CONCURRENT' };
  }

  /* ── Anti-replay / idempotence ───────────────────────────── */
  if (checkoutId && await isAlreadyProcessed(checkoutId)) {
    logger.info('[PAYMENT] Paiement déjà traité (idempotence) — Premium non réactivé', { checkoutId });
    return { activated: false, reason: 'ALREADY_PROCESSED' };
  }

  if (checkoutId) processingPayments.add(checkoutId);

  try {
    /* 1. Enregistrement serveur déjà existant (créé par createPayment) */
    const storedPayment = (await findStoredPayment(checkoutId)) || (await findStoredPayment(orderId)) || null;

    /* Traçabilité — le paiement est enregistré même si l'activation est refusée.
       ⚠️ `userId` n'est écrit que s'il est absent : le userId du client ne doit
       JAMAIS écraser l'enregistrement serveur créé par createPayment(). */
    if (checkoutId) {
      await savePayment(checkoutId, {
        status          : 'paid',
        transactionId,
        userId          : storedPayment?.userId || userId,
        claimedUserId   : userId,
        orderId,
        amount,
        currency,
        paymentMethod,
        paidAt          : paidAt || new Date().toISOString(),
        customer,
        webhookReceived : new Date().toISOString(),
        premiumActivated: false,
        activationSource: source,
      });
    }

    /* 2. Vérification autoritative (signature OU fournisseur) */
    const preVerification = await verifyPaymentWithProvider({
      checkoutId,
      expectedAmount  : null,
      expectedCurrency: null,
      signatureValid,
    });

    /* 3. Identification serveur de l'utilisateur
          (ordre : enregistrement serveur > métadonnées fournisseur > valeur annoncée) */
    const identity = await resolvePaymentUser({
      checkoutId,
      orderId,
      claimedUserId          : userId,
      providerMetadataUserId : preVerification.metadataUserId,
      storedPayment,
    });

    if (!identity.userId) {
      logger.error('[PAYMENT_ERROR] userId introuvable — activation Premium impossible', {
        checkoutId,
        orderId,
        source,
        hint: 'Vérifier leekpay_payments/{checkoutId}.userId (écrit par createPayment) et metadata.userId renvoyé par le fournisseur.',
      });
      if (checkoutId) {
        await savePayment(checkoutId, { premiumActivated: false, activationError: 'USER_ID_NOT_FOUND' });
      }
      return { activated: false, reason: 'USER_ID_NOT_FOUND' };
    }

    /* Un paiement déclenché par le client (poll) sans enregistrement serveur
       ni métadonnées fournisseur ne peut pas être attribué de façon fiable. */
    if (identity.source === 'payload' && source === 'poll') {
      logger.error('[PAYMENT_ERROR] Paiement non attribuable (aucun enregistrement serveur) — activation refusée', {
        checkoutId, claimedUserId: userId, source,
      });
      if (checkoutId) {
        await savePayment(checkoutId, { premiumActivated: false, activationError: 'UNATTRIBUTABLE_PAYMENT' });
      }
      return { activated: false, reason: 'UNATTRIBUTABLE_PAYMENT' };
    }

    /* 4. Vérification autoritative avec le montant attendu côté serveur */
    const expectedAmount   = Number(identity.expectedAmount)   || leekpay.PREMIUM_AMOUNT;
    const expectedCurrency = String(identity.expectedCurrency || leekpay.PREMIUM_CURRENCY).toUpperCase();

    const verification = signatureValid === true
      ? { ...preVerification, verified: true }
      : await verifyPaymentWithProvider({
          checkoutId,
          expectedAmount,
          expectedCurrency,
          signatureValid: false,
        });

    /* 5. Contrôle du montant / devise annoncés (le backend reste seul juge) */
    const claimedAmount   = Number(amount) || 0;
    const claimedCurrency = String(currency || expectedCurrency).toUpperCase();

    if (claimedAmount && claimedAmount < expectedAmount) {
      logger.error('[PAYMENT_ERROR] Montant annoncé inférieur au montant attendu — activation refusée', {
        checkoutId, claimedAmount, expectedAmount,
      });
      if (checkoutId) {
        await savePayment(checkoutId, { premiumActivated: false, activationError: 'AMOUNT_TOO_LOW' });
      }
      return { activated: false, reason: 'AMOUNT_TOO_LOW' };
    }

    if (claimedCurrency && expectedCurrency && claimedCurrency !== expectedCurrency) {
      logger.error('[PAYMENT_ERROR] Devise annoncée différente de la devise attendue — activation refusée', {
        checkoutId, claimedCurrency, expectedCurrency,
      });
      if (checkoutId) {
        await savePayment(checkoutId, { premiumActivated: false, activationError: 'CURRENCY_MISMATCH' });
      }
      return { activated: false, reason: 'CURRENCY_MISMATCH' };
    }

    /* 6. Confirmation finale : signature valide OU statut confirmé par le fournisseur */
    if (verification.verified !== true) {
      logger.error('[PAYMENT_ERROR] Paiement NON vérifié — activation Premium refusée', {
        checkoutId,
        orderId,
        reason       : verification.reason,
        signatureValid,
        claimedUserId: userId,
        resolvedUserId: identity.userId,
        resolutionSource: identity.source,
        hint: 'Aucune signature webhook valide et statut non confirmable auprès de SaaSPay. Vérifier SAASPAY_SECRET_KEY / SAASPAY_API_KEY.',
      });
      if (checkoutId) {
        await savePayment(checkoutId, {
          premiumActivated    : false,
          activationError     : verification.reason || 'NOT_VERIFIED',
          pendingVerification : true,
        });
      }
      return { activated: false, reason: verification.reason || 'NOT_VERIFIED' };
    }

    /* 7. Activation Premium — identifiant résolu côté serveur uniquement */
    await activatePremiumFirestore(identity.userId, {
      checkoutId,
      transactionId,
      amount         : claimedAmount || expectedAmount,
      currency       : expectedCurrency,
      paymentMethod  : paymentMethod || verification.paymentMethod || 'saaspay',
      paidAt,
    });

    if (checkoutId) {
      processedCheckouts.add(checkoutId);
      await savePayment(checkoutId, {
        premiumActivated: true,
        activatedAt     : new Date().toISOString(),
        activatedUserId : identity.userId,
        verifiedVia     : verification.via,
      });
    }

    /* 8. Notification temps réel */
    try {
      const { emitToUser } = require('../services/socketService');
      emitToUser(identity.userId, 'payment:success', {
        checkoutId, transactionId, amount: claimedAmount || expectedAmount, currency: expectedCurrency,
        premium: true, activatedAt: new Date().toISOString(),
      });
    } catch (_) {}

    logger.info('[PAYMENT_PREMIUM] Activation terminée', {
      userId: identity.userId,
      checkoutId,
      verifiedVia      : verification.via,
      resolutionSource : identity.source,
    });

    return { activated: true, userId: identity.userId, verifiedVia: verification.via };

  } catch (err) {
    logger.error('[PAYMENT_ERROR] Erreur traitement paiement', {
      checkoutId, orderId, error: err.message,
    });
    return { activated: false, reason: 'INTERNAL_ERROR' };

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
    logger.warn('[SaaSPay] Firestore indisponible pour statut', { error: err.message, transactionId: cleanId });
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
    logger.error('[SaaSPay] Erreur statut premium', { userId, error: err.message });
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
    return res.status(503).json({ success: false, error: 'SaaSPay non configuré.' });
  }

  try {
    const statusData = await leekpay.getCheckoutStatus(checkoutId);
    const isPaid     = statusData.isPaid || statusData.status === 'paid';

    let activation = null;

    if (isPaid) {
      // ⚠️ Le userId envoyé par le client n'est qu'un INDICE :
      // l'utilisateur à créditer est résolu côté serveur
      // (enregistrement leekpay_payments créé par createPayment()).
      activation = await handleSuccessfulPayment({
        checkoutId,
        transactionId: statusData.checkoutId,
        userId,
        orderId      : null,
        amount       : statusData.amount,
        currency     : statusData.currency,
        paymentMethod: statusData.paymentMethod,
        paidAt       : statusData.paidAt,
        customer     : statusData.customer || {},
        signatureValid: null,
        source       : 'poll',
      });
    }

    /* Statut Premium RÉEL de l'utilisateur qui interroge (source : Firestore).
       `premium` conserve son sens historique (« le paiement est payé ») tandis
       que `callerPremium` reflète l'état réel du compte. */
    let callerPremium = false;
    if (userId) {
      try {
        const db   = require('../config/firebase');
        const snap = await db.collection('users').doc(userId).get();
        if (snap.exists) {
          const data = snap.data() || {};
          callerPremium = data.isSubscribed === true || data.premium === true;
        }
      } catch (err) {
        logger.warn('[PAYMENT] Lecture statut Premium appelant impossible', { userId, error: err.message });
      }
    }

    return res.status(200).json({
      success        : true,
      status         : statusData.status,
      isPaid,
      premium        : isPaid,
      callerPremium,
      checkoutId,
      activatedUserId: activation?.userId || null,
      activationState: activation?.activated === true ? 'activated'
                     : (activation?.reason || null),
    });

  } catch (err) {
    logger.error('[SaaSPay] Erreur poll payment', { checkoutId, error: err.message });
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
