'use strict';
/**
 * OmniSMS — Secours SMS CONSENTI pour destinataires OmniSMS hors ligne (V3.1).
 *
 * Cascade de routage intelligent (destinataire OmniSMS non connecté) :
 *   1. message enregistré dans la conversation (fait par le routeur) ;
 *   2. notification push distante si un token valide existe (fait par le routeur) ;
 *   3. SMS de secours via le transport actif (SMSGate) — UNIQUEMENT si TOUT :
 *        - SMS_FALLBACK_ENABLED !== 'false'   (interrupteur global d'urgence)
 *        - destinataire.smsFallbackEnabled !== false (AUTO par défaut depuis
 *          V3.2 — décision produit « joindre même sans Internet » ; le
 *          destinataire garde le contrôle avec smsFallbackEnabled=false)
 *        - destinataire.phoneVerified === true (strict — pas de SMS vers un
 *          numéro non vérifié)
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

/** Texte d'un VOCAL transcrit (même format que le chemin SMS externe SESSION 13). */
function buildAudioText(senderName, transcription) {
  const who = senderName || 'Un utilisateur OmniSMS';
  const prefix = `[OmniSMS Vocal] ${who} : `;
  const room = Math.max(0, 160 - prefix.length);
  const body = String(transcription || '').replace(/\s+/g, ' ').trim().slice(0, room);
  return (prefix + body).slice(0, 160);
}

/**
 * Évalue la politique et envoie le secours si (et seulement si) autorisé.
 * @returns {Promise<{status:'sent'|'skipped', reason:string, to?:string, provider?:string, gatewayMessageId?:string}>}
 */
/**
 * Éligibilité du destinataire au secours (partagée texte/vocal).
 * @returns {{eligible:boolean, reason?:string, phone?:string, user?:object}}
 */
async function checkEligibility(recipientUid) {
  if (String(process.env.SMS_FALLBACK_ENABLED ?? 'true').trim().toLowerCase() === 'false') return { eligible: false, reason: 'disabled_globally' };
  const db = getDb();
  if (!db || !recipientUid) return { eligible: false, reason: 'missing_context' };
  // Résolution CENTRALE (services/userResolver.js) : source de vérité unique
  // Firestore users/{uid} — priorité phone → phoneNumber, E.164, vérification
  // selon le mécanisme existant (true / phoneVerifiedAt / legacy actif) ;
  // un false explicite (OTP en attente) bloque TOUJOURS. Un seul document lu.
  const res = await require('./userResolver').resolveVerifiedPhoneByUid(recipientUid);
  if (!res.found) {
    const reasonMap = { user_not_found: 'recipient_not_found', no_phone: 'no_valid_phone', invalid_phone: 'no_valid_phone', phone_unverified: 'phone_unverified' };
    return { eligible: false, reason: reasonMap[res.reason] || 'recipient_not_found' };
  }
  const user = res.user || {};
  if (user.smsFallbackEnabled === false) return { eligible: false, reason: 'recipient_opted_out' };
  logger.info('[ROUTING] Verified phone resolved', { recipientUid: String(recipientUid).slice(0, 10), to: maskPhone(res.phone), basis: res.basis, source: res.source });
  return { eligible: true, phone: res.phone, user };
}

/** Le transport SMS actif est-il disponible ? */
function transportAvailable() {
  try { const st = require('./smsProvider').getProviderStatus(); return st && st.activeProvider !== 'none'; } catch (_) { return false; }
}

/** Envoi SMS de secours + traçabilité + marqueurs anti-doublon. */
async function dispatchFallbackSms({ phone, text, recipientUid, messageId, dedupKey, kind }) {
  const db = getDb();
  let result;
  try {
    result = await require('./smsProvider').sendSMS(phone, text, { messageId: (String(messageId || dedupKey || '') || null) });
  } catch (err) {
    logger.warn('[SmsFallback] envoi échoué', { error: err.message, to: maskPhone(phone) });
    result = { success: false, error: err.message };
  }
  const status = result && result.success ? 'sent' : 'failed';
  const out = {
    status,
    reason: status === 'sent' ? 'fallback_sent' : 'send_failed',
    to: maskPhone(phone),
    provider: (result && result.provider) || 'unknown',
    kind: kind || 'text',
    ...(result && result.result && result.result.gatewayMessageId ? { gatewayMessageId: result.result.gatewayMessageId } : {}),
    ...(status === 'failed' ? { error: String(result.error || 'unknown').slice(0, 120) } : {}),
  };
  try {
    if (db) {
      await db.collection('messages').doc(String(messageId)).set({
        smsFallback: { ...out, contentPreview: text.slice(0, 40), updatedAt: nowIso() },
      }, { merge: true });
      if (status === 'sent') {
        for (const k of [...new Set([String(dedupKey || ''), String(messageId)].filter(Boolean))]) {
          await db.collection('sms_fallback_dedup').doc(k).set({ messageId: String(messageId), at: nowIso() }, { merge: true });
        }
      }
    }
  } catch (_) {}
  if (status === 'sent') logger.info('[SmsFallback] secours SMS envoyé', { messageId, to: out.to, provider: out.provider, kind: out.kind, gatewayMessageId: out.gatewayMessageId || null });
  else logger.warn('[SmsFallback] secours SMS non délivré', { messageId, reason: out.reason, error: out.error || null, kind: out.kind });
  return out;
}

async function evaluateAndDispatch({ recipientUid, messageId, content, senderName, dedupKey }) {
  const skip = (reason) => {
    // Motif EXPLICITE dans les logs (avant : skip silencieux → diagnostic impossible).
    logger.warn('[SMS_FALLBACK] Secours SMS non envoyé — motif', { messageId, reason, kind: 'text' });
    return { status: 'skipped', reason };
  };

  if (String(process.env.SMS_FALLBACK_ENABLED ?? 'true').trim().toLowerCase() === 'false') return skip('disabled_globally');
  const db = getDb();
  if (!db || !recipientUid || !messageId) return skip('missing_context');

  // Anti-doublon NIVEAU MESSAGE : le doc a déjà un statut de secours.
  try {
    const existing = await db.collection('messages').doc(String(messageId)).get();
    if (existing && existing.exists) {
      const prevFb = (existing.data() || {}).smsFallback || {};
      // Seul un SUCCÈS bloque la re-route. Un ÉCHEC (gateway indisponible, etc.)
      // reste RETENTABLE sans doublon possible : les marqueurs `sms_fallback_dedup`
      // ne sont posés qu'après un succès confirmé.
      if (prevFb.status === 'sent') return skip('already_handled');
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

  // Éligibilité (politique partagée texte/vocal) + transport.
  const elig = await checkEligibility(recipientUid);
  if (!elig.eligible) return skip(elig.reason);
  if (!transportAvailable()) return skip('no_sms_provider');

  return dispatchFallbackSms({ phone: elig.phone, text: buildText(senderName, content), recipientUid, messageId, dedupKey, kind: 'text' });
}

/* ═══ VOCAL → destinataire OmniSMS hors ligne : transcription PUIS SMS texte ═══ */

/** Résout audioUrl local (chemin/URL relative) → chemin fichier. */
function resolveAudioPath(audioUrl) {
  const path = require('path');
  if (!audioUrl || /^https?:\/\//i.test(audioUrl)) return null;
  return audioUrl.startsWith('/') ? audioUrl : path.join(__dirname, '..', audioUrl);
}
/** Télécharge une URL audio vers un fichier temporaire (jamais supprimé ici : nettoyage par l'OS). */
async function downloadAudioPath(audioUrl) {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const ext = (String(audioUrl).split('.').pop() || 'ogg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'ogg';
  const tmp = path.join(os.tmpdir(), `omnisms-audio-fb-${Date.now()}.${ext}`);
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp);
    require('https').get(audioUrl, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(err); });
  });
  return tmp;
}

/**
 * CAS B vocal : arme « transcription puis SMS » pour un destinataire OmniSMS
 * hors ligne. Politique vérifiée AVANT la dépense de transcription. La
 * transcription réutilise le pipeline existant (transcriptionWorker) ; la
 * reprise se fait via resumeAfterTranscription(). JAMAIS de SMS vide.
 * @returns {{status:'armed'|'skipped', reason?:string}}
 */
async function armAudioFallback({ recipientUid, messageId, audioUrl, senderName, dedupKey }) {
  const db = getDb();
  const skipA = (reason, extra) => {
    logger.warn('[SMS_FALLBACK] vocal non armé — motif', { messageId, reason, ...(extra || {}) });
    return { status: 'skipped', reason };
  };
  if (!db || !recipientUid || !messageId) return skipA('missing_context');
  const elig = await checkEligibility(recipientUid);
  if (!elig.eligible) return skipA(elig.reason);
  if (!transportAvailable()) return skipA('no_sms_provider');
  if (!audioUrl) return skipA('no_audio');
  try {
    let audioPath = resolveAudioPath(audioUrl);
    if (!audioPath && /^https?:\/\//i.test(audioUrl)) audioPath = await downloadAudioPath(audioUrl);
    if (!audioPath || !require('fs').existsSync(audioPath)) {
      await db.collection('messages').doc(String(messageId)).set({ smsAfterTranscription: 'skipped_no_audio_file', audioSmsError: 'Fichier audio introuvable', updatedAt: nowIso() }, { merge: true }).catch(() => {});
      return { status: 'skipped', reason: 'no_audio_file' };
    }
    await db.collection('messages').doc(String(messageId)).set({
      smsAfterTranscription: 'pending',
      audioFallbackArmedAt: nowIso(),
    }, { merge: true });
    const { addTranscriptionJob } = require('./queueService');
    await addTranscriptionJob({ audioPath, messageId, userId: recipientUid, language: 'fr', collection: 'messages' });
    logger.info('[SmsFallback] vocal hors ligne → transcription armée (SMS texte à suivre)', { messageId, to: maskPhone(elig.phone) });
    return { status: 'armed' };
  } catch (err) {
    logger.warn('[SmsFallback] armement vocal échoué', { error: err.message });
    return { status: 'skipped', reason: 'arm_failed', error: err.message };
  }
}

/**
 * Reprise APRÈS transcription (appelée par transcriptionWorker, jamais bloquante) :
 * vérifie la politique, envoie le TEXTE via le transport actif, trace tout.
 * Transcription vide/échouée → AUCUN SMS, erreur enregistrée, message conservé.
 */
async function resumeAfterTranscription({ messageId, transcription } = {}) {
  try {
    const db = getDb();
    if (!db || !messageId) return { action: 'skipped', reason: 'missing_context' };
    const snap = await db.collection('messages').doc(String(messageId)).get();
    const msg = snap && snap.exists ? snap.data() : null;
    if (!msg || msg.smsAfterTranscription !== 'pending') return { action: 'skipped', reason: 'not_armed' };
    if (msg.smsFallback && msg.smsFallback.status) return { action: 'skipped', reason: 'already_handled' };
    const text = typeof transcription === 'string' ? transcription.trim() : '';
    if (!text) {
      await db.collection('messages').doc(String(messageId)).set({
        smsAfterTranscription: 'skipped_empty_transcription',
        audioSmsError: 'Transcription vide — aucun SMS envoyé.',
        updatedAt: nowIso(),
      }, { merge: true }).catch(() => {});
      logger.warn('[SmsFallback] transcription vide → AUCUN SMS envoyé', { messageId });
      return { action: 'skipped', reason: 'empty_transcription' };
    }
    // receiverId = UID du destinataire → numéro depuis le compte (jamais l'UID).
    const elig = await checkEligibility(msg.receiverId);
    if (!elig.eligible) {
      await db.collection('messages').doc(String(messageId)).set({ smsAfterTranscription: 'skipped_policy', audioSmsError: elig.reason, updatedAt: nowIso() }, { merge: true }).catch(() => {});
      return { action: 'skipped', reason: elig.reason };
    }
    if (!transportAvailable()) {
      await db.collection('messages').doc(String(messageId)).set({ smsAfterTranscription: 'pending', audioSmsError: 'transport indisponible — reprise possible', updatedAt: nowIso() }, { merge: true }).catch(() => {});
      return { action: 'skipped', reason: 'no_sms_provider' };
    }
    const out = await dispatchFallbackSms({ phone: elig.phone, text: buildAudioText(msg.senderName || null, text), recipientUid: msg.receiverId, messageId, dedupKey: String(messageId), kind: 'audio' });
    await db.collection('messages').doc(String(messageId)).set({
      smsAfterTranscription: out.status === 'sent' ? 'sent' : 'failed',
      audioSmsError: out.status === 'sent' ? null : (out.error || out.reason),
      updatedAt: nowIso(),
    }, { merge: true }).catch(() => {});
    return { action: out.status, reason: out.reason };
  } catch (err) {
    logger.warn('[SmsFallback] reprise vocale échouée (non bloquant)', { error: err.message });
    return { action: 'skipped', reason: 'resume_error', error: err.message };
  }
}

module.exports = { evaluateAndDispatch, armAudioFallback, resumeAfterTranscription, checkEligibility, _internals: { buildText, buildAudioText } };
