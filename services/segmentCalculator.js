'use strict';
/**
 * OmniSMS — Calcul de segments SMS (coût opérateur)
 *
 * 1 crédit = 1 segment. Encodages :
 *   - GSM-7 : 160 caractères en 1 segment, 153 par segment en multiparte
 *     (certains caractères « extension » comptent pour 2 unités) ;
 *   - UCS-2 : 70 caractères en 1 segment, 67 par segment en multiparte
 *     (dès qu'un caractère hors GSM-7 est présent — accents exotiques, emoji…).
 *
 * Le calcul se fait sur le texte EXACT envoyé au fournisseur (préfixe
 * « [OmniSMS] Nom : contenu » inclus).
 */

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_BASIC_SET = new Set(GSM7_BASIC.split(''));
const GSM7_EXT_SET = new Set('^{}\\[~]|€'.split(''));

/**
 * Nombre d'unités GSM-7 réellement consommées par le texte.
 * (un caractère « extension » comme ^ { } \ [ ~ ] | € vaut 2 unités)
 */
function gsm7Units(text) {
  let units = 0;
  for (const ch of String(text)) {
    if (GSM7_BASIC_SET.has(ch)) units += 1;
    else if (GSM7_EXT_SET.has(ch)) units += 2;
    else return null; // caractère hors GSM-7 → le texte partira en UCS-2
  }
  return units;
}

/**
 * Analyse un texte SMS et retourne l'encodage, le nombre d'unités et le
 * nombre de segments (1 segment = 1 crédit).
 * @param {string} text
 * @returns {{ encoding:'GSM7'|'UCS2', units:number, segments:number }}
 */
function analyzeSms(text) {
  const str = String(text == null ? '' : text);
  const units = gsm7Units(str);
  if (units !== null) {
    const segments = units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153);
    return { encoding: 'GSM7', units, segments };
  }
  const ucs2Units = [...str].length;
  const segments = ucs2Units === 0 ? 0 : ucs2Units <= 70 ? 1 : Math.ceil(ucs2Units / 67);
  return { encoding: 'UCS2', units: ucs2Units, segments };
}

/** Raccourci : nombre de segments (coût en crédits) d'un texte SMS. */
function countSegments(text) {
  return analyzeSms(text).segments;
}

/** Vérifie qu'une réponse tient dans 1 segment GSM-7 (les réponses système nous coûtent un SMS). */
function fitsOneGsm7Segment(text) {
  const a = analyzeSms(text);
  return a.encoding === 'GSM7' && a.segments <= 1;
}

module.exports = { analyzeSms, countSegments, fitsOneGsm7Segment, gsm7Units };
