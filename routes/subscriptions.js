'use strict';
/**
 * OmniSMS — Routes Abonnements
 *
 * Utilise Firestore comme source de vérité.
 * Aucune dépendance sur l'in-memory store (config/db).
 */

const express = require('express');
const router  = express.Router();
const db      = require('../config/firebase');
const { logger } = require('../middleware/logger');

/**
 * GET /subscriptions/status/:phone
 * → Vérifier le statut premium d'un utilisateur par téléphone
 */
router.get('/status/:phone', async (req, res) => {
  const { phone } = req.params;

  if (!phone) {
    return res.status(400).json({ error: 'phone est requis.', code: 'MISSING_FIELDS' });
  }

  try {
    const snap = await db
      .collection('users_sms')
      .where('phone', '==', phone)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', phone });
    }

    const user = snap.docs[0].data();
    return res.status(200).json({
      phone              : user.phone,
      premium            : user.premium || false,
      credits            : user.credits || 0,
      premiumActivatedAt : user.premiumActivatedAt || null,
      activationChannel  : user.activationChannel || null,
    });
  } catch (err) {
    logger.error('Erreur /subscriptions/status', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

/**
 * GET /subscriptions/plans
 * → Retourner les plans disponibles
 */
router.get('/plans', (req, res) => {
  const { PAYMENT_NUMBER, PREMIUM_AMOUNT, CREDIT_TABLE } = require('../services/creditSystem');

  return res.status(200).json({
    plans: [
      {
        id      : 'premium',
        name    : 'OmniSMS Premium',
        amount  : PREMIUM_AMOUNT,
        currency: 'XOF',
        description: 'Accès illimité à toutes les fonctionnalités',
        activation: {
          online : 'Payer via Fusion Pay → 2000 XOF',
          offline: `Envoyer ${PREMIUM_AMOUNT}F au ${PAYMENT_NUMBER} → SMS "CONFIRM PREMIUM"`,
        },
      },
      ...(CREDIT_TABLE || []).map(t => ({
        id      : `credits_${t.amount}`,
        name    : `Recharge ${t.amount}F`,
        amount  : t.amount,
        currency: 'XOF',
        credits : t.credits,
        description: `+${t.credits} crédits SMS`,
        activation: {
          offline: `Envoyer ${t.amount}F au ${PAYMENT_NUMBER} → SMS "CONFIRM ${t.amount}"`,
        },
      })),
    ],
  });
});

module.exports = router;
