'use strict';
/**
 * OmniSMS — Routes GeniusPay
 *
 * Système de paiement principal via GeniusPay (mode Checkout).
 * Compatible et parallèle aux anciens systèmes (Fusion Link, Fusion Pay).
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  POST /api/payment/geniuspay/create                        │
 * │  POST /api/payment/geniuspay/webhook                       │
 * │  GET  /api/payment/geniuspay/status/:paymentId             │
 * │  GET  /api/payment/geniuspay/user-status                   │
 * │  GET  /api/payment/link                                     │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Variables d'environnement requises :
 *   GENIUSPAY_API_KEY        → Clé publique GeniusPay
 *   GENIUSPAY_API_SECRET     → Clé secrète GeniusPay
 *   GENIUSPAY_WEBHOOK_SECRET → Secret HMAC webhook (optionnel mais recommandé)
 *   BACKEND_URL              → URL publique du backend (pour les callbacks)
 */

const express  = require('express');
const router   = express.Router();
const { body, query, param, validationResult } = require('express-validator');

const db = require('../config/firebase');
const { logger } = require('../middleware/logger');
const geniuspay  = require('../services/geniuspay');

// ── Constantes ────────────────────────────────────────────────
const BACKEND_URL          = process.env.BACKEND_URL || 'https://omnisms-backend.onrender.com';
const PREMIUM_AMOUNT       = geniuspay.PREMIUM_AMOUNT;    // 2000
const PREMIUM_CURRENCY     = geniuspay.PREMIUM_CURRENCY;  // XOF
const SUBSCRIPTION_LINK    = process.env.GENIUSPAY_PAYMENT_LINK
  || `${BACKEND_URL}/api/payment/link`;

// ── Helper : générer un orderId unique ────────────────────────
function generateOrderId() {
  return `OMNI-GP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

// ── Helper : validation express-validator ─────────────────────
function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error  : 'Données invalides.',
      code   : 'VALIDATION_ERROR',
      fields : errors.array().map(e => ({ field: e.path, msg: e.msg })),
    });
  }
  return null;
}

// ── Firestore helpers ─────────────────────────────────────────

/**
 * Sauvegarder ou mettre à jour un paiement dans Firestore.
 * Collection : geniuspay_payments / document : orderId
 */
async function savePayment(orderId, data) {
  await db
    .collection('geniuspay_payments')
    .doc(orderId)
    .set(
      { ...data, updatedAt: new Date().toISOString() },
      { merge: true }
    );
}

/**
 * Vérifier si un utilisateur est déjà premium (Firestore).
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isAlreadyPremium(userId) {
  const snap = await db.collection('users').doc(userId).get();
  return snap.exists && snap.data()?.isSubscribed === true;
}

/**
 * Activer le statut Premium d'un utilisateur dans Firestore.
 * - Met à jour users/{userId}
 * - Crée un enregistrement dans subscriptions/
 * Protection anti-double-activation incluse.
 *
 * @param {string} userId
 * @param {string} orderId
 * @param {object} paymentData - Données brutes du paiement
 * @returns {Promise<boolean>} true si activé, false si déjà premium
 */
async function activatePremium(userId, orderId, paymentData = {}) {
  // Vérification idempotence dans Firestore
  const paySnap = await db.collection('geniuspay_payments').doc(orderId).get();
  if (paySnap.exists && paySnap.data()?.premiumActivated === true) {
    logger.info('[GeniusPay] Premium déjà activé pour ce paiement (idempotence)', { orderId, userId });
    return false;
  }

  const alreadyPremium = await isAlreadyPremium(userId);
  if (alreadyPremium) {
    logger.info('[GeniusPay] Utilisateur déjà premium', { userId });
    return false;
  }

  const now = new Date().toISOString();

  // Mettre à jour le document utilisateur
  await db.collection('users').doc(userId).set(
    {
      isSubscribed : true,
      subscribedAt : now,
      paymentMethod: 'geniuspay',
      orderId,
      amount       : paymentData.amount || PREMIUM_AMOUNT,
      updatedAt    : now,
    },
    { merge: true }
  );

  // Historique des abonnements
  await db.collection('subscriptions').add({
    userId,
    isSubscribed : true,
    subscribedAt : now,
    paymentMethod: 'geniuspay',
    orderId,
    amount       : paymentData.amount || PREMIUM_AMOUNT,
    currency     : PREMIUM_CURRENCY,
    paymentId    : paymentData.paymentId || orderId,
    app          : 'OmniSMS',
    createdAt    : now,
  });

  // Marquer le paiement comme ayant déclenché l'activation
  await db.collection('geniuspay_payments').doc(orderId).set(
    { premiumActivated: true, activatedAt: now },
    { merge: true }
  );

  logger.info('[GeniusPay] Premium activé', { userId, orderId });
  return true;
}

// ════════════════════════════════════════════════════════════════
// ROUTE 1 : POST /api/payment/geniuspay/create
// ════════════════════════════════════════════════════════════════
/**
 * Créer un paiement GeniusPay et retourner l'URL Checkout.
 *
 * Body JSON :
 *   { userId, phone, amount: 2000, currency: "XOF" }
 *
 * Réponse :
 *   { success: true, checkoutUrl, paymentId, orderId }
 */
router.post(
  '/create',
  [
    body('userId')
      .trim()
      .notEmpty()
      .withMessage('userId est requis.')
      .isLength({ min: 3, max: 128 })
      .withMessage('userId invalide.'),
    body('phone')
      .optional()
      .trim()
      .matches(/^\+?[0-9\s\-().]{7,20}$/)
      .withMessage('Numéro de téléphone invalide.'),
    body('amount')
      .optional()
      .toFloat()
      .custom(v => v === 2000)
      .withMessage('Le montant doit être 2000 XOF.'),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    const { userId, phone, amount, currency } = req.body;

    // Vérifier que GeniusPay est configuré
    if (!process.env.GENIUSPAY_API_KEY || !process.env.GENIUSPAY_API_SECRET) {
      return res.status(503).json({
        success: false,
        error  : 'Système de paiement GeniusPay non configuré. Contactez l\'administrateur.',
        code   : 'GENIUSPAY_NOT_CONFIGURED',
      });
    }

    const cleanUserId = userId.trim();

    // Anti-double-activation : vérifier si déjà premium
    try {
      if (await isAlreadyPremium(cleanUserId)) {
        return res.status(400).json({
          success          : false,
          error            : 'Cet utilisateur est déjà abonné OmniSMS Premium.',
          code             : 'ALREADY_SUBSCRIBED',
          alreadySubscribed: true,
        });
      }
    } catch (err) {
      logger.error('[GeniusPay] Erreur vérification premium', { error: err.message, userId: cleanUserId });
      return res.status(500).json({ success: false, error: 'Erreur base de données.', code: 'DB_ERROR' });
    }

    const orderId    = generateOrderId();
    const returnUrl  = `${BACKEND_URL}/api/payment/geniuspay/return?orderId=${encodeURIComponent(orderId)}&userId=${encodeURIComponent(cleanUserId)}`;
    const webhookUrl = `${BACKEND_URL}/api/payment/geniuspay/webhook`;

    // Sauvegarder le paiement en état "pending" avant appel API
    await savePayment(orderId, {
      userId   : cleanUserId,
      phone    : phone || null,
      status   : 'pending',
      amount   : PREMIUM_AMOUNT,
      currency : PREMIUM_CURRENCY,
      orderId,
      createdAt: new Date().toISOString(),
      ip       : req.ip || '0.0.0.0',
    });

    // Appeler l'API GeniusPay
    let result;
    try {
      result = await geniuspay.createPayment({
        userId   : cleanUserId,
        phone,
        orderId,
        returnUrl,
        webhookUrl,
      });
    } catch (err) {
      // Mettre le paiement en erreur dans Firestore
      await savePayment(orderId, { status: 'error', errorMessage: err.message });

      logger.error('[GeniusPay] Erreur création paiement', { error: err.message, userId: cleanUserId });

      return res.status(502).json({
        success: false,
        error  : 'Impossible de contacter GeniusPay. Réessayez.',
        code   : 'GENIUSPAY_API_ERROR',
        detail : process.env.NODE_ENV !== 'production' ? err.message : undefined,
      });
    }

    // Mettre à jour Firestore avec le paymentId retourné par GeniusPay
    await savePayment(orderId, {
      paymentId   : result.paymentId,
      checkoutUrl : result.checkoutUrl,
      status      : 'pending',
    });

    logger.info('[GeniusPay] Paiement initié avec succès', {
      userId: cleanUserId,
      orderId,
      paymentId: result.paymentId,
    });

    return res.status(200).json({
      success    : true,
      checkoutUrl: result.checkoutUrl,
      paymentId  : result.paymentId,
      orderId,
      amount     : PREMIUM_AMOUNT,
      currency   : PREMIUM_CURRENCY,
      message    : 'Paiement initié. Redirigez l\'utilisateur vers checkoutUrl.',
    });
  }
);

// ════════════════════════════════════════════════════════════════
// ROUTE 2 : POST /api/payment/geniuspay/webhook
// ════════════════════════════════════════════════════════════════
/**
 * Webhook GeniusPay — appelé par GeniusPay après confirmation de paiement.
 *
 * Sécurité :
 *   - Vérification signature HMAC (si GENIUSPAY_WEBHOOK_SECRET défini)
 *   - Vérification montant = 2000 XOF
 *   - Idempotence : un même orderId traité une seule fois
 *
 * Répond HTTP 200 immédiatement, traitement en setImmediate.
 */
router.post('/webhook', (req, res) => {
  // Réponse immédiate pour éviter les timeouts GeniusPay
  res.status(200).json({ received: true, ts: new Date().toISOString() });

  // Traitement asynchrone hors du cycle requête
  setImmediate(() => processGeniusPayWebhook(req).catch(err => {
    logger.error('[GeniusPay Webhook] Erreur non gérée', { error: err.message });
  }));
});

/**
 * Traiter le webhook GeniusPay de manière asynchrone.
 * Le corps brut est accédé via req.rawBody (voir server.js).
 */
async function processGeniusPayWebhook(req) {
  const body      = req.body      || {};
  const rawBody   = req.rawBody   || JSON.stringify(body);
  const signature = req.headers['x-genius-signature'] || '';

  logger.info('[GeniusPay Webhook] Événement reçu', {
    status   : body.status,
    reference: body.reference || body.id,
    amount   : body.amount,
  });

  // ── Vérification signature HMAC ──────────────────────────────
  if (!geniuspay.verifyWebhookSignature(rawBody, signature)) {
    logger.error('[GeniusPay Webhook] Signature invalide — événement ignoré');
    return;
  }

  // ── Extraire les champs clés ──────────────────────────────────
  const status    = (body.status || '').toLowerCase();
  const amount    = Number(body.amount)   || 0;
  const paymentId = body.id               || body.payment_id  || body.reference || null;
  const metadata  = body.metadata        || body.meta         || {};
  const userId    = metadata.userId       || body.userId       || body.customer?.userId || null;
  const orderId   = metadata.orderId      || body.orderId      || paymentId;

  // ── Sécurité : vérifier le montant ──────────────────────────
  if (amount && amount !== PREMIUM_AMOUNT) {
    logger.warn('[GeniusPay Webhook] Montant inattendu', {
      expected: PREMIUM_AMOUNT,
      received : amount,
      paymentId,
    });
    // On continue — le statut sera 'suspicious' dans Firestore
    await savePayment(orderId || paymentId || 'unknown', {
      status   : 'suspicious',
      amount,
      paymentId,
      userId,
      webhookBody: body,
      flaggedAt  : new Date().toISOString(),
    });
    return;
  }

  if (!orderId) {
    logger.warn('[GeniusPay Webhook] orderId absent — impossible de traiter');
    return;
  }

  // ── Traitement selon statut ──────────────────────────────────
  const isPaid    = ['paid', 'success', 'completed', 'successful'].includes(status);
  const isFailed  = ['failed', 'cancelled', 'expired', 'refunded'].includes(status);
  const isPending = ['pending', 'processing', 'initiated'].includes(status);

  if (isPaid) {
    logger.info('[GeniusPay Webhook] Paiement CONFIRMÉ', { orderId, userId, amount, status });

    // Mettre Firestore à jour
    await savePayment(orderId, {
      status   : 'paid',
      paymentId,
      userId,
      amount,
      paidAt   : new Date().toISOString(),
      webhookStatus: status,
    });

    // Activer premium si userId disponible
    if (userId) {
      const activated = await activatePremium(userId, orderId, { amount, paymentId });
      if (!activated) {
        logger.info('[GeniusPay Webhook] Premium non activé (déjà actif ou doublon)', { userId, orderId });
      }
    } else {
      logger.warn('[GeniusPay Webhook] Paiement confirmé mais userId absent', { orderId, paymentId });
    }

  } else if (isFailed) {
    logger.info('[GeniusPay Webhook] Paiement ÉCHOUÉ/ANNULÉ', { orderId, status });

    await savePayment(orderId, {
      status      : 'failed',
      paymentId,
      userId,
      failedAt    : new Date().toISOString(),
      webhookStatus: status,
    });

  } else if (isPending) {
    logger.info('[GeniusPay Webhook] Paiement EN ATTENTE', { orderId, status });

    await savePayment(orderId, {
      status      : 'processing',
      paymentId,
      userId,
      webhookStatus: status,
    });

  } else {
    logger.info('[GeniusPay Webhook] Statut non géré', { status, orderId });
  }
}

// ════════════════════════════════════════════════════════════════
// ROUTE 3 : GET /api/payment/geniuspay/status/:paymentId
// ════════════════════════════════════════════════════════════════
/**
 * Vérifier le statut d'un paiement GeniusPay.
 * Interroge d'abord Firestore, puis l'API GeniusPay si nécessaire.
 *
 * Params : paymentId (ID ou orderId du paiement)
 */
router.get(
  '/status/:paymentId',
  [
    param('paymentId')
      .trim()
      .isLength({ min: 3, max: 128 })
      .withMessage('paymentId invalide.'),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    const { paymentId } = req.params;

    // 1. Vérifier Firestore (source locale)
    let localData = null;
    try {
      const snap = await db.collection('geniuspay_payments').doc(paymentId).get();
      if (snap.exists) localData = snap.data();
    } catch (err) {
      logger.warn('[GeniusPay Status] Erreur lecture Firestore', { error: err.message });
    }

    // 2. Appeler l'API GeniusPay si pas encore finalisé
    let apiData = null;
    if (!localData || !['paid', 'failed'].includes(localData.status)) {
      try {
        apiData = await geniuspay.getPaymentStatus(paymentId);
      } catch (err) {
        logger.warn('[GeniusPay Status] API inaccessible', { error: err.message });
      }
    }

    // 3. Si l'API confirme paid mais Firestore pas encore mis à jour
    if (apiData?.isPaid && localData?.status !== 'paid') {
      const uid = localData?.userId || apiData?.userId;
      if (uid) {
        try {
          await savePayment(paymentId, {
            status  : 'paid',
            paidAt  : new Date().toISOString(),
            source  : 'polling',
          });
          await activatePremium(uid, paymentId, { amount: apiData?.amount || PREMIUM_AMOUNT, paymentId });
        } catch (err) {
          logger.error('[GeniusPay Status] Erreur activation via polling', { error: err.message });
        }
      }
    }

    const finalStatus = apiData?.status || localData?.status || 'unknown';
    const isPaid      = finalStatus === 'paid' || apiData?.isPaid === true;

    return res.status(200).json({
      success  : true,
      paymentId,
      status   : finalStatus,
      isPaid,
      amount   : apiData?.amount  || localData?.amount   || PREMIUM_AMOUNT,
      currency : PREMIUM_CURRENCY,
      userId   : apiData?.userId  || localData?.userId   || null,
      createdAt: localData?.createdAt || null,
    });
  }
);

// ════════════════════════════════════════════════════════════════
// ROUTE 4 : GET /api/user/status
// ════════════════════════════════════════════════════════════════
/**
 * Retourner le statut premium d'un utilisateur.
 *
 * Query : ?userId=XXX  OU bearer token JWT (req.user.uid)
 *
 * Réponse : { premium: true/false, isSubscribed: bool, ... }
 */
router.get(
  '/user-status',
  [
    query('userId')
      .optional()
      .trim()
      .isLength({ min: 3, max: 128 })
      .withMessage('userId invalide.'),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    // Accepter userId via query param ou via JWT (req.user)
    const cq0 = req.cleanedQuery || {};
    const userId = (cq0.userId || (req.query && req.query.userId) || req.user?.uid || '').trim();

    if (!userId) {
      return res.status(400).json({
        success: false,
        error  : 'userId requis (query ?userId=XXX ou header Authorization Bearer).',
        code   : 'MISSING_USER_ID',
      });
    }

    try {
      const snap = await db.collection('users').doc(userId).get();

      if (!snap.exists) {
        return res.status(200).json({
          success     : true,
          userId,
          premium     : false,
          isSubscribed: false,
          message     : 'Utilisateur non trouvé.',
        });
      }

      const user = snap.data();
      const premium = user.isSubscribed === true;

      return res.status(200).json({
        success     : true,
        userId,
        premium,
        isSubscribed: premium,
        subscribedAt: user.subscribedAt  || null,
        paymentMethod: user.paymentMethod || null,
      });
    } catch (err) {
      logger.error('[GeniusPay] Erreur GET /user-status', { error: err.message, userId });
      return res.status(500).json({ success: false, error: 'Erreur serveur.', code: 'DB_ERROR' });
    }
  }
);

// ════════════════════════════════════════════════════════════════
// ROUTE 5 : GET /api/payment/link
// ════════════════════════════════════════════════════════════════
/**
 * Générer un lien de paiement direct utilisable dans Notion ou un bouton.
 *
 * Usage : GET /api/payment/link?userId=XXX
 *
 * Comportement :
 *   - Si GeniusPay configuré → crée le paiement et retourne checkoutUrl
 *   - Sinon → retourne le Fusion Link de secours
 *
 * Ce lien peut être collé directement dans une page Notion.
 */
router.get(
  '/link',
  [
    query('userId')
      .trim()
      .notEmpty()
      .withMessage('userId est requis.')
      .isLength({ min: 3, max: 128 })
      .withMessage('userId invalide.'),
    query('phone')
      .optional()
      .trim()
      .matches(/^\+?[0-9\s\-().]{7,20}$/)
      .withMessage('Numéro de téléphone invalide.'),
  ],
  async (req, res) => {
    const validationError = handleValidation(req, res);
    if (validationError) return;

    const cq1 = req.cleanedQuery || {};
    const userId = ((cq1.userId || (req.query && req.query.userId) || '')).trim();
    const phone  = cq1.phone || (req.query && req.query.phone) || null;

    // Si GeniusPay non configuré → fallback sur Fusion Link
    if (!process.env.GENIUSPAY_API_KEY || !process.env.GENIUSPAY_API_SECRET) {
      const fallbackUrl = process.env.GENIUSPAY_PAYMENT_LINK || SUBSCRIPTION_LINK;
      logger.info('[GeniusPay Link] GeniusPay non configuré — fallback Fusion Link', { userId });

      return res.status(200).json({
        success    : true,
        userId,
        paymentUrl : fallbackUrl,
        provider   : 'fusion_link_fallback',
        message    : 'GeniusPay non configuré. Lien Fusion Link retourné.',
      });
    }

    // Vérifier si déjà premium
    try {
      if (await isAlreadyPremium(userId)) {
        return res.status(200).json({
          success         : true,
          userId,
          alreadySubscribed: true,
          premium         : true,
          message         : 'Utilisateur déjà Premium OmniSMS.',
        });
      }
    } catch (err) {
      logger.warn('[GeniusPay Link] Erreur vérification premium', { error: err.message });
    }

    // Créer le paiement GeniusPay
    const orderId    = generateOrderId();
    const returnUrl  = `${BACKEND_URL}/api/payment/geniuspay/return?orderId=${encodeURIComponent(orderId)}&userId=${encodeURIComponent(userId)}`;
    const webhookUrl = `${BACKEND_URL}/api/payment/geniuspay/webhook`;

    await savePayment(orderId, {
      userId,
      phone    : phone || null,
      status   : 'pending',
      amount   : PREMIUM_AMOUNT,
      currency : PREMIUM_CURRENCY,
      orderId,
      createdAt: new Date().toISOString(),
      source   : 'notion_link',
    });

    let result;
    try {
      result = await geniuspay.createPayment({ userId, phone, orderId, returnUrl, webhookUrl });
    } catch (err) {
      await savePayment(orderId, { status: 'error', errorMessage: err.message });
      logger.error('[GeniusPay Link] Erreur création paiement', { error: err.message, userId });

      return res.status(502).json({
        success: false,
        error  : 'Impossible de générer le lien de paiement. Réessayez.',
        code   : 'GENIUSPAY_API_ERROR',
      });
    }

    await savePayment(orderId, {
      paymentId  : result.paymentId,
      checkoutUrl: result.checkoutUrl,
    });

    logger.info('[GeniusPay Link] Lien généré', { userId, orderId });

    return res.status(200).json({
      success    : true,
      userId,
      paymentUrl : result.checkoutUrl,
      paymentId  : result.paymentId,
      orderId,
      provider   : 'geniuspay',
      amount     : PREMIUM_AMOUNT,
      currency   : PREMIUM_CURRENCY,
      message    : 'Lien de paiement GeniusPay généré. Collez paymentUrl dans Notion.',
    });
  }
);

// ════════════════════════════════════════════════════════════════
// ROUTE 6 : GET /api/payment/geniuspay/return
// ════════════════════════════════════════════════════════════════
/**
 * Page de retour après paiement (WebView / navigateur).
 * GeniusPay redirige ici après que l'utilisateur a payé.
 * Affiche une page HTML simple de confirmation.
 */
router.get('/return', (req, res) => {
  const cq2 = req.cleanedQuery || {};
  const safeOrderId = ((cq2.orderId || (req.query && req.query.orderId) || '')).replace(/[<>"'&]/g, '');
  const safeUserId  = ((cq2.userId  || (req.query && req.query.userId)  || '')).replace(/[<>"'&]/g, '');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>OmniSMS — Paiement</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#0d1117;color:#f0f6fc;min-height:100vh;
         display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:16px;
          padding:40px 28px;max-width:360px;width:100%;text-align:center}
    .icon{font-size:64px;margin-bottom:16px;display:block;
          animation:pop .5s cubic-bezier(.36,.07,.19,.97) both}
    @keyframes pop{0%{transform:scale(.4);opacity:0}70%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}
    h1{font-size:22px;font-weight:700;color:#58a6ff;margin-bottom:12px}
    p{font-size:14px;color:#8b949e;line-height:1.7;margin-bottom:20px}
    .badge{display:inline-block;background:linear-gradient(135deg,#1f6feb,#388bfd);
           color:#fff;padding:10px 24px;border-radius:24px;font-size:13px;font-weight:600}
    .note{margin-top:18px;font-size:12px;color:#484f58}
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">✅</span>
    <h1>Paiement confirmé !</h1>
    <p>Votre paiement GeniusPay est en cours de vérification.<br>
       L'activation Premium OmniSMS sera automatique.</p>
    <span class="badge">⭐ Activation en cours…</span>
    <p class="note">Vous pouvez fermer cette page et revenir dans l'application.</p>
  </div>
  <script>
    (function(){
      var uid="${safeUserId}", oid="${safeOrderId}";
      var dl="omnisms://payment-return?status=success&provider=geniuspay&userId="+
             encodeURIComponent(uid)+"&orderId="+encodeURIComponent(oid);
      setTimeout(function(){try{window.location.href=dl;}catch(e){}},2000);
    })();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(html);
});

// ════════════════════════════════════════════════════════════════
// ROUTE 7 : GET /api/payment/geniuspay/config
// ════════════════════════════════════════════════════════════════
/**
 * Retourner la configuration GeniusPay pour le frontend / Flutter.
 */
router.get('/config', (req, res) => {
  const configured = !!(process.env.GENIUSPAY_API_KEY && process.env.GENIUSPAY_API_SECRET);

  return res.status(200).json({
    provider  : 'geniuspay',
    configured,
    amount    : PREMIUM_AMOUNT,
    currency  : PREMIUM_CURRENCY,
    createUrl : `${BACKEND_URL}/api/payment/geniuspay/create`,
    linkUrl   : `${BACKEND_URL}/api/payment/link`,
    webhookUrl: `${BACKEND_URL}/api/payment/geniuspay/webhook`,
    status    : configured ? 'active' : 'not_configured',
  });
});

module.exports = router;
