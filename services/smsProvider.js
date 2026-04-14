'use strict';
/**
 * OmniSMS — SMS Provider Service
 *
 * Envoi SMS multi-provider avec retry automatique.
 * Ordre de priorité :
 *  1. Twilio (si TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER configurés)
 *  2. Africa's Talking (si AFRICASTALKING_API_KEY + AFRICASTALKING_USERNAME configurés)
 *  3. Orange (si ORANGE_CLIENT_ID + ORANGE_CLIENT_SECRET configurés)
 *
 * Chaque envoi est tenté jusqu'à MAX_RETRIES fois avec un délai exponentiel.
 * Aucun crash si un provider n'est pas configuré.
 */

const { logger } = require('../middleware/logger');

const MAX_RETRIES   = 3;
const RETRY_DELAY_MS = 1000; // Délai initial, doublé à chaque tentative

// ─────────────────────────────────────────────────────────────
// Helper : pause
// ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────
// Provider : Twilio
// ─────────────────────────────────────────────────────────────
async function sendViaTwilio(to, message) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_PHONE } = process.env;
  const from = TWILIO_PHONE_NUMBER || TWILIO_PHONE;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !from) {
    throw new Error('Twilio non configuré (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER manquants)');
  }

  // Import Twilio à la demande pour éviter le crash si non installé
  let twilio;
  try {
    twilio = require('twilio');
  } catch {
    throw new Error('Package twilio non installé (npm install twilio)');
  }

  const client   = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const response = await client.messages.create({
    body: message,
    from,
    to,
  });

  logger.info('SMS envoyé via Twilio', { to, sid: response.sid, status: response.status });
  return { provider: 'twilio', sid: response.sid, status: response.status };
}

// ─────────────────────────────────────────────────────────────
// Provider : Africa's Talking
// ─────────────────────────────────────────────────────────────
async function sendViaAfricasTalking(to, message) {
  const { AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME } = process.env;

  if (!AFRICASTALKING_API_KEY || !AFRICASTALKING_USERNAME) {
    throw new Error('Africa\'s Talking non configuré (AFRICASTALKING_API_KEY / AFRICASTALKING_USERNAME manquants)');
  }

  const africastalking = require('africastalking')({
    apiKey  : AFRICASTALKING_API_KEY,
    username: AFRICASTALKING_USERNAME,
  });

  const response = await africastalking.SMS.send({ to: [to], message });
  const recipient = response?.SMSMessageData?.Recipients?.[0];

  logger.info('SMS envoyé via Africa\'s Talking', { to, status: recipient?.status });
  return { provider: 'africastalking', status: recipient?.status, messageId: recipient?.messageId };
}

// ─────────────────────────────────────────────────────────────
// Provider : Orange (API SMS)
// ─────────────────────────────────────────────────────────────
async function sendViaOrange(to, message) {
  const { ORANGE_CLIENT_ID, ORANGE_CLIENT_SECRET, ORANGE_SENDER_ID } = process.env;

  if (!ORANGE_CLIENT_ID || !ORANGE_CLIENT_SECRET) {
    throw new Error('Orange non configuré (ORANGE_CLIENT_ID / ORANGE_CLIENT_SECRET manquants)');
  }

  const axios  = require('axios');
  const senderId = ORANGE_SENDER_ID || '+22675405214';

  // Obtenir le token OAuth2
  const tokenResp = await axios.post(
    'https://api.orange.com/oauth/v3/token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization : 'Basic ' + Buffer.from(`${ORANGE_CLIENT_ID}:${ORANGE_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10_000,
    }
  );
  const token = tokenResp.data.access_token;

  const smsResp = await axios.post(
    `https://api.orange.com/smsmessaging/v1/outbound/tel:${senderId}/requests`,
    {
      outboundSMSMessageRequest: {
        address               : `tel:${to}`,
        outboundSMSTextMessage: { message },
        senderAddress         : `tel:${senderId}`,
      },
    },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15_000,
    }
  );

  logger.info('SMS envoyé via Orange', { to, status: smsResp.status });
  return { provider: 'orange', status: smsResp.status };
}

// ─────────────────────────────────────────────────────────────
// Détection automatique du provider disponible
// ─────────────────────────────────────────────────────────────
function detectAvailableProvider() {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN &&
      (process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_PHONE)) {
    return 'twilio';
  }
  if (process.env.AFRICASTALKING_API_KEY && process.env.AFRICASTALKING_USERNAME) {
    return 'africastalking';
  }
  if (process.env.ORANGE_CLIENT_ID && process.env.ORANGE_CLIENT_SECRET) {
    return 'orange';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Fonction principale d'envoi avec retry automatique
// ─────────────────────────────────────────────────────────────

/**
 * Envoyer un SMS avec retry automatique (max 3 tentatives).
 * @param {string} to        - Numéro destinataire (E.164)
 * @param {string} message   - Contenu du message
 * @param {string} [provider] - Forcer un provider ('twilio'|'africastalking'|'orange')
 * @returns {Promise<{success:boolean, provider:string, result:object, attempts:number, error:string}>}
 */
async function sendSMS(to, message, provider) {
  const selectedProvider = provider || detectAvailableProvider();

  if (!selectedProvider) {
    logger.warn('Aucun provider SMS configuré', { to });
    return {
      success  : false,
      provider : 'none',
      result   : null,
      attempts : 0,
      error    : 'Aucun provider SMS configuré (Twilio / Africa\'s Talking / Orange)',
    };
  }

  const senders = {
    twilio        : sendViaTwilio,
    africastalking: sendViaAfricasTalking,
    orange        : sendViaOrange,
  };

  const sendFn = senders[selectedProvider];
  if (!sendFn) {
    return { success: false, provider: selectedProvider, result: null, attempts: 0, error: `Provider inconnu : ${selectedProvider}` };
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await sendFn(to, message);
      logger.info('SMS envoyé avec succès', { to, provider: selectedProvider, attempt });
      return { success: true, provider: selectedProvider, result, attempts: attempt, error: null };
    } catch (err) {
      lastError = err;
      logger.warn(`SMS tentative ${attempt}/${MAX_RETRIES} échouée`, {
        to, provider: selectedProvider, error: err.message,
      });

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt); // Délai exponentiel
      }
    }
  }

  logger.error('Échec envoi SMS après toutes tentatives', {
    to, provider: selectedProvider, error: lastError?.message,
  });

  return {
    success  : false,
    provider : selectedProvider,
    result   : null,
    attempts : MAX_RETRIES,
    error    : lastError?.message || 'Erreur inconnue',
  };
}

/**
 * Vérifier l'état de configuration des providers.
 * Utilisé par /health pour le diagnostic.
 */
function getProviderStatus() {
  const provider = detectAvailableProvider();
  return {
    activeProvider: provider || 'none',
    twilio: {
      configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN &&
                     (process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_PHONE)),
    },
    africastalking: {
      configured: !!(process.env.AFRICASTALKING_API_KEY && process.env.AFRICASTALKING_USERNAME),
    },
    orange: {
      configured: !!(process.env.ORANGE_CLIENT_ID && process.env.ORANGE_CLIENT_SECRET),
    },
  };
}

module.exports = {
  sendSMS,
  sendViaTwilio,
  sendViaAfricasTalking,
  sendViaOrange,
  getProviderStatus,
};
