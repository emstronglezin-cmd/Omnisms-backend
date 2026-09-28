'use strict';
/**
 * OmniSMS — Normalisation de la configuration Paiement
 * ═══════════════════════════════════════════════════════════════
 *
 * Le code de paiement (services/saaspay.js) lit EXCLUSIVEMENT les
 * variables d'environnement SAASPAY_*.
 *
 * Problème constaté : render.yaml et .env.example déclaraient encore
 * les anciennes variables LEEKPAY_* → en production, SAASPAY_SECRET_KEY
 * et SAASPAY_API_KEY étaient absents, le service répondait 503
 * SAASPAY_NOT_CONFIGURED alors que l'infrastructure était "configurée".
 *
 * Ce module fait donc UNIQUEMENT deux choses :
 *   1. Recopier les anciennes variables LEEKPAY_* vers les variables
 *      SAASPAY_* réellement lues par le code (compatibilité ascendante,
 *      le temps de la migration des variables Render).
 *   2. Exposer un état de configuration MASQUÉ (jamais de secret en clair)
 *      pour les logs de démarrage et les diagnostics.
 *
 * ⚠️ LEEKPAY_BASE_URL n'est JAMAIS recopiée : l'API réellement utilisée
 *    est https://saaspay.me (défaut de services/saaspay.js).
 *
 * Aucun secret n'est jamais retournée ni journalisée en clair par ce module.
 */

/* Anciennes variables (legacy) → variables réellement lues par le code */
const LEGACY_FALLBACK = Object.freeze({
  SAASPAY_API_KEY        : 'LEEKPAY_API_KEY',
  SAASPAY_SECRET_KEY     : 'LEEKPAY_SECRET_KEY',
  SAASPAY_WEBHOOK_SECRET : 'LEEKPAY_WEBHOOK_SECRET',
  SAASPAY_PREMIUM_AMOUNT : 'LEEKPAY_PREMIUM_AMOUNT',
  SAASPAY_PREMIUM_CURRENCY: 'LEEKPAY_PREMIUM_CURRENCY',
});

/* Variables requises par services/saaspay.js */
const REQUIRED_VARS = Object.freeze(['SAASPAY_SECRET_KEY', 'SAASPAY_API_KEY']);

/* Variables optionnelles (valeurs par défaut dans le code) */
const OPTIONAL_VARS = Object.freeze([
  'SAASPAY_BASE_URL',
  'SAASPAY_WEBHOOK_SECRET',
  'SAASPAY_PREMIUM_AMOUNT',
  'SAASPAY_PREMIUM_CURRENCY',
  'BACKEND_URL',
  'FRONTEND_URL',
]);

/* Variables legacy qui ne sont volontairement PAS recopiées */
const LEGACY_IGNORED = Object.freeze(['LEEKPAY_BASE_URL']);

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

function setIfPresent(name) {
  const current = (process.env[name] || '').trim();
  if (current) return false;
  const legacyName = LEGACY_FALLBACK[name];
  if (!legacyName) return false;
  const legacyValue = (process.env[legacyName] || '').trim();
  if (!legacyValue) return false;
  process.env[name] = legacyValue;
  return true;
}

/**
 * Recopie les anciennes variables LEEKPAY_* vers SAASPAY_* manquantes.
 * Idempotent : peut être appelé plusieurs fois sans effet de bord.
 * @param {{ logger?: object }} [options]
 * @returns {{ applied: string[], missing: string[], legacyVars: string[] }}
 */
function normalizePaymentEnv(options = {}) {
  const logger = options.logger || null;
  const applied = [];

  for (const name of Object.keys(LEGACY_FALLBACK)) {
    if (setIfPresent(name)) {
      applied.push(`${LEGACY_FALLBACK[name]} → ${name}`);
    }
  }

  if (!state.normalized) {
    state.normalized = true;
    state.legacyApplied = [...applied];
  }

  const missing = REQUIRED_VARS.filter(v => !(process.env[v] || '').trim());

  if (applied.length && logger && typeof logger.warn === 'function') {
    logger.warn('[PAYMENT_CONFIG] Anciennes variables détectées — recopiées vers les variables SAASPAY_* lues par le code. ' +
      'Renommez-les dans Render (Settings → Environment).', {
      mappingApplied: applied,
      hint           : 'Variables attendues par le code : SAASPAY_SECRET_KEY + SAASPAY_API_KEY',
    });
  }

  return { applied, missing, legacyVars: applied };
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

  const legacyPresent = Object.values(LEGACY_FALLBACK)
    .filter(name => !!(process.env[name] || '').trim());

  const legacyIgnoredPresent = LEGACY_IGNORED
    .filter(name => !!(process.env[name] || '').trim());

  return {
    provider      : 'SaaSPay',
    configured    : missingRequired.length === 0,
    required,
    optional,
    missingRequired,
    legacyPresent,
    legacyIgnoredPresent,
    legacyApplied : state.legacyApplied,
    baseUrl       : (process.env.SAASPAY_BASE_URL || 'https://saaspay.me').replace(/\/$/, ''),
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
