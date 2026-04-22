/**
 * OmniSMS - PayDunya Service
 * 
 * ⚠️  SUPPRIMÉ - PayDunya n'est plus utilisé dans OmniSMS v2.0
 * 
 * Ce fichier est conservé pour éviter les erreurs d'import
 * dans du code legacy. Il n'effectue aucune action.
 * 
 * Système de paiement actuel :
 *  - ONLINE  : MoneyFusion (lien direct)
 *  - OFFLINE : SMS (RECHARGE / CONFIRM / PREMIUM)
 */

module.exports = {
  setupPayDunya: () => {
    console.warn('⚠️ PayDunya supprimé. Utilisez MoneyFusion (lien direct).');
  },
  createInvoice: async () => {
    throw new Error('PayDunya supprimé. Utilisez MoneyFusion (lien direct).');
  },
  withdrawFunds: async () => {
    throw new Error('PayDunya supprimé.');
  },
  automateOwnerShareTransfer: async () => {
    throw new Error('PayDunya supprimé.');
  },
};
