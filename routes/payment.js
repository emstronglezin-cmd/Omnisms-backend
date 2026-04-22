'use strict';
/**
 * OmniSMS — routes/payment.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Route principale du système de paiement GeniusPay.
 *
 * Route exposée :
 *   POST /api/payment/geniuspay
 *     → reçoit { userId, amount? }
 *     → appelle GeniusPay API
 *     → retourne { checkout_url }
 *
 * Variables d'environnement requises :
 *   GENIUSPAY_PUBLIC_KEY  → Clé publique GeniusPay (X-API-Key)
 *   GENIUSPAY_SECRET_KEY  → Clé secrète GeniusPay  (X-API-Secret)
 */

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/paymentController');

// ── POST /api/payment/geniuspay ────────────────────────────────
/**
 * Initier un paiement GeniusPay.
 *
 * Body JSON requis :
 *   { "userId": "string", "amount": 2000 }
 *
 * Réponse succès (200) :
 *   {
 *     "success": true,
 *     "checkout_url": "https://pay.genius.ci/checkout/...",
 *     "paymentId": "...",
 *     "orderId": "OMNI-GP-...",
 *     "amount": 2000,
 *     "currency": "XOF"
 *   }
 *
 * Réponses erreur :
 *   400 → userId manquant ou utilisateur déjà premium
 *   503 → GeniusPay non configuré (clés manquantes)
 *   502 → Erreur API GeniusPay
 */
router.post('/geniuspay', controller.createPayment);

module.exports = router;
