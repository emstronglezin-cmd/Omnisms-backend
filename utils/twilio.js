'use strict';
/**
 * OmniSMS — Utilitaire Twilio (wrapper)
 *
 * Utilisez de préférence services/smsProvider.js qui gère
 * multi-provider + retry automatique.
 *
 * Ce fichier est conservé pour compatibilité avec le code legacy.
 * Il n'écrase plus le processus si les variables d'environnement manquent.
 */

const { logger } = require('../middleware/logger');

/**
 * Envoyer un SMS via Twilio.
 * Retourne { success, sid } ou { success: false, error }.
 */
async function sendSms(to, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_PHONE } = process.env;
  const from = TWILIO_PHONE_NUMBER || TWILIO_PHONE;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !from) {
    logger.warn('Twilio non configuré — SMS non envoyé', { to });
    return { success: false, error: 'Twilio non configuré (variables d\'environnement manquantes)' };
  }

  try {
    const twilio = require('twilio');
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const message = await client.messages.create({ body, from, to });
    logger.info('SMS Twilio envoyé', { to, sid: message.sid });
    return { success: true, sid: message.sid };
  } catch (err) {
    logger.error('Erreur Twilio', { to, error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Gérer un SMS entrant Twilio (webhook handler).
 */
async function handleIncomingSms(req, res) {
  const { From, Body } = req.body;

  try {
    logger.info('SMS Twilio entrant', { from: From, preview: Body?.substring(0, 40) });

    // Déléguer au gestionnaire principal
    const { handleSMS } = require('../services/smsHandler');
    const { normalizePhone } = require('../config/db');
    const reply = await handleSMS(normalizePhone(From), Body, req.ip);

    const safe = reply
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    res.set('Content-Type', 'text/xml');
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`);
  } catch (err) {
    logger.error('Erreur handler SMS Twilio entrant', { error: err.message });
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Erreur. Réessayez.</Message></Response>`);
  }
}

module.exports = { sendSms, handleIncomingSms };
