'use strict';
/**
 * OmniSMS — SMS Provider Status
 *
 * Active provider: Infobip only.
 * All legacy providers have been removed — Infobip is the sole active provider.
 *
 * For outbound SMS use: require('./infobip').sendSMS(...)
 * For status checks:    getProviderStatus()
 */

const { logger } = require('../middleware/logger');

/**
 * Returns the active SMS provider status.
 * Kept for backward-compat with server.js health checks.
 */
function getProviderStatus() {
  const infobipOk = !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);
  return {
    activeProvider: infobipOk ? 'infobip' : 'none',
    infobip: {
      configured: infobipOk,
      baseUrl   : process.env.INFOBIP_BASE_URL || null,
      senderId  : process.env.INFOBIP_SENDER_ID || 'OmniSMS',
    },
  };
}

/**
 * Send an SMS via the active provider (Infobip).
 * Thin wrapper so existing callers don't break.
 */
async function sendSMS(to, message) {
  const infobip = require('./infobip');

  if (!infobip.isConfigured()) {
    logger.warn('[smsProvider] Infobip not configured — cannot send SMS', { to });
    return {
      success : false,
      provider: 'infobip',
      error   : 'INFOBIP_API_KEY and INFOBIP_BASE_URL must be set in Render environment variables.',
    };
  }

  const result = await infobip.sendSMS({ to, text: message });
  return {
    success : result.success,
    provider: 'infobip',
    result  : result,
    error   : result.success ? null : result.error,
  };
}

module.exports = {
  sendSMS,
  getProviderStatus,
};
