/**
 * OmniSMS - MoneyFusion Service
 * 
 * ⚠️  AUCUN APPEL API MoneyFusion dans ce fichier.
 * 
 * MoneyFusion est utilisé UNIQUEMENT via son lien de paiement direct.
 * Aucune clé API, aucun SDK, aucun webhook MoneyFusion.
 * 
 * FLUX :
 *  1. Utilisateur accède au lien MoneyFusion (pré-configuré)
 *  2. MoneyFusion redirige vers return_url = /payment-success
 *  3. L'utilisateur saisit son téléphone → POST /confirm-payment
 *  4. Backend active le premium
 * 
 * Configurer dans votre espace MoneyFusion :
 *   - Montant : 2000 XOF
 *   - return_url : https://votre-backend.com/payment-success
 *   - Description : OmniSMS Premium
 */

const MONEYFUSION_PAYMENT_LINK = process.env.MONEYFUSION_PAYMENT_LINK || '#';
const BACKEND_URL = process.env.BACKEND_URL || 'https://votre-backend.com';

/**
 * Obtenir le lien de paiement MoneyFusion
 */
function getPaymentLink() {
  return MONEYFUSION_PAYMENT_LINK;
}

/**
 * Obtenir la return_url à configurer dans MoneyFusion
 */
function getReturnUrl() {
  return `${BACKEND_URL}/payment-success`;
}

/**
 * Informations de configuration MoneyFusion
 */
function getConfig() {
  return {
    paymentLink: getPaymentLink(),
    returnUrl: getReturnUrl(),
    amount: 2000,
    currency: 'XOF',
    description: 'OmniSMS Premium',
    instructions: [
      '1. Configurez votre lien MoneyFusion sur pay.moneyfusion.net',
      `2. Définissez le montant à 2000 XOF`,
      `3. Définissez return_url = ${getReturnUrl()}`,
      '4. Copiez le lien dans MONEYFUSION_PAYMENT_LINK dans .env',
    ],
  };
}

module.exports = {
  getPaymentLink,
  getReturnUrl,
  getConfig,
};
