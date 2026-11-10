'use strict';
/**
 * OmniSMS — Secours SMS CONSENTI pour destinataires OmniSMS hors ligne (V3.1).
 *
 * Cascade de routage intelligent (destinataire OmniSMS non connecté) :
 *   1. message enregistré dans la conversation (fait par le routeur) ;
 *   2. notification push distante si un token valide existe (fait par le routeur) ;
 *   3. SMS de secours via le transport actif (SMSGate) — UNIQUEMENT si TOUT :
 *        - SMS_FALLBACK_ENABLED !== 'false'   (interrupteur global d'urgence)
 *        - destinataire.smsFallbackEnabled === true  (OPT-IN explicite du
 *          destinataire — le consentement est LE garde-fou principal)
 *        - destinataire.phoneVerified === true (strict ; les comptes sans le
 *          champ ne sont PAS éligibles — pas de SMS vers un numéro non vérifié)
 *        - destinataire.phone valide E.164 (jamais déduit de l'UID)
 *        - un transport SMS est disponible.
 *   4. sinon → message conservé + motif CLAIR du non-secours (rapporté).
 *
 * Anti-doublon : le statut est écrit dans le message (messages/{id}.smsFallback)
 * AVANT vérification de re-dispatch → un même message ne part jamais 2 fois.
 * Livraison : le SMS part de la SIM du TÉLÉPHONE PASSERELLE (ex. Samsung Z
 * Fold2), pas de la SIM personnelle de l'expéditeur — d'où l'expéditeur nommé
 * dans le texte. Texte borné à 160 caractères (1 segment).
 * Aucun secret/numéro complet dans les logs.
 */

const { logger } = require('../middleware/logger');

function getDb() {
  try { return require('../config/firebase'); } catch (_) { return null; }
}
function maskPhone(p) { return p ? String(p).replace(/\d{4}$/, '****') : null; }
function nowIso() { return new Date().toISOString(); }

/** Texte du secours : identifie l'expéditeur (le SMS part du numéro passerelle). */
function buildText(senderName, content) {
  const prefix = `OmniSMS — ${senderName || 'Message'} : `;
  const room = Math.max(0, 160 - prefix.length);
  const body = String(content || '').replace(/\s+/g, ' ').trim().slice(0, room);
  return (prefix + body).slice(0, 160);
}

/**
 * Évalue la politique et envoie le secours si (et seulement si) autorisé.
 * @returns {Promise<{status:'sent'|'skipped', reason:string, to?:string, provider?:string, gatewayMessageId?:string}>}
 */
async function evaluateAndDispatch({ recipientUid, messageId, content, senderName, dedupKey }) {
  const skip = (reason) => ({ status: 'skipped', reason });

  if (String(process.env.SMS_FALLBACK_ENABLED ?? 'true').trim().toLowerCase() === 'false') return skip('disabled_globally');
  const db = getDb();
  if (!db || !recipientUid || !messageId) return skip('missing_context');

  // Anti-doublon NIVEAU MESSAGE : le doc a déjà un statut de secours.
  try {
    const existing = await db.collection('messages').doc(String(messageId)).get();
    if (existing && existing.exists && (existing.data() || {}).smsFallback && (existing.data().smsFallback || {}).status) {
      return skip('already_handled');
    }
  } catch (_) { /* lecture non bloquante */ }
  // Anti-doublon NIVEAU MESSAGE LOGIQUE : une re-route du même message
  // (même id pré-généré OU même id Firestore visible par le client) ne doit
  // JAMAIS repartir en SMS. Deux marqueurs possibles → les deux sont vérifiés.
  const dKey = String(dedupKey || '').trim();
  const keysToCheck = [...new Set([dKey, String(messageId)].filter(Boolean))];
  try {
    for (const k of keysToCheck) {
      const marker = await db.collection('sms_fallback_dedup').doc(k).get();
      if (marker && marker.exists) return skip('already_handled');
    }
  } catch (_) {}

  // Préférences & éligibilité du DESTINATAIRE (jamais depuis l'UID → téléphone).
  let user = null;
  try {
    const snap = await db.collection('users').doc(String(recipientUid)).get();
    user = snap && snap.exists ? snap.data() : null;
  } catch (_) { user = null; }
  if (!user) return skip('recipient_not_found');
  if (user.smsFallbackEnabled !== true) return skip('no_recipient_consent');
  if (user.phoneVerified !== true) return skip('phone_unverified');
  const phone = String(user.phone || '').trim();
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) return skip('no_valid_phone');

  // Transport actif (SMSGate si configuré, sinon celui sélectionné).
  let providerStatus = null;
  try { providerStatus = require('./smsProvider').getProviderStatus(); } catch (_) {}
  if (!providerStatus || providerStatus.activeProvider === 'none') return skip('no_sms_provider');

  const text = buildText(senderName, content);
  let result;
  try {
    result = await require('./smsProvider').sendSMS(phone, text);
  } catch (err) {
    logger.warn('[SmsFallback] envoi échoué', { error: err.message, to: maskPhone(phone) });
    result = { success: false, error: err.message };
  }

  const status = result && result.success ? 'sent' : 'failed';
  const out = {
    status,
    reason: status === 'sent' ? 'fallback_sent' : 'send_failed',
    to: maskPhone(phone),
    provider: (result && result.provider) || (providerStatus && providerStatus.activeProvider) || 'unknown',
    ...(result && result.result && result.result.gatewayMessageId ? { gatewayMessageId: result.result.gatewayMessageId } : {}),
    ...(status === 'failed' ? { error: String(result.error || 'unknown').slice(0, 120) } : {}),
  };

  // Persistance du statut (traçabilité + anti-doublon pour les éventuels re-routages).
  try {
    await db.collection('messages').doc(String(messageId)).set({
      smsFallback: { ...out, contentPreview: text.slice(0, 40), updatedAt: nowIso() },
    }, { merge: true });
    // Marqueurs posés UNIQUEMENT après un envoi réussi : un échec laisse la
    // porte à une reprise volontaire, un succès la ferme à jamais (les deux ids).
    if (status === 'sent') {
      for (const k of keysToCheck) {
        await db.collection('sms_fallback_dedup').doc(k).set({ messageId: String(messageId), at: nowIso() }, { merge: true });
      }
    }
  } catch (_) {}

  if (status === 'sent') {
    logger.info('[SmsFallback] secours SMS consenti envoyé', { messageId, to: out.to, provider: out.provider, gatewayMessageId: out.gatewayMessageId || null });
  } else {
    logger.warn('[SmsFallback] secours SMS non délivré', { messageId, reason: out.reason, error: out.error || null });
  }
  return out;
}

module.exports = { evaluateAndDispatch, _internals: { buildText } };
