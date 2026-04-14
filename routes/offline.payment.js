/**
 * OmniSMS - Route /offline-payment
 * 
 * ⚠️  ANCIENNE LOGIQUE SUPPRIMÉE
 *     (Sessions état OTP, MoneyFusion API init, simulation)
 * 
 * Le paiement offline est désormais géré par :
 *   POST /sms/incoming  → Webhook SMS universel
 *   POST /sms/test      → Test manuel (dev)
 * 
 * Commandes SMS : RECHARGE <montant>, CONFIRM <montant>,
 *                 PREMIUM, CONFIRM PREMIUM, SOLDE, AIDE
 */

const express = require('express');
const router  = express.Router();

router.all('*', (req, res) => {
  return res.status(410).json({
    error: 'Cette route est obsolète.',
    migration: {
      sms_webhook: 'POST /sms/incoming',
      sms_test: 'POST /sms/test',
      sms_commands: 'GET /sms/commands',
    },
    commands: ['RECHARGE <montant>', 'CONFIRM <montant>', 'PREMIUM', 'CONFIRM PREMIUM', 'SOLDE', 'AIDE'],
  });
});

module.exports = router;
