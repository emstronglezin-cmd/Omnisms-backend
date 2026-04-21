/**
 * OmniSMS - Webhook SMS (Logique Offline)
 * 
 * Compatible avec :
 *  - Africa's Talking
 *  - Twilio
 *  - Orange (format custom)
 *  - Test manuel via POST
 * 
 * Toutes les plateformes envoient au même endpoint.
 * Le middleware détecte le format automatiquement.
 */

const express = require('express');
const router  = express.Router();

const { handleSMS } = require('../services/smsHandler');
const { normalizePhone } = require('../config/db');

/**
 * Extraire phone + message depuis différents formats de webhook
 */
function extractPhoneAndMessage(body) {
  // Africa's Talking
  if (body.from && body.text) {
    return { phone: body.from, message: body.text };
  }

  // Twilio (URLencoded)
  if (body.From && body.Body) {
    return { phone: body.From, message: body.Body };
  }

  // Orange (format custom)
  if (body.sender && body.content) {
    return { phone: body.sender, message: body.content };
  }

  // Format générique / test manuel
  if (body.phone && body.message) {
    return { phone: body.phone, message: body.message };
  }

  // Format compact
  if (body.number && body.msg) {
    return { phone: body.number, message: body.msg };
  }

  return null;
}

/* ============================================================
   POST /sms/incoming
   → Webhook universel pour SMS entrants
   → Compatible Africa's Talking, Twilio, Orange, test
============================================================ */
router.post('/incoming', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '0.0.0.0';

  const extracted = extractPhoneAndMessage(req.body);

  if (!extracted) {
    console.warn(`⚠️ [SMS WEBHOOK] Format inconnu : ${JSON.stringify(req.body)}`);
    return res.status(400).json({ error: 'Format de requête non reconnu. Champs attendus: phone+message, From+Body, ou from+text' });
  }

  const { phone, message } = extracted;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone et message sont requis' });
  }

  const normalizedPhone = normalizePhone(phone);

  try {
    const reply = await handleSMS(normalizedPhone, message, ip);

    console.log(`📤 [SMS OUT] to=${normalizedPhone} | reply="${reply.substring(0, 60)}..."`);

    // Retourner au format attendu par chaque provider
    const userAgent = req.headers['user-agent'] || '';

    // Africa's Talking attend un format spécifique
    if (req.body.from && req.body.text) {
      return res.status(200).json({
        recipients: [{ number: normalizedPhone, message: reply }],
      });
    }

    // Twilio attend du TwiML XML
    if (req.body.From && req.body.Body) {
      const escapedReply = reply
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapedReply}</Message></Response>`
      );
    }

    // Format générique (test / Orange)
    return res.status(200).json({
      success: true,
      to: normalizedPhone,
      reply,
    });

  } catch (err) {
    console.error('❌ [SMS HANDLER ERROR]', err.message);
    return res.status(500).json({ error: 'Erreur interne lors du traitement du SMS' });
  }
});

/* ============================================================
   POST /sms/test
   → Endpoint de test (dev uniquement)
   → Simule un SMS entrant sans webhook réel
============================================================ */
router.post('/test', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_SMS_TEST) {
    return res.status(403).json({ error: 'Test désactivé en production' });
  }

  const { phone, message } = req.body;
  const ip = req.ip || '127.0.0.1';

  if (!phone || !message) {
    return res.status(400).json({
      error: 'phone et message requis',
      example: { phone: '+22670000000', message: 'RECHARGE 500' },
      commands: ['RECHARGE <montant>', 'CONFIRM <montant>', 'PREMIUM', 'CONFIRM PREMIUM', 'SOLDE', 'AIDE'],
    });
  }

  try {
    const reply = await handleSMS(normalizePhone(phone), message, ip);
    return res.status(200).json({
      success: true,
      phone: normalizePhone(phone),
      message,
      reply,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   GET /sms/commands
   → Documentation des commandes SMS disponibles
============================================================ */
router.get('/commands', (req, res) => {
  const { getRechargeTable, PAYMENT_NUMBER, PREMIUM_AMOUNT } = require('../services/creditSystem');

  return res.json({
    commands: [
      { cmd: 'RECHARGE <montant>', desc: 'Demander les instructions de recharge', example: 'RECHARGE 500' },
      { cmd: 'CONFIRM <montant>', desc: 'Valider une recharge après paiement', example: 'CONFIRM 500' },
      { cmd: 'PREMIUM', desc: 'Demander les instructions paiement Premium', example: 'PREMIUM' },
      { cmd: 'CONFIRM PREMIUM', desc: 'Activer le compte Premium après paiement', example: 'CONFIRM PREMIUM' },
      { cmd: 'SOLDE', desc: 'Voir son solde de crédits', example: 'SOLDE' },
      { cmd: 'AIDE', desc: 'Afficher l\'aide', example: 'AIDE' },
    ],
    creditTable: [
      { amount: 150,  credits: 150,  bonus: '+0%'  },
      { amount: 500,  credits: 600,  bonus: '+20%' },
      { amount: 1000, credits: 1300, bonus: '+30%' },
    ],
    premium: { amount: PREMIUM_AMOUNT, currency: 'XOF', description: 'Accès illimité OmniSMS' },
    paymentNumber: PAYMENT_NUMBER,
  });
});

module.exports = router;
