'use strict';
/**
 * OmniSMS — Fusion Pay (Money Fusion API)
 * Route PARALLÈLE — NE remplace PAS l'ancien Fusion Link
 *
 * Endpoints :
 *  POST /api/payment/fusion-pay              → Initier un paiement
 *  POST /api/payment/fusion-callback         → Webhook Money Fusion
 *  POST /api/payment/fusion-callback-api     → Alias webhook (compatibilité Flutter)
 *  GET  /api/payment/fusion-status/:token    → Statut d'un paiement
 *  GET  /api/payment/fusion-user/:userId     → Statut abonnement utilisateur
 *  GET  /api/payment/fusion-return           → Page HTML retour WebView
 *  GET  /api/payment/fusion-config           → Config pour Flutter
 *  GET  /api/payment/fusion-link-url         → URL Fusion Link (ancien système)
 *
 * Toutes les données sont persistées dans Firestore (production réelle).
 * Aucune donnée en mémoire, aucun mock.
 *
 * Variables d'environnement requises :
 *  FUSION_PAY_API_URL     : URL API Money Fusion (depuis le dashboard)
 *  FUSION_PAY_API_KEY     : Clé API privée Money Fusion
 *  FUSION_PAY_APP_ID      : Identifiant application (ex : OmniSMS)
 *  BACKEND_URL            : URL publique du backend
 *  MONEYFUSION_PAYMENT_LINK : Lien Fusion Link (ancien système, conservé)
 */

const express   = require('express');
const axios     = require('axios');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

// ── Structured logger (no console.* calls in this file) ────────
const { logger } = require('../middleware/logger');

// ── Config depuis variables d'environnement ─────────────────────
const FUSION_PAY_API_URL        = process.env.FUSION_PAY_API_URL;
const FUSION_PAY_API_KEY        = process.env.FUSION_PAY_API_KEY;
const FUSION_PAY_APP_ID         = process.env.FUSION_PAY_APP_ID || 'OmniSMS';
const FUSION_PAY_WEBHOOK_SECRET = process.env.FUSION_PAY_WEBHOOK_SECRET;
const BACKEND_URL               = process.env.BACKEND_URL || 'https://votre-backend.onrender.com';
const MONEYFUSION_PAYMENT_LINK  = process.env.MONEYFUSION_PAYMENT_LINK || '';

// ── Firestore (production, zéro mock) ──────────────────────────
const db = require('../config/firebase');

// ── Rate limiter spécifique à l'initiation de paiement ─────────
const fusionPayInitLimiter = rateLimit({
  windowMs       : 60 * 1000,
  max            : 10,
  standardHeaders: true,
  legacyHeaders  : false,
  message: { success: false, error: 'Trop de tentatives. Réessayez dans 1 minute.' },
});

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════

/**
 * Valider la signature HMAC du webhook Money Fusion.
 * Si FUSION_PAY_WEBHOOK_SECRET n'est pas défini, la validation est ignorée.
 */
function validateWebhookSignature(req) {
  if (!FUSION_PAY_WEBHOOK_SECRET) return true;

  const signature = req.headers['x-moneyfusion-signature']
                 || req.headers['x-fusion-signature']
                 || '';

  if (!signature) {
    logger.warn('[FusionPay] Signature webhook manquante');
    return false;
  }

  try {
    const expected = crypto
      .createHmac('sha256', FUSION_PAY_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected,  'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Persister un paiement (ou mettre à jour) dans Firestore.
 * Collection : payments_fusionpay / document : tokenPay
 */
async function savePayment(tokenPay, data) {
  await db
    .collection('payments_fusionpay')
    .doc(tokenPay)
    .set(
      { ...data, updatedAt: new Date().toISOString() },
      { merge: true }
    );
}

/**
 * Activer l'abonnement OmniSMS d'un utilisateur dans Firestore.
 * - Met à jour users/{userId}
 * - Crée un enregistrement dans subscriptions/
 */
async function activateUserSubscription(userId, tokenPay, paymentData = {}) {
  const now  = new Date().toISOString();
  const data = {
    isSubscribed  : true,
    subscribedAt  : now,
    paymentMethod : 'fusion_pay_api',
    tokenPay,
    amount        : paymentData.Montant || 2000,
    moyen         : paymentData.moyen   || 'unknown',
    transactionId : paymentData.numeroTransaction || tokenPay,
    updatedAt     : now,
  };

  // Mise à jour atomique du document utilisateur
  await db.collection('users').doc(userId).set(data, { merge: true });

  // Historique des abonnements
  await db.collection('subscriptions').add({
    userId,
    ...data,
    createdAt: now,
    app: 'OmniSMS',
  });

  logger.info('[FusionPay] Abonnement activé', { userId, tokenPay });
  return data;
}

/**
 * Vérifier si un utilisateur est déjà abonné (Firestore).
 */
async function isUserSubscribed(userId) {
  const doc = await db.collection('users').doc(userId).get();
  return doc.exists && doc.data()?.isSubscribed === true;
}

// ══════════════════════════════════════════════════════════════════
// ROUTE 1 : POST /api/payment/fusion-pay
// ══════════════════════════════════════════════════════════════════
/**
 * Initier un paiement Fusion Pay depuis l'app Flutter OmniSMS.
 *
 * Body JSON :
 *   { userId, montant: 2000, devise: "XOF", phone?, nomClient? }
 *
 * Réponse succès :
 *   { success: true, paymentUrl, token, orderId }
 */
router.post('/fusion-pay', fusionPayInitLimiter, async (req, res) => {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim())
          || req.socket?.remoteAddress
          || '0.0.0.0';

  const { userId, montant, devise, phone, nomClient } = req.body || {};

  // Validation
  if (!userId || typeof userId !== 'string' || userId.trim().length < 3) {
    return res.status(400).json({
      success: false,
      error  : 'userId requis (UID Firebase de l\'utilisateur)',
    });
  }

  if (Number(montant) !== 2000) {
    return res.status(400).json({
      success: false,
      error  : 'Le montant doit être exactement 2000 XOF.',
    });
  }

  if (!FUSION_PAY_API_URL) {
    return res.status(503).json({
      success: false,
      error  : 'Fusion Pay non configuré. Contactez l\'administrateur.',
    });
  }

  const cleanUserId = userId.trim();

  // Vérifier si déjà abonné
  try {
    if (await isUserSubscribed(cleanUserId)) {
      return res.status(400).json({
        success          : false,
        error            : 'Cet utilisateur est déjà abonné à OmniSMS Premium.',
        alreadySubscribed: true,
      });
    }
  } catch (err) {
    logger.error('[FusionPay] Erreur Firestore isSubscribed', { error: err.message });
    return res.status(500).json({ success: false, error: 'Erreur base de données.' });
  }

  // Construire le payload Money Fusion
  const orderId     = `OMNI-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const callbackUrl = `${BACKEND_URL}/api/payment/fusion-callback`;
  const returnUrl   = `${BACKEND_URL}/api/payment/fusion-return?userId=${encodeURIComponent(cleanUserId)}`;

  const payload = {
    totalPrice   : 2000,
    article      : [{ 'OmniSMS Premium': 2000 }],
    personal_Info: [{ userId: cleanUserId, orderId, appId: FUSION_PAY_APP_ID }],
    numeroSend   : phone ? phone.replace(/\s/g, '') : '00000000',
    nomclient    : nomClient || 'Utilisateur OmniSMS',
    return_url   : returnUrl,
    webhook_url  : callbackUrl,
  };

  logger.info('[FusionPay] Initiation paiement', { userId: cleanUserId, orderId, ip });

  // Appel API Money Fusion
  let fusionRes;
  try {
    fusionRes = await axios.post(FUSION_PAY_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        ...(FUSION_PAY_API_KEY ? { 'moneyfusion-private-key': FUSION_PAY_API_KEY } : {}),
      },
      timeout: 15000,
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error('[FusionPay] Erreur API Money Fusion', { error: msg, userId: cleanUserId });

    if (msg?.includes('Unauthorized IP') || msg?.includes('unapproved')) {
      return res.status(503).json({
        success: false,
        error  : 'IP du serveur non autorisée. Ajoutez l\'IP dans le dashboard Money Fusion.',
        hint   : 'Dashboard Money Fusion → Settings → Applications → IP autorisées',
      });
    }

    return res.status(502).json({
      success: false,
      error  : 'Impossible de contacter Money Fusion. Réessayez.',
      detail : process.env.NODE_ENV !== 'production' ? msg : undefined,
    });
  }

  const { statut, token, url, message } = fusionRes.data || {};

  if (!statut || !token) {
    logger.error('[FusionPay] Réponse inattendue de Money Fusion', { data: fusionRes.data });
    return res.status(502).json({ success: false, error: 'Réponse invalide de Money Fusion.' });
  }

  // Sauvegarder le paiement en attente dans Firestore
  try {
    await savePayment(token, {
      userId   : cleanUserId,
      status   : 'pending',
      amount   : 2000,
      currency : devise || 'XOF',
      phone    : phone || null,
      nomClient: nomClient || null,
      orderId,
      ip,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('[FusionPay] Erreur sauvegarde Firestore (non bloquant)', { error: err.message });
    // Non bloquant — retourner quand même l'URL au client
  }

  logger.info('[FusionPay] URL de paiement générée', { token, userId: cleanUserId });

  return res.status(200).json({
    success   : true,
    paymentUrl: url,
    token,
    orderId,
    message   : message || 'Paiement initié',
  });
});

// ══════════════════════════════════════════════════════════════════
// ROUTE 2 : POST /api/payment/fusion-callback
// ══════════════════════════════════════════════════════════════════
/**
 * Webhook Money Fusion — appelé automatiquement par les serveurs Money Fusion
 * après confirmation de paiement.
 *
 * Répond 200 immédiatement, traitement asynchrone.
 * Idempotent : un même tokenPay traité une seule fois.
 */
router.post('/fusion-callback', async (req, res) => {
  // Réponse immédiate pour éviter les retries Money Fusion
  res.status(200).json({ received: true, ts: new Date().toISOString() });

  setImmediate(() => processWebhook(req).catch(err => {
    logger.error('[FusionPay Webhook] Erreur non gérée', { error: err.message });
  }));
});

// ══════════════════════════════════════════════════════════════════
// ROUTE 2-bis : POST /api/payment/fusion-callback-api
// ══════════════════════════════════════════════════════════════════
/**
 * Alias webhook pour la compatibilité Flutter et les intégrations tierces.
 * Même comportement que /fusion-callback.
 * Body : webhook Money Fusion standard
 *  { event, tokenPay, statut, Montant, moyen, numeroTransaction, personal_Info }
 *
 * Réponse : HTTP 200 { received: true }
 * Met à jour Firestore et active isSubscribed=true si paiement confirmé.
 */
router.post('/fusion-callback-api', async (req, res) => {
  // Réponse immédiate pour éviter les retries Money Fusion
  res.status(200).json({ received: true, ts: new Date().toISOString() });

  setImmediate(() => processWebhook(req).catch(err => {
    logger.error('[FusionPay Webhook API] Erreur non gérée', { error: err.message });
  }));
});

// ── Traitement asynchrone du webhook (partagé) ─────────────────
async function processWebhook(req) {
  const body = req.body || {};

  logger.info('[FusionPay Webhook] Événement reçu', {
    event : body.event,
    statut: body.statut,
    token : body.tokenPay,
  });

  // Validation signature
  if (!validateWebhookSignature(req)) {
    logger.error('[FusionPay Webhook] Signature invalide — ignoré');
    return;
  }

  const { event, tokenPay, statut, Montant, moyen, numeroTransaction, personal_Info } = body;

  if (!tokenPay) {
    logger.warn('[FusionPay Webhook] tokenPay absent — ignoré');
    return;
  }

  // Extraire userId
  const info   = Array.isArray(personal_Info) ? personal_Info[0] : (personal_Info || {});
  const userId = info?.userId;

  if (!userId) {
    logger.warn('[FusionPay Webhook] userId absent', { tokenPay });
    return;
  }

  // Idempotence : vérifier si déjà traité dans Firestore
  try {
    const payDoc = await db.collection('payments_fusionpay').doc(tokenPay).get();
    if (payDoc.exists && payDoc.data()?.status === 'paid') {
      logger.info('[FusionPay Webhook] Doublon ignoré', { tokenPay });
      return;
    }
  } catch (err) {
    logger.warn('[FusionPay Webhook] Impossible de vérifier doublon', { error: err.message });
  }

  const isPaid    = event === 'payin.session.completed' || statut === 'paid';
  const isFailed  = event === 'payin.session.cancelled' || statut === 'failure' || statut === 'no paid';
  const isPending = event === 'payin.session.pending';

  if (isPaid) {
    logger.info('[FusionPay Webhook] Paiement CONFIRMÉ', { tokenPay, userId, Montant, moyen });

    await savePayment(tokenPay, {
      status           : 'paid',
      userId,
      orderId          : info?.orderId,
      moyen,
      numeroTransaction,
      Montant,
      paidAt           : new Date().toISOString(),
      webhookEvent     : event,
    });

    await activateUserSubscription(userId, tokenPay, body);

  } else if (isFailed) {
    logger.info('[FusionPay Webhook] Paiement ÉCHOUÉ', { tokenPay, userId });

    await savePayment(tokenPay, {
      status      : 'failed',
      userId,
      failedAt    : new Date().toISOString(),
      webhookEvent: event,
      failReason  : statut,
    });

  } else if (isPending) {
    logger.info('[FusionPay Webhook] Paiement EN ATTENTE', { tokenPay, userId });

    await savePayment(tokenPay, {
      status      : 'processing',
      userId,
      webhookEvent: event,
    });

  } else {
    logger.info('[FusionPay Webhook] Événement non géré', { event });
  }
}

// ══════════════════════════════════════════════════════════════════
// ROUTE 3 : GET /api/payment/fusion-status/:token
// ══════════════════════════════════════════════════════════════════
/**
 * Vérifier le statut d'un paiement.
 * Interroge Firestore puis l'API Money Fusion si nécessaire.
 */
router.get('/fusion-status/:token', async (req, res) => {
  const token = req.params.token?.trim();

  if (!token || token.length < 5) {
    return res.status(400).json({ success: false, error: 'Token invalide' });
  }

  // 1. Firestore (source de vérité locale)
  let localData = null;
  try {
    const doc = await db.collection('payments_fusionpay').doc(token).get();
    if (doc.exists) localData = doc.data();
  } catch (err) {
    logger.warn('[FusionPay Status] Erreur Firestore', { error: err.message });
  }

  // 2. API Money Fusion (uniquement si pas encore paid)
  let apiData = null;
  if (!localData || !['paid', 'failed'].includes(localData.status)) {
    try {
      const apiRes = await axios.get(
        `https://www.pay.moneyfusion.net/paiementNotif/${token}`,
        { timeout: 10000 }
      );
      apiData = apiRes.data?.data || null;
    } catch (err) {
      logger.warn('[FusionPay Status] API Money Fusion inaccessible', { error: err.message });
    }
  }

  // 3. Statut final : API externe prioritaire
  const finalStatus = apiData?.statut || localData?.status || 'unknown';

  // 4. Si API confirme 'paid' mais Firestore pas encore mis à jour
  if (finalStatus === 'paid' && localData?.status !== 'paid') {
    const uid = localData?.userId || apiData?.personal_Info?.[0]?.userId;
    if (uid) {
      try {
        await savePayment(token, {
          status : 'paid',
          paidAt : new Date().toISOString(),
          moyen  : apiData?.moyen,
          Montant: apiData?.Montant,
          source : 'polling',
        });
        await activateUserSubscription(uid, token, apiData || {});
        logger.info('[FusionPay Status] Abonnement activé via polling', { userId: uid });
      } catch (err) {
        logger.error('[FusionPay Status] Erreur activation via polling', { error: err.message });
      }
    }
  }

  return res.status(200).json({
    success  : true,
    token,
    status   : finalStatus,
    isPaid   : finalStatus === 'paid',
    amount   : apiData?.Montant || localData?.amount,
    moyen    : apiData?.moyen   || localData?.moyen || null,
    createdAt: localData?.createdAt || null,
  });
});

// ══════════════════════════════════════════════════════════════════
// ROUTE 4 : GET /api/payment/fusion-user/:userId
// ══════════════════════════════════════════════════════════════════
/**
 * Vérifier si un utilisateur OmniSMS est abonné.
 * Utilisé par Flutter au démarrage et après paiement.
 */
router.get('/fusion-user/:userId', async (req, res) => {
  const userId = req.params.userId?.trim();

  if (!userId || userId.length < 3) {
    return res.status(400).json({ success: false, error: 'userId invalide' });
  }

  try {
    const doc  = await db.collection('users').doc(userId).get();
    const data = doc.exists ? doc.data() : null;
    const subscribed = data?.isSubscribed === true;

    return res.status(200).json({
      success     : true,
      userId,
      isSubscribed: subscribed,
      subscription: subscribed ? {
        subscribedAt : data?.subscribedAt  || null,
        moyen        : data?.moyen         || null,
        amount       : data?.amount        || null,
        transactionId: data?.transactionId || null,
      } : null,
    });
  } catch (err) {
    logger.error('[FusionPay] Erreur Firestore fusion-user', { error: err.message, userId });
    return res.status(500).json({ success: false, error: 'Erreur base de données.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// ROUTE 5 : GET /api/payment/fusion-return
// ══════════════════════════════════════════════════════════════════
/**
 * Page HTML affichée dans le WebView après retour de paiement.
 * L'app Flutter détecte cette URL et lance la vérification du statut.
 */
router.get('/fusion-return', (req, res) => {
  const safeUserId = (req.query.userId || '').replace(/[<>"'&]/g, '');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>OmniSMS — Paiement</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#0d1117;color:#f0f6fc;min-height:100vh;
         display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:16px;
          padding:36px 28px;max-width:340px;width:100%;text-align:center}
    .icon{font-size:60px;margin-bottom:18px;display:block;
          animation:pop .5s cubic-bezier(.36,.07,.19,.97)}
    @keyframes pop{0%{transform:scale(.5);opacity:0}70%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
    h1{font-size:20px;font-weight:700;color:#58a6ff;margin-bottom:10px}
    p{font-size:13px;color:#8b949e;line-height:1.6;margin-bottom:18px}
    .badge{display:inline-block;background:linear-gradient(135deg,#1f6feb,#388bfd);
           color:#fff;padding:8px 20px;border-radius:20px;font-size:12px;font-weight:600}
    .prog{width:50px;height:3px;background:#21262d;border-radius:2px;margin:18px auto 0;overflow:hidden}
    .bar{height:100%;background:#1f6feb;animation:fill 3s linear forwards}
    @keyframes fill{from{width:0}to{width:100%}}
    .note{margin-top:16px;font-size:11px;color:#484f58}
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">✅</span>
    <h1>Paiement reçu !</h1>
    <p>Votre paiement est en cours de vérification.<br>
       OmniSMS confirmera automatiquement.</p>
    <span class="badge">⏳ Activation en cours…</span>
    <div class="prog"><div class="bar"></div></div>
    <p class="note">Vous pouvez fermer cette page et revenir dans l'application.</p>
  </div>
  <script>
    (function(){
      var uid="${safeUserId}";
      var dl="omnisms://payment-return?status=success&userId="+encodeURIComponent(uid);
      setTimeout(function(){ try{window.location.href=dl;}catch(e){} },2500);
    })();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(html);
});

// ══════════════════════════════════════════════════════════════════
// ROUTE 6 : GET /api/payment/fusion-config
// ══════════════════════════════════════════════════════════════════
/**
 * Configuration publique pour l'app Flutter.
 * Indique quelles méthodes de paiement sont disponibles.
 */
router.get('/fusion-config', (req, res) => {
  const fusionPayEnabled  = !!FUSION_PAY_API_URL;
  const linkRaw           = MONEYFUSION_PAYMENT_LINK;
  const fusionLinkEnabled = !!linkRaw
    && linkRaw !== 'https://pay.moneyfusion.net/votre_lien'
    && linkRaw !== '#';

  return res.status(200).json({
    fusionPayEnabled,
    fusionLinkEnabled,
    fusionLinkUrl: fusionLinkEnabled ? linkRaw : null,
    amount       : 2000,
    currency     : 'XOF',
    app          : 'OmniSMS',
    callbackUrl  : `${BACKEND_URL}/api/payment/fusion-callback`,
    callbackApiUrl: `${BACKEND_URL}/api/payment/fusion-callback-api`,
    returnUrl    : `${BACKEND_URL}/api/payment/fusion-return`,
    activeMethod : fusionPayEnabled ? 'fusion_pay' : (fusionLinkEnabled ? 'fusion_link' : 'none'),
  });
});

// ══════════════════════════════════════════════════════════════════
// ROUTE 7 : GET /api/payment/fusion-link-url
// ══════════════════════════════════════════════════════════════════
/**
 * Retourne l'URL Fusion Link (ancien système, conservé).
 * Flutter l'utilise pour ouvrir le lien dans le navigateur externe.
 */
router.get('/fusion-link-url', (req, res) => {
  const link = MONEYFUSION_PAYMENT_LINK;
  const ok   = !!link
    && link !== 'https://pay.moneyfusion.net/votre_lien'
    && link !== '#';

  if (!ok) {
    return res.status(404).json({
      success: false,
      error  : 'Fusion Link non configuré (MONEYFUSION_PAYMENT_LINK).',
    });
  }

  return res.status(200).json({
    success : true,
    url     : link,
    amount  : 2000,
    currency: 'XOF',
    app     : 'OmniSMS',
  });
});

module.exports = router;
