'use strict';
/**
 * OmniSMS — SMS Quota Manager (Firestore)
 *
 * Gère le quota SMS quotidien des utilisateurs non-premium.
 * Quota par défaut : 5 SMS/jour.
 * Les utilisateurs Premium (isSubscribed=true) ont un quota illimité.
 *
 * Les quotas sont persistés dans Firestore — pas de données en mémoire.
 *
 * Usage :
 *   const { checkSmsQuota } = require('../middleware/smsQuota');
 *   // En middleware Express :
 *   router.post('/send', authenticate, checkSmsQuotaMiddleware, handler);
 *   // En service :
 *   const allowed = await checkSmsQuota(phone);
 */

const db = require('../config/firebase');
const { logger } = require('./logger');

const DAILY_QUOTA = 5;  // SMS gratuits par jour

// Lien d'abonnement GeniusPay
const SUBSCRIPTION_LINK = process.env.GENIUSPAY_PAYMENT_LINK
  || `${process.env.BACKEND_URL || 'https://omnisms-backend.onrender.com'}/api/payment/link`;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ─────────────────────────────────────────────────────────────
// checkSmsQuota(userId)
// Vérifie et décrémente le quota d'un utilisateur dans Firestore.
// @param {string} userId - UID Firestore de l'utilisateur
// @returns {Promise<{allowed:boolean, remaining:number, isPremium:boolean}>}
// ─────────────────────────────────────────────────────────────
async function checkSmsQuota(userId) {
  try {
    const doc  = await db.collection('users').doc(userId).get();
    const data = doc.exists ? doc.data() : null;

    if (!data) {
      logger.warn('checkSmsQuota: utilisateur non trouvé', { userId });
      return { allowed: false, remaining: 0, isPremium: false };
    }

    // Les abonnés Premium n'ont aucune restriction
    if (data.isSubscribed === true) {
      return { allowed: true, remaining: Infinity, isPremium: true };
    }

    const today = todayKey();
    const lastQuotaDate  = data.smsQuotaDate  || null;
    const quotaCount     = (lastQuotaDate === today) ? (data.smsQuotaCount || 0) : 0;

    if (quotaCount >= DAILY_QUOTA) {
      logger.info('Quota SMS dépassé', { userId, quotaCount, today });
      return { allowed: false, remaining: 0, isPremium: false };
    }

    // Décrémenter le quota dans Firestore
    const newCount = quotaCount + 1;
    await db.collection('users').doc(userId).update({
      smsQuotaDate : today,
      smsQuotaCount: newCount,
      updatedAt    : new Date().toISOString(),
    });

    const remaining = DAILY_QUOTA - newCount;
    return { allowed: true, remaining, isPremium: false };

  } catch (err) {
    logger.error('Erreur checkSmsQuota', { error: err.message, userId });
    // En cas d'erreur Firestore, on autorise par défaut (dégradé gracieux)
    return { allowed: true, remaining: DAILY_QUOTA, isPremium: false };
  }
}

// ─────────────────────────────────────────────────────────────
// checkSmsQuotaMiddleware
// Middleware Express qui bloque les non-abonnés dépassant leur quota.
// Requiert que req.user soit défini (middleware authenticate en amont).
// ─────────────────────────────────────────────────────────────
async function checkSmsQuotaMiddleware(req, res, next) {
  if (!req.user || !req.user.uid) {
    return res.status(401).json({
      error: 'Authentification requise.',
      code : 'NO_AUTH',
    });
  }

  try {
    const { allowed, remaining, isPremium } = await checkSmsQuota(req.user.uid);

    if (!allowed) {
      return res.status(429).json({
        error      : `Quota SMS quotidien dépassé (${DAILY_QUOTA} SMS/jour pour les comptes gratuits).`,
        code       : 'QUOTA_EXCEEDED',
        remaining  : 0,
        upgradeUrl : SUBSCRIPTION_LINK,
        hint       : 'Passez Premium pour un envoi illimité.',
      });
    }

    // Injecter les infos de quota dans la requête
    req.smsQuota = { remaining, isPremium };
    next();

  } catch (err) {
    logger.error('Erreur middleware checkSmsQuota', { error: err.message });
    // Dégradé gracieux — ne pas bloquer l'envoi si le quota ne peut pas être vérifié
    req.smsQuota = { remaining: DAILY_QUOTA, isPremium: false };
    next();
  }
}

module.exports = {
  checkSmsQuota,
  checkSmsQuotaMiddleware,
  DAILY_QUOTA,
};
