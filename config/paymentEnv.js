'use strict';
/**
 * OmniSMS — Configuration Paiement SasPay.
 * Les anciennes variables LEEKPAY_* ne sont volontairement jamais
 * copiées : les identifiants LeekPay ne sont pas des clés SasPay.
 * La base URL est facultative et le code utilise https://api.saspay.me.
 * Les journaux n'exposent jamais les valeurs complètes des secrets.
 */

const LEGACY_FALLBACK = Object.freeze({}); // volontairement vide : pas de migration de secrets entre fournisseurs

/* Variables requises par services/saaspay.js */
const REQUIRED_VARS = Object.freeze(['SAASPAY_SECRET_KEY']);

/* Variables optionnelles (valeurs par défaut dans le code) */
const OPTIONAL_VARS = Object.freeze([
  'SAASPAY_BASE_URL',
  'SAASPAY_API_KEY',
  'SAASPAY_WEBHOOK_SECRET',
  'SAASPAY_PREMIUM_AMOUNT',
  'SAASPAY_PREMIUM_CURRENCY',
  'BACKEND_URL',
  'FRONTEND_URL',
]);

/* Variables legacy qui ne sont volontairement PAS recopiées */
const LEGACY_IGNORED = Object.freeze([
  'LEEKPAY_API_KEY', 'LEEKPAY_SECRET_KEY', 'LEEKPAY_WEBHOOK_SECRET',
  'LEEKPAY_BASE_URL', 'LEEKPAY_PREMIUM_AMOUNT', 'LEEKPAY_PREMIUM_CURRENCY',
]);

const state = {
  normalized     : false,
  legacyApplied  : [],
};

/**
 * Masque une valeur sensible : jamais la valeur complète.
 * @param {string|undefined} value
 * @returns {string} ex: "SET (32 chars, sk_…)" | "MISSING"
 */
function maskSecret(value) {
  if (!value || typeof value !== 'string') return 'MISSING';
  const trimmed = value.trim();
  if (!trimmed) return 'MISSING';
  const prefix = trimmed.slice(0, 3).replace(/[^A-Za-z0-9]/g, '');
  return `SET (${trimmed.length} chars${prefix ? `, ${prefix}…` : ''})`;
}

/**
 * Contrôle la configuration SasPay. Les variables LEEKPAY_* sont
 * signalées mais volontairement jamais copiées vers SAASPAY_*.
 * @param {{ logger?: object }} [options]
 * @returns {{ applied: string[], missing: string[], legacyVars: string[] }}
 */
function normalizePaymentEnv(options = {}) {
  const logger = options.logger || null;
  if (!state.normalized) state.normalized = true;
  const missing = REQUIRED_VARS.filter(v => !(process.env[v] || '').trim());
  const legacyPresent = LEGACY_IGNORED.filter(name => !!(process.env[name] || '').trim());

  if (legacyPresent.length && logger && typeof logger.warn === 'function') {
    logger.warn('[PAYMENT_CONFIG] Variables LEEKPAY_* détectées mais ignorées pour SasPay.', {
      legacyPresent,
      hint: 'Configurer SAASPAY_SECRET_KEY avec la clé secrète SasPay sk_live_/sk_test_.',
    });
  }

  return { applied: [], missing, legacyVars: legacyPresent };
}

/**
 * État de configuration paiement — SANS aucune valeur secrète.
 * @returns {object}
 */
function getPaymentEnvStatus() {
  const required = {};
  for (const v of REQUIRED_VARS) {
    required[v] = maskSecret(process.env[v]);
  }

  const optional = {};
  for (const v of OPTIONAL_VARS) {
    optional[v] = maskSecret(process.env[v]);
  }

  const missingRequired = REQUIRED_VARS.filter(v => !(process.env[v] || '').trim());

  // Signale les anciennes vars sans jamais les adopter pour l'API SasPay.
  const legacyPresent = LEGACY_IGNORED
    .filter(name => !!(process.env[name] || '').trim());

  const legacyIgnoredPresent = LEGACY_IGNORED
    .filter(name => !!(process.env[name] || '').trim());

  return {
    provider      : 'SasPay',
    configured    : missingRequired.length === 0,
    required,
    optional,
    missingRequired,
    legacyPresent,
    legacyIgnoredPresent,
    legacyApplied : state.legacyApplied,
    baseUrl       : (process.env.SAASPAY_BASE_URL || 'https://api.saspay.me').replace(/\/$/, ''),
    premiumAmount : parseInt(process.env.SAASPAY_PREMIUM_AMOUNT, 10) || 2000,
    premiumCurrency: (process.env.SAASPAY_PREMIUM_CURRENCY || 'XOF').toUpperCase(),
    webhookPath   : '/api/payment/webhook/saaspay',
  };
}

module.exports = {
  normalizePaymentEnv,
  getPaymentEnvStatus,
  maskSecret,
  REQUIRED_VARS,
  OPTIONAL_VARS,
  LEGACY_FALLBACK,
  LEGACY_IGNORED,
};
