/**
 * OmniSMS - SMS Webhook Controller (Refactorisé)
 * 
 * Délègue vers le nouveau smsHandler.
 * Conservé pour compatibilité avec les routes existantes.
 */

const { handleSMS } = require('../services/smsHandler');
const { normalizePhone } = require('../config/db');

const handleIncomingSMS = async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '0.0.0.0';

  // Support Africa's Talking, Twilio, format générique
  const phone   = req.body.from || req.body.From || req.body.phone || req.body.sender;
  const message = req.body.text || req.body.Body || req.body.message || req.body.content;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone et message requis' });
  }

  try {
    const reply = await handleSMS(normalizePhone(phone), message, ip);

    // Twilio TwiML
    if (req.body.From) {
      const safe = reply.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      res.set('Content-Type', 'text/xml');
      return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`);
    }

    return res.status(200).json({ success: true, reply });
  } catch (err) {
    console.error('❌ SMS Webhook error:', err.message);
    return res.status(500).json({ error: 'Erreur traitement SMS' });
  }
};

module.exports = { handleIncomingSMS };
