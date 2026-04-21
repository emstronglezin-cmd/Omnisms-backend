/**
 * OmniSMS - Système de Crédits
 * 
 * Barème de recharge :
 *   150F  → +150 crédits
 *   500F  → +600 crédits
 *   1000F → +1300 crédits
 * 
 * Premium : 2000F → accès illimité
 */

/**
 * Table de correspondance montant → crédits
 */
const CREDIT_TABLE = [
  { amount: 150,  credits: 150  },
  { amount: 500,  credits: 600  },
  { amount: 1000, credits: 1300 },
];

/**
 * Montant premium
 */
const PREMIUM_AMOUNT = 2000;

/**
 * Numéro de paiement manuel OmniSMS
 */
const PAYMENT_NUMBER = '+22675405214';

/**
 * Résoudre le montant en crédits
 * @param {number} amount - Montant en FCFA
 * @returns {number|null} - Crédits accordés, ou null si montant non reconnu
 */
function resolveCredits(amount) {
  const entry = CREDIT_TABLE.find(e => e.amount === Number(amount));
  return entry ? entry.credits : null;
}

/**
 * Obtenir le message de barème formaté
 */
function getRechargeTable() {
  return CREDIT_TABLE.map(e => `  ${e.amount}F → ${e.credits} crédits`).join('\n');
}

/**
 * Vérifier si un montant est un montant premium
 */
function isPremiumAmount(amount) {
  return Number(amount) === PREMIUM_AMOUNT;
}

module.exports = {
  CREDIT_TABLE,
  PREMIUM_AMOUNT,
  PAYMENT_NUMBER,
  resolveCredits,
  getRechargeTable,
  isPremiumAmount,
};
