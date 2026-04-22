'use strict';
/**
 * OmniSMS — Payment Service (Orchestrateur)
 *
 * Utilise Firestore comme base de données (collection "users_sms").
 * Aucune dépendance sur l'in-memory store.
 */

const db       = require('../config/firebase');
const { resolveCredits, isPremiumAmount, PAYMENT_NUMBER, PREMIUM_AMOUNT } = require('./creditSystem');
const { logPaymentAttempt } = require('./antifraud');
const { normalizePhone } = require('../config/db');

// ─────────────────────────────────────────────────────────────
// Helpers Firestore
// ─────────────────────────────────────────────────────────────

async function getOrCreateSmsUser(phone) {
  const key = normalizePhone(phone);
  const ref = db.collection('users_sms').doc(key);
  const snap = await ref.get();

  if (snap.exists) return { ref, data: snap.data() };

  const defaults = {
    phone     : key,
    credits   : 0,
    premium   : false,
    createdAt : new Date().toISOString(),
    updatedAt : new Date().toISOString(),
  };
  await ref.set(defaults);
  return { ref, data: defaults };
}

// ─────────────────────────────────────────────────────────────
// Activer le premium
// ─────────────────────────────────────────────────────────────

/**
 * Activer le premium pour un utilisateur.
 * @param {string} phone   - Numéro normalisé (E.164)
 * @param {string} channel - 'online_moneyfusion' | 'offline_sms' | 'manual_admin'
 * @param {string} ip      - IP de la requête
 * @returns {Promise<{success:boolean, user:object|null, error:string|undefined}>}
 */
async function activatePremium(phone, channel = 'unknown', ip = '0.0.0.0') {
  const { ref, data } = await getOrCreateSmsUser(phone);

  if (data.premium) {
    return { success: false, error: 'Utilisateur déjà Premium', user: data };
  }

  const now = new Date().toISOString();
  const updates = {
    premium             : true,
    premiumActivatedAt  : now,
    lastPaymentAt       : now,
    activationChannel   : channel,
    activationIp        : ip,
    updatedAt           : now,
  };

  await ref.update(updates);

  logPaymentAttempt({
    phone,
    ip,
    action : 'ACTIVATE_PREMIUM',
    status : 'success',
    details: `channel=${channel}`,
  });

  return { success: true, user: { ...data, ...updates } };
}

// ─────────────────────────────────────────────────────────────
// Recharger les crédits
// ─────────────────────────────────────────────────────────────

/**
 * Recharger les crédits d'un utilisateur.
 * @returns {Promise<{success:boolean, creditsAdded:number, newBalance:number, user:object, error:string}>}
 */
async function rechargeCredits(phone, amount, channel = 'offline_sms', ip = '0.0.0.0') {
  const credits = resolveCredits(amount);

  if (!credits) {
    return { success: false, error: `Montant ${amount}F non reconnu dans le barème` };
  }

  const { ref, data } = await getOrCreateSmsUser(phone);
  const newBalance = (data.credits || 0) + credits;

  const now = new Date().toISOString();
  const updates = {
    credits      : newBalance,
    lastPaymentAt: now,
    updatedAt    : now,
  };

  await ref.update(updates);

  logPaymentAttempt({
    phone,
    ip,
    action : 'RECHARGE_CREDITS',
    status : 'success',
    details: `amount=${amount}F credits=${credits} new_balance=${newBalance} channel=${channel}`,
  });

  return { success: true, creditsAdded: credits, newBalance, user: { ...data, ...updates } };
}

// ─────────────────────────────────────────────────────────────
// Vérifier le statut
// ─────────────────────────────────────────────────────────────

/**
 * Vérifier le statut d'un utilisateur SMS.
 * @returns {Promise<object>}
 */
async function getUserStatus(phone) {
  const normalized = normalizePhone(phone);
  const snap = await db.collection('users_sms').doc(normalized).get();

  if (!snap.exists) return { found: false, phone: normalized };

  const user = snap.data();
  return {
    found             : true,
    phone             : user.phone,
    credits           : user.credits || 0,
    premium           : user.premium || false,
    premiumActivatedAt: user.premiumActivatedAt || null,
    activationChannel : user.activationChannel || null,
    lastPaymentAt     : user.lastPaymentAt || null,
  };
}

module.exports = {
  activatePremium,
  rechargeCredits,
  getUserStatus,
};
