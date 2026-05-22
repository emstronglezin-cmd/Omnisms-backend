'use strict';
/**
 * OmniSMS — Routes LeekPay
 * ═══════════════════════════════════════════════════════════════
 *
 * Système de paiement via LeekPay.me (Mobile Money + Carte).
 *
 * Routes exposées (toutes montées sous /api/payment) :
 * ┌─────────────────────────────────────────────────────────────┐
 * │  POST /api/payment/leekpay                                  │
 * │    → { userId, amount?, currency?, phone?, email?, name? }  │
 * │    ← { success, checkout_url, checkout_id, orderId, ... }   │
 * │                                                             │
 * │  POST /api/payment/webhook/leekpay                          │
 * │    → Corps webhook LeekPay (payment.completed)              │
 * │    → Validation signature HMAC X-LeekPay-Signature         │
 * │    → Activation premium Firebase si paid                    │
 * │                                                             │
 * │  GET  /api/payment/status/:transactionId                    │
 * │    → Statut d'un paiement (Firestore + API LeekPay)        │
 * │                                                             │
 * │  GET  /api/payment/user-status                              │
 * │    → ?userId=xxx → { premium, isSubscribed, ... }          │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Variables d'environnement requises :
 *   LEEKPAY_API_KEY        → pk_live_xxx (clé publique + signature webhook)
 *   LEEKPAY_SECRET_KEY     → sk_live_xxx (authentification API)
 *   LEEKPAY_BASE_URL       → https://leekpay.fr (défaut)
 *   LEEKPAY_WEBHOOK_SECRET → Secret optionnel pour la signature webhook
 *   FRONTEND_URL           → URL frontend (retour après paiement)
 *
 * Webhook LeekPay à configurer :
 *   https://omnisms-backend.onrender.com/api/payment/webhook/leekpay
 *
 * @see https://www.leekpay.me/docs
 */

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/leekpayController');
const { logger } = require('../middleware/logger');

// ══════════════════════════════════════════════════════════════
//  MIDDLEWARE WEBHOOK : parser le rawBody avant json()
// ══════════════════════════════════════════════════════════════
// Note : express.json() avec verify: rawBody est déjà configuré dans server.js
// Ici on ajoute juste un log de réception avant le handler

function webhookLogger(req, res, next) {
  logger.info('[LeekPay Route] Webhook reçu', {
    ip         : req.ip,
    method     : req.method,
    event      : req.headers['x-leekpay-event'] || 'unknown',
    delivery   : req.headers['x-leekpay-delivery'] || 'unknown',
    contentType: req.headers['content-type'],
    bodySize   : req.rawBody?.length || 0,
  });
  next();
}

// ══════════════════════════════════════════════════════════════
//  ROUTE 1 : POST /api/payment/leekpay
//  Initier un paiement LeekPay
// ══════════════════════════════════════════════════════════════
/**
 * Créer un checkout LeekPay pour un abonnement Premium.
 *
 * Body JSON :
 *   {
 *     "userId"  : "firebase_uid",     (requis)
 *     "amount"  : 2000,               (optionnel — défaut 2000 XOF)
 *     "currency": "XOF",              (optionnel — XOF | EUR | USD)
 *     "phone"   : "+22670123456",     (optionnel — Mobile Money)
 *     "email"   : "user@example.com", (optionnel)
 *     "name"    : "Jean Dupont"       (optionnel)
 *   }
 *
 * Réponse 200 :
 *   {
 *     "success"     : true,
 *     "checkout_url": "https://leekpay.me/pay_AbCdEf...",
 *     "checkout_id" : "checkout_42",
 *     "orderId"     : "OMNI-LP-1234567890-AB12C",
 *     "amount"      : 2000,
 *     "currency"    : "XOF",
 *     "expiresAt"   : "2026-01-16T12:00:00Z"
 *   }
 */
router.post('/leekpay', controller.createPayment);

// ══════════════════════════════════════════════════════════════
//  ROUTE 2 : POST /api/payment/webhook/leekpay
//  Webhook LeekPay (notification de paiement)
// ══════════════════════════════════════════════════════════════
/**
 * Endpoint webhook appelé par LeekPay.
 *
 * LeekPay envoie une requête POST avec :
 *   Headers :
 *     X-LeekPay-Event    : payment.completed
 *     X-LeekPay-Delivery : <id_unique>
 *     X-LeekPay-Signature: <hmac_sha256_hex>
 *   Body :
 *     {
 *       "event": "payment.completed",
 *       "data": {
 *         "transaction_id": "TXN_ABC123",
 *         "checkout_id"   : "checkout_42",
 *         "amount"        : 2000,
 *         "currency"      : "XOF",
 *         "status"        : "paid",
 *         "payment_method": "mobile_money",
 *         "customer"      : { email, name, phone },
 *         "metadata"      : { userId, orderId },
 *         "paid_at"       : "2026-01-15T10:30:00Z"
 *       }
 *     }
 *
 * Comportement :
 *   - Répond 200 immédiatement (évite timeout LeekPay)
 *   - Valide la signature HMAC en async
 *   - Active le premium Firebase si status=paid
 *
 * URL à configurer dans LeekPay Dashboard :
 *   https://omnisms-backend.onrender.com/api/payment/webhook/leekpay
 */
router.post('/webhook/leekpay', webhookLogger, controller.handleWebhook);

// ══════════════════════════════════════════════════════════════
//  ROUTE 3 : GET /api/payment/status/:transactionId
//  Statut d'un paiement
// ══════════════════════════════════════════════════════════════
/**
 * Vérifier le statut d'un paiement.
 *
 * Params URL :
 *   :transactionId → checkoutId (checkout_xxx) ou orderId (OMNI-LP-xxx)
 *
 * Réponse 200 :
 *   {
 *     "success"         : true,
 *     "checkoutId"      : "checkout_42",
 *     "status"          : "paid",
 *     "amount"          : 2000,
 *     "currency"        : "XOF",
 *     "premiumActivated": true,
 *     "paidAt"          : "2026-01-15T10:30:00Z",
 *     "source"          : "firestore"
 *   }
 */
router.get('/status/:transactionId', controller.getPaymentStatus);

// ══════════════════════════════════════════════════════════════
//  ROUTE 4 : GET /api/payment/user-status
//  Statut premium d'un utilisateur
// ══════════════════════════════════════════════════════════════
/**
 * Vérifier si un utilisateur est premium.
 *
 * Query :
 *   ?userId=firebase_uid
 *
 * Réponse 200 :
 *   {
 *     "success"      : true,
 *     "userId"       : "xxx",
 *     "premium"      : true,
 *     "isSubscribed" : true,
 *     "subscribedAt" : "2026-01-15T10:30:00Z",
 *     "paymentMethod": "leekpay"
 *   }
 */
router.get('/user-status', controller.getUserPremiumStatus);

module.exports = router;
