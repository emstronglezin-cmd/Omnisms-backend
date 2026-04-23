'use strict';
/**
 * OmniSMS — Middleware d'abonnement
 *
 * Vérifie que l'utilisateur connecté a un abonnement Premium actif (isSubscribed = true)
 * avant d'autoriser l'accès aux routes protégées.
 *
 * Données lues depuis Firestore (production — pas de mock).
 *
 * Usage :
 *   router.post('/some-route', authenticate, requireSubscription, handler)
 *
 * Réponse si non abonné :
 *   403 { error, code, upgradeUrl }
 */

const db = require('../config/firebase');
const { logger } = require('./logger');

const SUBSCRIPTION_LINK = process.env.GENIUSPAY_PAYMENT_LINK
  || `${process.env.BACKEND_URL || 'https://omnisms-backend.onrender.com'}/api/payment/link`;

/**
 * Middleware — vérifie isSubscribed dans Firestore.
 * Requiert que authenticate soit passé avant (req.user doit être défini).
 */
async function requireSubscription(req, res, next) {
  if (!req.user || !req.user.uid) {
    return res.status(401).json({
      error: 'Authentification requise.',
      code : 'NO_AUTH',
    });
  }

  try {
    // Lire directement dans Firestore — source de vérité unique
    const snap = await db.collection('users').doc(req.user.uid).get();

    if (!snap.exists) {
      return res.status(403).json({
        error     : 'Utilisateur non trouvé. Créez votre compte d\'abord.',
        code      : 'USER_NOT_FOUND',
        upgradeUrl: SUBSCRIPTION_LINK,
      });
    }

    const user = snap.data();

    if (!user.isSubscribed) {
      logger.info('Accès refusé — abonnement requis', { uid: req.user.uid });
      return res.status(403).json({
        error     : 'Abonnement Premium requis pour accéder à cette fonctionnalité.',
        code      : 'SUBSCRIPTION_REQUIRED',
        upgradeUrl: SUBSCRIPTION_LINK,
        price     : '2000 XOF (paiement unique)',
      });
    }

    // Injecter les infos d'abonnement dans la requête
    req.subscription = {
      isSubscribed: true,
      subscribedAt: user.subscribedAt || null,
    };

    next();
  } catch (err) {
    logger.error('Erreur vérification abonnement', { error: err.message, uid: req.user?.uid });
    return res.status(500).json({
      error: 'Erreur lors de la vérification de l\'abonnement.',
      code : 'SUBSCRIPTION_CHECK_ERROR',
    });
  }
}

/**
 * Middleware optionnel — charge les infos d'abonnement sans bloquer.
 * req.isSubscribed sera défini même si non abonné.
 */
async function loadSubscription(req, res, next) {
  if (!req.user || !req.user.uid) {
    req.isSubscribed = false;
    return next();
  }

  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    req.isSubscribed = snap.exists ? (snap.data().isSubscribed || false) : false;
  } catch {
    req.isSubscribed = false;
  }
  next();
}

module.exports = requireSubscription;
module.exports.loadSubscription = loadSubscription;
