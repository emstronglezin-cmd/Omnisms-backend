'use strict';
/**
 * OmniSMS — Statut fournisseur SMS + point d'envoi générique.
 * Fournisseur OFFICIEL : smsgate (SMSGate open source — application Android
 * sur le téléphone passerelle). LEGACY : INfiniReach DÉSACTIVÉ définitivement
 * (plus aucune variable INFINIREACH_* lue, plus aucun appel, plus de fallback).
 * Infobip : retiré du projet.
 */

function getProviderStatus() {
  let smsgate = false, smsgateEnabled = false;
  try {
    const p = require('./smsGateProvider');
    smsgate = !!(p.isConfigured && p.isConfigured());
    smsgateEnabled = !!(p.isEnabled && p.isEnabled());
  } catch (_) {}
  const selected = String(process.env.OFFLINE_SMS_PROVIDER || 'smsgate').toLowerCase().trim();
  const activeProvider = smsgateEnabled ? 'smsgate' : 'none';
  return {
    activeProvider,
    selected,
    smsgate: { configured: smsgate },
    // Clé conservée pour compatibilité des lectures /health — désormais inerte.
    sms_gateway: { configured: false, disabled: true, legacy: 'infinireach' },
    legacy: { provider: 'infinireach', disabled: true },
  };
}

/**
 * Envoi générique : SMSGate UNIQUEMENT (aucun fallback vers un fournisseur
 * legacy — une indisponibilité est une erreur visible, jamais une bascule
 * silencieuse).
 */
async function sendSMS(to, message, opts = {}) {
  try {
    const p = require('./smsGateProvider');
    if (p.isEnabled && p.isEnabled()) {
      const r = await p.sendSMS({ to, text: message, messageId: (opts && opts.messageId) || null });
      return { success: !!r.success, provider: 'smsgate', result: r, error: r.success ? null : r.error };
    }
  } catch (_) {}
  return { success: false, provider: 'none', error: 'Aucun fournisseur SMS actif — SMSGate requis (SMS_GATEWAY_*).' };
}

module.exports = { sendSMS, getProviderStatus };
