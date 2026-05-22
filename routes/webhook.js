'use strict';
/**
 * OmniSMS — routes/webhook.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Ancienne route webhook (maintenue pour rétrocompatibilité).
 * Redirige vers le handler LeekPay si le corps ressemble à un
 * webhook LeekPay.
 *
 * Route exposée :
 *   POST /api/payment/webhook
 *
 * Note : Le webhook principal LeekPay est :
 *   POST /api/payment/webhook/leekpay
 *
 * Cette route est conservée au cas où l'URL de l'ancien webhook
 * est encore configurée quelque part.
 */

const express    = require('express');
const router     = express.Router();
const { logger } = require('../middleware/logger');

// Forwarder vers le handler LeekPay
const leekpayController = require('../controllers/leekpayController');

// ── POST /api/payment/webhook (rétrocompat) ───────────────────
router.post('/webhook', (req, res) => {
  logger.info('[Webhook retrocompat] Requête reçue sur /api/payment/webhook — redirection vers handler LeekPay', {
    ip    : req.ip,
    event : req.headers['x-leekpay-event'] || req.body?.event || 'unknown',
  });

  // Déléguer au controller LeekPay
  return leekpayController.handleWebhook(req, res);
});

module.exports = router;
