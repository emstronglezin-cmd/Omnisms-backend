'use strict';
/**
 * OmniSMS — Parseur des confirmations Orange Money (SMS reçus sur la passerelle).
 *
 * Sécurité :
 *   - SEULS les expéditeurs de la liste blanche OM_SENDER_IDS (IDs courts /
 *     alphanumériques du service Orange Money) sont acceptés ;
 *   - tout expéditeur ressemblant à un numéro de téléphone ordinaire est
 *     rejeté (impossible de falsifier un paiement depuis un simple numéro) ;
 *   - en cas de doute de format → { ok:false } : le paiement ne sera JAMAIS
 *     crédité automatiquement (statut review côté rechargeService).
 *
 * ⚠️ Les motifs d'extraction sont des DÉFAUTS plausibles : ils seront
 * ajustés avec de vrais SMS Orange Money (voir test/fixtures/om-sms.json,
 * fixtures marquées « À REMPLACER »). Surcharge possible via env :
 *   OM_REGEX_AMOUNT, OM_REGEX_TXN, OM_REGEX_PAYER (expressions régulières).
 */

const { getOmSenderIds } = require('./packsConfig');

function envRegex(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  try { return new RegExp(raw, 'i'); } catch (_) { return fallback; }
}

const RE_AMOUNT = () => envRegex('OM_REGEX_AMOUNT', /(\d[\d\s]{1,9})\s*(?:f|fcfa|f\s?cfa)\b/i);
const RE_TXN = () => envRegex('OM_REGEX_TXN', /(?:id|trans(?:action)?|ref)(?:\s+(?:no\.?|n°?|num\w*|transaction))?\s*[:.\-]?\s*([A-Za-z0-9][A-Za-z0-9._-]{5,39})/gi);
const RE_PAYER = () => envRegex('OM_REGEX_PAYER', /(\+?226[\s-]?\d{2}(?:[\s-]?\d{2}){3})/);

/** Un expéditeur « numéro de téléphone ordinaire » est toujours rejeté. */
function looksLikeOrdinaryPhone(senderId) {
  return /^\+?\d[\d\s.-]{7,19}$/.test(String(senderId || '').trim());
}

/**
 * Tente d'analyser un SMS entrant comme une confirmation Orange Money.
 * @param {object} p { senderId, body, receivedAt }
 * @returns {{ ok:true, txnId, amountFcfa, payerPhone, omDate, senderId }
 *          | { ok:false, reason:'NOT_WHITELISTED'|'PHONE_LIKE_SENDER'|'PARSE_FAILED', senderId }}
 */
function parseOmConfirmation({ senderId, body, receivedAt }) {
  const sid = String(senderId || '').trim();
  const sidNorm = sid.toUpperCase().replace(/\s+/g, ' ');

  if (!sid) return { ok: false, reason: 'NOT_WHITELISTED', senderId: null };
  if (looksLikeOrdinaryPhone(sid)) return { ok: false, reason: 'PHONE_LIKE_SENDER', senderId: sid };
  if (!getOmSenderIds().includes(sidNorm)) return { ok: false, reason: 'NOT_WHITELISTED', senderId: sid };

  const text = String(body || '');
  const amountMatch = text.match(RE_AMOUNT());
  // Premier candidat valide : l'ID contient au moins un chiffre, fait >=8 chars
  // et n'est pas un mot-clé (« transaction », « ref »…) attrapé par le motif.
  let txnId = null;
  for (const m of text.matchAll(RE_TXN())) {
    const cand = String(m[1] || '').trim().replace(/[._-]+$/, ''); // retire ponctuation de fin de phrase
    if (cand && /\d/.test(cand) && cand.length >= 8 && !/^(transaction|trans|ref|id)$/i.test(cand)) { txnId = cand; break; }
  }
  const payerMatch = text.match(RE_PAYER());

  if (!amountMatch || !txnId) return { ok: false, reason: 'PARSE_FAILED', senderId: sid };

  const amountFcfa = parseInt(amountMatch[1].replace(/[\s.]/g, ''), 10);
  if (!Number.isFinite(amountFcfa) || amountFcfa <= 0) {
    return { ok: false, reason: 'PARSE_FAILED', senderId: sid };
  }

  let payerPhone = null;
  if (payerMatch) {
    payerPhone = '+' + payerMatch[1].replace(/\D/g, '');
  }

  return {
    ok: true,
    txnId,
    amountFcfa,
    payerPhone,
    omDate: receivedAt || null,
    senderId: sidNorm,
  };
}

/** Le texte ressemble-t-il à une commande de crédit OmniSMS ? (inspection rapide) */
function isCreditsCommand(text) {
  const t = String(text || '').trim().toUpperCase().replace(/\s+/g, ' ');
  return /^(SOLDE|PACKS|RECHARGE( \d+)?|PAYE [A-Za-z0-9._-]+|AIDE)$/.test(t);
}

module.exports = { parseOmConfirmation, looksLikeOrdinaryPhone, isCreditsCommand };
