'use strict';
/**
 * OmniSMS — SMS Provider Status (neutre).
 * Fournisseurs possibles : smsgate (SMSGate open source) | sms_gateway (INfiniReach, en pause
 * sauf sélection explicite). Infobip : retiré du projet.
 * Pour l'envoi : passer par services/smsGateway.js (point d'entrée unique) ou
 * services/smsGateProvider.js (SMSGate direct).
 */

function getProviderStatus() {
  let smsgate = false;
  try { const p = require('./smsGateProvider'); smsgate = !!(p.isConfigured && p.isConfigured()); } catch (_) {}
  const infiniReach = !!(process.env.INFINIREACH_API_KEY && process.env.INFINIREACH_FROM_NUMBER
    && process.env.INFINIREACH_ENABLED !== 'false');
  const selected = String(process.env.OFFLINE_SMS_PROVIDER || 'sms_gateway').toLowerCase().trim();
  const activeProvider = selected === 'smsgate' && smsgate ? 'smsgate'
    : selected === 'sms_gateway' && infiniReach ? 'sms_gateway'
    : 'none';
  return {
    activeProvider,
    selected,
    smsgate: { configured: smsgate },
    sms_gateway: { configured: infiniReach, paused: selected !== 'sms_gateway' },
  };
}

async function sendSMS(to, message) {
  try {
    const p = require('./smsGateProvider');
    if (p.isEnabled && p.isEnabled()) {
      const r = await p.sendSMS({ to, text: message });
      return { success: !!r.success, provider: 'smsgate', result: r, error: r.success ? null : r.error };
    }
  } catch (_) {}
  try {
    const g = require('./smsGateway');
    if (g.isSmsGatewayProvider() && g.isConfigured()) {
      const r = await g.sendSMS({ to, text: message });
      return { success: !!r.success, provider: 'sms_gateway', result: r, error: r.success ? null : r.error };
    }
  } catch (_) {}
  return { success: false, provider: 'none', error: 'Aucun fournisseur SMS actif (voir OFFLINE_SMS_PROVIDER).' };
}

module.exports = { sendSMS, getProviderStatus };
