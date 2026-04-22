'use strict';
/**
 * OmniSMS — routes/webhook.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Webhook GeniusPay — reçoit les notifications de paiement.
 *
 * Route exposée :
 *   POST /api/payment/webhook
 *
 * Comportement :
 *   1. Répond HTTP 200 immédiatement (évite les timeouts GeniusPay)
 *   2. Vérifie la signature HMAC X-Genius-Signature
 *   3. Si payment.status === "success" → active user.premium = true
 *   4. Logue toutes les requêtes (même les rejets)
 *
 * Sécurité :
 *   - Vérification HMAC avec GENIUSPAY_WEBHOOK_SECRET si défini
 *   - Mode dégradé si secret absent (log d'alerte)
 *   - Traitement idempotent (même orderId traité une seule fois)
 *
 * Configuration Render :
 *   URL à enregistrer dans le dashboard GeniusPay :
 *   https://omnisms-backend.onrender.com/api/payment/webhook
 */

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/paymentController');

// ── POST /api/payment/webhook ─────────────────────────────────
/**
 * Webhook GeniusPay.
 *
 * GeniusPay envoie un POST avec :
 *   Header : X-Genius-Signature: sha256=<hmac>
 *   Body   :
 *     {
 *       "id"      : "pay_xxx",
 *       "status"  : "success",
 *       "amount"  : 2000,
 *       "metadata": { "userId": "user123", "orderId": "OMNI-GP-..." }
 *     }
 *
 * Réponse : 200 { received: true } (toujours — même si signature invalide)
 * Le rejet s'effectue silencieusement pour éviter les retries infinis.
 */
router.post('/webhook', controller.handleWebhook);

module.exports = router;
