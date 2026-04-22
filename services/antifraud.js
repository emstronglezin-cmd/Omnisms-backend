'use strict';
/**
 * OmniSMS — Système Anti-Fraude
 *
 * Protections :
 *  - Rate limit par IP  (en mémoire — adapté pour les vérifications rapides)
 *  - Cooldown par téléphone (en mémoire — adapté pour les vérifications rapides)
 *  - Logs persistés dans Firestore (collection "payment_logs")
 *
 * Note : les Maps en mémoire se réinitialisent au redémarrage,
 * ce qui est acceptable pour un rate-limit léger. Les logs
 * d'audit sont eux persistés sur Firestore.
 */

const db = require('../config/firebase');
const { logger } = require('../middleware/logger');

// ─────────────────────────────────────────────────────────────
// Maps en mémoire pour les vérifications rapides
// ─────────────────────────────────────────────────────────────
const ipRateMap   = new Map(); // ip    → { count, firstAt, lastAt }
const phoneRateMap = new Map(); // phone → lastConfirmAt (ms)

const RATE_WINDOW_MS  = 30 * 1000;  // 30 secondes
const MAX_ATTEMPTS_IP = 3;          // max 3 tentatives par IP
const COOLDOWN_MS     = 30 * 1000;  // cooldown 30s entre deux confirm

// ─────────────────────────────────────────────────────────────
// Vérifier le rate limit par IP
// ─────────────────────────────────────────────────────────────

/**
 * @param {string} ip
 * @returns {boolean} true = autorisé, false = bloqué
 */
function checkIpRateLimit(ip) {
  const now   = Date.now();
  const entry = ipRateMap.get(ip);

  if (!entry) {
    ipRateMap.set(ip, { count: 1, firstAt: now, lastAt: now });
    return true;
  }

  if (now - entry.firstAt > RATE_WINDOW_MS) {
    ipRateMap.set(ip, { count: 1, firstAt: now, lastAt: now });
    return true;
  }

  if (entry.count >= MAX_ATTEMPTS_IP) return false;

  entry.count++;
  entry.lastAt = now;
  return true;
}

// ─────────────────────────────────────────────────────────────
// Vérifier le cooldown par téléphone
// ─────────────────────────────────────────────────────────────

/**
 * @param {string} phone
 * @returns {boolean} true = autorisé, false = trop tôt
 */
function checkPhoneCooldown(phone) {
  const now    = Date.now();
  const lastAt = phoneRateMap.get(phone);

  if (!lastAt) {
    phoneRateMap.set(phone, now);
    return true;
  }

  if (now - lastAt < COOLDOWN_MS) return false;

  phoneRateMap.set(phone, now);
  return true;
}

/** Mettre à jour le timestamp de confirmation pour un phone */
function markPhoneConfirmed(phone) {
  phoneRateMap.set(phone, Date.now());
}

// ─────────────────────────────────────────────────────────────
// Loguer une tentative de paiement (persisté sur Firestore)
// ─────────────────────────────────────────────────────────────

/**
 * Enregistrer une tentative de paiement sur Firestore.
 * Asynchrone non bloquant — ne doit jamais faire échouer le flux principal.
 */
function logPaymentAttempt({ phone, ip, action, status, details = '' }) {
  const entry = {
    phone,
    ip,
    action,
    status,
    details,
    timestamp: new Date().toISOString(),
  };

  // Persister sur Firestore (fire-and-forget)
  db.collection('payment_logs').add(entry).catch(err => {
    logger.warn('Erreur écriture payment_log Firestore', { error: err.message });
  });

  // Log console structuré
  const icon = status === 'success' ? '✅' : status === 'blocked' ? '🚫' : '⚠️';
  logger.info(`${icon} [PAYMENT] ${action}`, { phone, ip, status, details });
}

// ─────────────────────────────────────────────────────────────
// Nettoyage périodique des Maps en mémoire
// ─────────────────────────────────────────────────────────────

function cleanupRateMaps() {
  const now = Date.now();

  for (const [ip, entry] of ipRateMap.entries()) {
    if (now - entry.firstAt > RATE_WINDOW_MS * 2) ipRateMap.delete(ip);
  }

  for (const [phone, lastAt] of phoneRateMap.entries()) {
    if (now - lastAt > COOLDOWN_MS * 10) phoneRateMap.delete(phone);
  }
}

// Nettoyage toutes les 5 minutes
setInterval(cleanupRateMaps, 5 * 60 * 1000).unref();

module.exports = {
  checkIpRateLimit,
  checkPhoneCooldown,
  markPhoneConfirmed,
  logPaymentAttempt,
};
