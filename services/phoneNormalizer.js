'use strict';
/**
 * OmniSMS — Service Normalisation Numéros de Téléphone
 *
 * Utilise la librairie `phone` (npm) pour la normalisation E.164 robuste.
 * Supporte tous les formats internationaux.
 *
 * Fallback : normalisation simple si `phone` échoue.
 *
 * Usage :
 *   const { normalizePhone, normalizePhoneBatch, isValidPhone } = require('./phoneNormalizer');
 *   normalizePhone('+226 70 00 00 00')  → '+22670000000'
 *   normalizePhone('70000000', 'BF')    → '+22670000000'
 */

let phonePkg;
try {
  phonePkg = require('phone');
} catch (_) {
  phonePkg = null;
}

/* ── Codes pays par défaut ────────────────────────────────── */
const DEFAULT_COUNTRY = process.env.DEFAULT_PHONE_COUNTRY || 'BF'; // Burkina Faso

/* ── Normalisation simple (fallback) ─────────────────────── */
function simpleNormalize(phone) {
  if (!phone) return '';
  let p = String(phone).replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) p = '+226' + p;
  return p;
}

/* ── Normalisation principale ─────────────────────────────── */
/**
 * Normalise un numéro de téléphone au format E.164.
 *
 * @param {string} phone      - Numéro brut (n'importe quel format)
 * @param {string} [country]  - Code pays ISO 3166-1 alpha-2 (ex: 'FR', 'SN', 'BF')
 * @returns {string}          - Numéro E.164 ou '' si invalide
 */
function normalizePhone(phone, country) {
  if (!phone) return '';
  const input = String(phone).trim();
  const cc    = (country || DEFAULT_COUNTRY).toUpperCase();

  if (phonePkg) {
    // phone@4+ utilise une fonction nommée `phone`
    const fn = phonePkg.phone || phonePkg.default || phonePkg;
    try {
      const result = fn(input, { country: cc });
      if (result && result.isValid && result.phoneNumber) {
        return result.phoneNumber;
      }

      // Essayer sans spécifier le pays (numéros déjà au format international)
      const resultNoCC = fn(input, {});
      if (resultNoCC && resultNoCC.isValid && resultNoCC.phoneNumber) {
        return resultNoCC.phoneNumber;
      }
    } catch (_) {
      // Fallback si phone() lève une exception
    }
  }

  // Fallback normalisation simple
  return simpleNormalize(input);
}

/**
 * Vérifie si un numéro est valide.
 * @returns {boolean}
 */
function isValidPhone(phone, country) {
  const normalized = normalizePhone(phone, country);
  // Un numéro E.164 commence par + suivi de 7 à 15 chiffres
  return /^\+[1-9]\d{6,14}$/.test(normalized);
}

/**
 * Normalise un tableau de numéros (retourne seulement les valides).
 *
 * @param {Array<string|object>} phones - Tableau de numéros ou objets {phone, name}
 * @param {string} [country]
 * @returns {Array<{original, normalized, valid, name}>}
 */
function normalizePhoneBatch(phones, country) {
  return phones.map(item => {
    const raw  = typeof item === 'object' ? (item.phone || item.number || '') : String(item);
    const name = typeof item === 'object' ? (item.name || '') : '';
    const normalized = normalizePhone(raw, country);
    const valid = /^\+[1-9]\d{6,14}$/.test(normalized);
    return { original: raw, normalized, valid, name };
  });
}

/**
 * Extrait le code pays d'un numéro E.164.
 * Ex: '+22670000000' → 'BF', '+33612345678' → 'FR'
 * Retourne null si non reconnu.
 */
function getCountryFromPhone(phone) {
  if (!phonePkg) return null;
  const fn = phonePkg.phone || phonePkg.default || phonePkg;
  try {
    const result = fn(phone, {});
    return result && result.isValid ? (result.countryIso2 || null) : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  normalizePhone,
  normalizePhoneBatch,
  isValidPhone,
  getCountryFromPhone,
  simpleNormalize,
};
