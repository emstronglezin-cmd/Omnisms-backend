const express = require('express');
const axios = require('axios');

const router = express.Router();

/**
 * Mémoire simple des sessions OFFLINE
 * (à remplacer plus tard par DB)
 */
const sessions = {};

/**
 * Flux :
 * START -> ASK_NETWORK -> ASK_PLAN -> INIT_PAYMENT -> WAIT_CONFIRM
 */

router.post('/sms', async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone et message requis' });
  }

  if (!sessions[phone]) {
    sessions[phone] = { step: 'START' };
  }

  const session = sessions[phone];
  let reply = '';

  try {
    switch (session.step) {

      case 'START':
        reply =
          'Bienvenue sur OmniSMS.\n' +
          'Choisissez votre réseau de paiement :\n' +
          '1. Orange\n2. Moov\n3. Telecel';
        session.step = 'ASK_NETWORK';
        break;

      case 'ASK_NETWORK':
        if (!['1','2','3'].includes(message.trim())) {
          reply = 'Choix invalide. Répondez 1, 2 ou 3.';
          break;
        }
        session.network = message.trim();
        reply =
          'Choisissez votre abonnement :\n' +
          '1. 50 FCFA (Jour)\n' +
          '2. 100 FCFA (Semaine)\n' +
          '3. 1000 FCFA (Mois)';
        session.step = 'ASK_PLAN';
        break;

      case 'ASK_PLAN':
        const plans = {
          '1': 50,
          '2': 100,
          '3': 1000
        };

        if (!plans[message.trim()]) {
          reply = 'Choix invalide. Répondez 1, 2 ou 3.';
          break;
        }

        session.amount = plans[message.trim()];

        // INIT MONEYFUSION
        await axios.post(
          process.env.MONEYFUSION_API_URL,
          {
            phone: phone,
            amount: session.amount,
            currency: 'XOF',
            description: 'Abonnement OmniSMS OFFLINE'
          },
          { headers: { 'Content-Type': 'application/json' } }
        );

        reply =
          'Paiement initié.\n' +
          'Veuillez confirmer sur votre téléphone.\n' +
          'Vous recevrez une notification.';
        session.step = 'WAIT_CONFIRM';
        break;

      case 'WAIT_CONFIRM':
        reply =
          'Paiement en cours de traitement.\n' +
          'Merci de patienter.';
        break;

      default:
        reply = 'Session expirée. Envoyez un nouveau message.';
        delete sessions[phone];
        break;
    }

    // Ici tu brancheras Orange / Twilio plus tard
    console.log('[OFFLINE]', phone, '=>', reply);

    return res.json({ success: true, reply });

  } catch (error) {
    console.error('OFFLINE PAYMENT ERROR:', error.message);
    return res.status(500).json({ error: 'Erreur paiement offline' });
  }
});

module.exports = router;

// =======================================
// 🧠 OmniSMS - Offline Payment State Logic
// =======================================
/**
 * paymentState:
 * idle → waiting_otp → paid → expired
 */
function ensurePaymentState(user) {
  if (!user.paymentState) {
    user.paymentState = 'idle';
  }
  return user.paymentState;
}

function markWaitingOTP(user) {
  user.paymentState = 'waiting_otp';
}

function markPaid(user) {
  user.paymentState = 'paid';
  user.isPremium = true;
}

module.exports.ensurePaymentState = ensurePaymentState;
module.exports.markWaitingOTP = markWaitingOTP;
module.exports.markPaid = markPaid;
