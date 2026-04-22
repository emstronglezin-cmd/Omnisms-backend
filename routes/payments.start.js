/**
 * OmniSMS - Route /payments
 * 
 * ⚠️  ANCIENNE LOGIQUE SUPPRIMÉE (PayDunya, MoneyFusion API)
 * 
 * Redirections vers la nouvelle architecture :
 *  - Paiement online : GET /payment-success
 *  - Paiement offline : POST /sms/incoming
 *  - Lien MoneyFusion : GET /moneyfusion-link
 */

const express = require('express');
const router  = express.Router();

// Redirection info
router.all('*', (req, res) => {
  return res.status(410).json({
    error: 'Cette route est obsolète.',
    migration: {
      online_payment: 'GET /payment-success → POST /confirm-payment',
      offline_sms: 'POST /sms/incoming',
      moneyfusion_link: 'GET /moneyfusion-link',
    },
    docs: 'GET / pour voir toutes les routes disponibles.',
  });
});

module.exports = router;
