'use strict';
/**
 * OmniSMS — Validation des variables d'environnement au démarrage.
 *
 * Par défaut (STRICT_ENV absent/false) : WARN uniquement → aucun changement
 * de comportement au déploiement (le service démarre comme aujourd'hui).
 * STRICT_ENV=true : échec du démarrage si un requis manque (recommandé une
 * fois staging/production séparés en place).
 *
 * Modes :
 *   NODE_ENV=production + CREDITS_ENABLED=true → crédits variables requis.
 *   REDIS_REQUIRED=true                        → REDIS_URL requis (multi-instances).
 */

const REQUIRED_ALWAYS = ['JWT_SECRET', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'BACKEND_URL'];
const REQUIRED_PROD = ['ADMIN_KEY', 'CORS_ORIGIN'];
const REQUIRED_CREDITS = ['OM_SENDER_IDS', 'OM_GATEWAY_NUMBER', 'FREE_SMS_QUOTA'];

/**
 * Valide et retourne { ok, errors, warnings } — sans effet de bord.
 */
function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const isProd = (env.NODE_ENV || '').toLowerCase() === 'production';

  for (const key of REQUIRED_ALWAYS) {
    if (!String(env[key] || '').trim()) errors.push(`Variable requise manquante: ${key}`);
  }
  if (isProd) {
    for (const key of REQUIRED_PROD) {
      if (!String(env[key] || '').trim()) errors.push(`Variable requise en production: ${key}`);
    }
    if (String(env.JWT_SECRET || '').length < 32) {
      warnings.push('JWT_SECRET < 32 caractères (faible).');
    }
  }
  if (String(env.CREDITS_ENABLED || '').toLowerCase() === 'true') {
    for (const key of REQUIRED_CREDITS) {
      if (!String(env[key] || '').trim()) errors.push(`Crédits activés mais ${key} manquant`);
    }
  }
  if (String(env.REDIS_REQUIRED || '').toLowerCase() === 'true' && !String(env.REDIS_URL || '').trim()) {
    errors.push('REDIS_REQUIRED=true mais REDIS_URL absent — refus de démarrer en mono-état mémoire.');
  }
  if (!String(env.REDIS_URL || '').trim()) {
    warnings.push('REDIS_URL absent — présence/dédup/queues en mémoire (mono-instance uniquement).');
  }
  if (String(env.IN_APP_PURCHASE_UI || '').toLowerCase() === 'true') {
    warnings.push('IN_APP_PURCHASE_UI=true — vérifier la conformité Google Play Billing (docs/PAYMENTS_COMPLIANCE.md).');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Logue le résultat ; throw si STRICT_ENV=true et erreurs. */
function validateEnvOrThrow(logger) {
  const res = validateEnv();
  for (const w of res.warnings) logger.warn(`[ENV] ${w}`);
  for (const e of res.errors) logger.error(`[ENV] ${e}`);
  if (!res.ok) {
    if (String(process.env.STRICT_ENV || '').toLowerCase() === 'true') {
      throw new Error(`Variables d'environnement invalides (STRICT_ENV): ${res.errors.join('; ')}`);
    }
    logger.warn('[ENV] Démarrage poursuivi malgré des erreurs de configuration (STRICT_ENV non activé).');
  }
  return res;
}

module.exports = { validateEnv, validateEnvOrThrow };
