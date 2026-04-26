'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║       OmniSMS — Service SMS Hybride (NOUVEAU)               ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║                                                              ║
 * ║  Ce service gère le flow SMS "hors-ligne" enrichi :          ║
 * ║                                                              ║
 * ║  1. PREMIER MESSAGE HORS LIGNE                               ║
 * ║     Format : @NOM NUMERO message                             ║
 * ║     Ex    : @MAMAN 70223344 Bonjour maman                   ║
 * ║     → Créer l'utilisateur si absent                          ║
 * ║     → Sauvegarder l'alias scopé à l'expéditeur              ║
 * ║     → Envoyer le message au destinataire                     ║
 * ║     → Répondre : "Alias @MAMAN enregistré et message envoyé."║
 * ║                                                              ║
 * ║  2. MESSAGES SUIVANTS HORS LIGNE                             ║
 * ║     Format : @NOM message (tout sur une ligne)               ║
 * ║     → Chercher l'alias par numéro expéditeur                 ║
 * ║     → Résoudre le numéro cible                               ║
 * ║     → Envoyer le message                                     ║
 * ║                                                              ║
 * ║  3. DESTINATAIRE NON INSCRIT                                 ║
 * ║     → Envoyer le SMS normalement                             ║
 * ║     → Ajouter : "via OmniSMS. Répondez DÉMARRER..."          ║
 * ║                                                              ║
 * ║  4. COMMANDE DÉMARRER                                        ║
 * ║     → Répondre avec les instructions d'inscription           ║
 * ║                                                              ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  ISOLATION TOTALE : ce fichier N'IMPORTE PAS smsHandler.js  ║
 * ║  Il réutilise seulement : smsProvider, UserSms, Alias,       ║
 * ║  Invitation, logger, normalizePhone                          ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const { sendSMS }       = require('./smsProvider');
const UserSms           = require('../models/UserSms');
const Alias             = require('../models/Alias');
const Invitation        = require('../models/Invitation');
const { logger }        = require('../middleware/logger');
const { normalizePhone } = require('../config/db');

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────

/** Message d'invitation ajouté quand le destinataire n'est pas inscrit */
const INVITATION_SUFFIX =
  '\n\n— via OmniSMS. Répondez DÉMARRER pour vous connecter et envoyer des SMS gratuitement.';

/** Instructions d'inscription envoyées en réponse à DÉMARRER */
const INSTRUCTIONS_DEMARRER = `
🇫🇷 Bienvenue sur OmniSMS !

📲 Pour créer votre compte gratuitement :
1. Envoyez : NOM VotrePrenom
   Exemple : NOM Marie

📤 Pour envoyer un message :
• Première fois : @NOM NUMERO message
  Exemple : @PAPA 70112233 Bonsoir papa

• Fois suivantes : @NOM message
  Exemple : @PAPA Je rentre à 20h

🎁 5 SMS offerts dès l'inscription.
💎 Abonnement illimité disponible.

Tapez NOM VotrePrenom pour commencer.
`.trim();

// ─────────────────────────────────────────────────────────────
// Parseurs
// ─────────────────────────────────────────────────────────────

/**
 * Détecter si le message est la commande DÉMARRER.
 * Variantes acceptées : DÉMARRER, DEMARRER, START, COMMENCER
 *
 * @param {string} msg - Message brut
 * @returns {boolean}
 */
function isDemarrer(msg) {
  const upper = msg.trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip accents
  return ['DEMARRER', 'START', 'COMMENCER', 'INSCRIRE', 'INSCRIPTION'].includes(upper);
}

/**
 * Tenter de parser un message au format "@NOM NUMERO texte".
 * Le NUMERO peut être :
 *   - 8 chiffres locaux : 70223344
 *   - Avec indicatif    : +22670223344 / 0022670223344
 *   - Précédé de l'espace après @NOM
 *
 * @param {string} msg - Message brut de l'expéditeur
 * @returns {{ alias:string, targetRaw:string, text:string }|null}
 *   alias     → nom après @ (casse originale)
 *   targetRaw → numéro brut détecté
 *   text      → le reste du message
 */
function parseFirstMessage(msg) {
  const trimmed = msg.trim();

  // Doit commencer par @
  if (!trimmed.startsWith('@')) return null;

  // Regex : @ALIAS NUMERO texte
  // ALIAS  = [A-Za-zÀ-ÿ0-9_-]+  (pas d'espace, peut contenir tirets/underscore)
  // NUMERO = séquence de chiffres avec éventuellement + ou 00 au début
  const RE = /^@([A-Za-zÀ-ÿ0-9_\-]+)\s+(\+?[0-9]{7,15})\s+(.+)$/s;
  const match = trimmed.match(RE);
  if (!match) return null;

  return {
    alias    : match[1],
    targetRaw: match[2],
    text     : match[3].trim(),
  };
}

/**
 * Tenter de parser un message au format "@NOM texte" (sans numéro).
 * Ce format est utilisé pour les messages suivants (alias déjà enregistré).
 *
 * @param {string} msg
 * @returns {{ alias:string, text:string }|null}
 */
function parseFollowupMessage(msg) {
  const trimmed = msg.trim();
  if (!trimmed.startsWith('@')) return null;

  // @NOM suivi d'un espace et d'un texte (pas de numéro après @NOM)
  const RE = /^@([A-Za-zÀ-ÿ0-9_\-]+)\s+(.+)$/s;
  const match = trimmed.match(RE);
  if (!match) return null;

  // Vérifier que ce n'est PAS un numéro (sinon c'est un premier message)
  const secondWord = match[2].split(/\s+/)[0];
  if (/^\+?[0-9]{7,15}$/.test(secondWord)) return null; // → c'est un premier message

  return {
    alias: match[1],
    text : match[2].trim(),
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────

/**
 * Envoyer un SMS et logger le résultat.
 * Ne lève jamais d'exception — retourne toujours un résultat.
 *
 * @param {string} to      - Numéro destinataire (E.164)
 * @param {string} content - Contenu du message
 * @param {string} context - Contexte pour les logs
 * @returns {Promise<{success:boolean, provider:string, error?:string}>}
 */
async function safeSend(to, content, context = '') {
  try {
    const result = await sendSMS(to, content);
    logger.info(`[HybridSMS] SMS envoyé ${context}`, {
      to,
      provider: result.provider,
      success : result.success,
    });
    return result;
  } catch (err) {
    logger.error(`[HybridSMS] Erreur envoi SMS ${context}`, { to, error: err.message });
    return { success: false, provider: 'error', error: err.message };
  }
}

/**
 * Vérifier si un utilisateur est inscrit dans la collection "users".
 * Utilisé pour détecter si le destinataire est connu ou non.
 *
 * @param {string} phone
 * @returns {Promise<boolean>}
 */
async function isRegistered(phone) {
  const user = await UserSms.getByPhone(phone);
  return user !== null && user.name !== null;
}

// ─────────────────────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────────────────────

/**
 * Traiter un SMS entrant dans le flow hybride.
 *
 * Ordre de détection :
 *   1. DÉMARRER            → instructions inscription
 *   2. @NOM NUMERO texte   → premier message (alias + envoi)
 *   3. @NOM texte          → message suivant (résolution alias)
 *   4. Autres              → renvoyer vers smsHandler existant (hors scope ici)
 *
 * @param {string} fromPhone  - Numéro expéditeur (normalisé E.164)
 * @param {string} rawMessage - Contenu brut du SMS
 * @param {object} [opts]     - Options optionnelles
 * @param {string} [opts.ip]  - IP de la requête (logs)
 * @returns {Promise<{
 *   handled  : boolean,   ← true si le flow hybride a traité le message
 *   reply    : string,    ← réponse à envoyer à l'expéditeur (peut être vide)
 *   action   : string,    ← label descriptif de l'action effectuée
 * }>}
 */
async function handleHybridSms(fromPhone, rawMessage, opts = {}) {
  const from = normalizePhone(fromPhone);
  const msg  = (rawMessage || '').trim();
  const ip   = opts.ip || '0.0.0.0';

  logger.info('[HybridSMS] Message reçu', {
    from,
    preview: msg.substring(0, 50),
    ip,
  });

  // ── 1. COMMANDE DÉMARRER ─────────────────────────────────────
  if (isDemarrer(msg)) {
    logger.info('[HybridSMS] Commande DÉMARRER détectée', { from });

    // Marquer les invitations en attente comme converties
    const joined = await Invitation.markAsJoined(from).catch(() => 0);
    if (joined > 0) {
      logger.info('[HybridSMS] Invitations converties', { from, count: joined });
    }

    // Créer l'utilisateur s'il n'existe pas encore
    await UserSms.getOrCreate(from);

    return {
      handled: true,
      reply  : INSTRUCTIONS_DEMARRER,
      action : 'DEMARRER',
    };
  }

  // ── 2. PREMIER MESSAGE : @NOM NUMERO texte ───────────────────
  const first = parseFirstMessage(msg);
  if (first) {
    logger.info('[HybridSMS] Premier message détecté', {
      from,
      alias : first.alias,
      target: first.targetRaw,
    });

    // S'assurer que l'expéditeur existe
    await UserSms.getOrCreate(from);

    let targetPhone;
    try {
      targetPhone = normalizePhone(first.targetRaw);
    } catch {
      return {
        handled: true,
        reply  : `❌ Numéro invalide : "${first.targetRaw}".\n\nFormat attendu : @MAMAN 70223344 Bonjour`,
        action : 'INVALID_NUMBER',
      };
    }

    // Enregistrer l'alias (scopé à l'expéditeur — aucune collision globale)
    const { created } = await Alias.upsertAlias(from, first.alias, targetPhone, first.alias);

    logger.info('[HybridSMS] Alias enregistré', {
      owner  : from,
      alias  : first.alias,
      target : targetPhone,
      created,
    });

    // Construire le message à envoyer au destinataire
    // Vérifier si le destinataire est inscrit sur OmniSMS
    const recipientRegistered = await isRegistered(targetPhone);
    let outgoingMessage = first.text;

    if (!recipientRegistered) {
      // Destinataire non inscrit → ajouter le suffix d'invitation viral
      outgoingMessage += INVITATION_SUFFIX;

      // Enregistrer l'invitation (idempotent — ne crée pas de doublon)
      const senderUser = await UserSms.getByPhone(from);
      await Invitation.recordInvitation({
        inviterPhone  : from,
        inviterName   : senderUser?.name || null,
        inviteePhone  : targetPhone,
        messagePreview: first.text.slice(0, 40),
      });

      logger.info('[HybridSMS] Invitation enregistrée', {
        inviter: from,
        invitee: targetPhone,
      });
    }

    // Envoyer le message au destinataire
    const sendResult = await safeSend(targetPhone, outgoingMessage, `(premier msg alias @${first.alias})`);

    // Construire la réponse à l'expéditeur
    const actionWord = created ? 'enregistré' : 'mis à jour';
    let reply;

    if (sendResult.success) {
      reply = [
        `✅ Alias @${first.alias} ${actionWord}.`,
        `📤 Message envoyé à ${targetPhone}.`,
        '',
        `Prochain message : @${first.alias} VotreMessage`,
        `(sans numéro, OmniSMS se souvient ! 🧠)`,
      ].join('\n');
    } else {
      // Alias sauvegardé même si l'envoi échoue (réseau)
      reply = [
        `✅ Alias @${first.alias} ${actionWord}.`,
        `⚠️ Message non livré (erreur réseau) — réessayez :`,
        `  @${first.alias} ${first.text}`,
      ].join('\n');
    }

    return {
      handled: true,
      reply,
      action : created ? 'FIRST_MESSAGE_NEW_ALIAS' : 'FIRST_MESSAGE_UPDATE_ALIAS',
    };
  }

  // ── 3. MESSAGE SUIVANT : @NOM texte ─────────────────────────
  const followup = parseFollowupMessage(msg);
  if (followup) {
    logger.info('[HybridSMS] Message suivant détecté', {
      from,
      alias: followup.alias,
    });

    // S'assurer que l'expéditeur existe
    await UserSms.getOrCreate(from);

    // Résoudre l'alias
    const resolved = await Alias.resolveAlias(from, followup.alias);

    if (!resolved) {
      // Alias inconnu → suggérer d'enregistrer
      return {
        handled: true,
        reply  : [
          `❓ Alias @${followup.alias} inconnu.`,
          ``,
          `Pour l'enregistrer, envoyez :`,
          `@${followup.alias} NUMERO message`,
          ``,
          `Exemple : @${followup.alias} 70223344 Bonjour`,
        ].join('\n'),
        action : 'ALIAS_NOT_FOUND',
      };
    }

    const { targetPhone, targetName } = resolved;

    // Vérifier si le destinataire est inscrit
    const recipientRegistered = await isRegistered(targetPhone);
    let outgoingMessage = followup.text;

    if (!recipientRegistered) {
      outgoingMessage += INVITATION_SUFFIX;

      const senderUser = await UserSms.getByPhone(from);
      await Invitation.recordInvitation({
        inviterPhone  : from,
        inviterName   : senderUser?.name || null,
        inviteePhone  : targetPhone,
        messagePreview: followup.text.slice(0, 40),
      });
    }

    // Envoyer
    const sendResult = await safeSend(targetPhone, outgoingMessage, `(alias @${followup.alias})`);
    const displayName = targetName || targetPhone;

    let reply;
    if (sendResult.success) {
      reply = `✅ Message envoyé à ${displayName} via ${sendResult.provider}.`;
    } else {
      reply = [
        `⚠️ Erreur d'envoi à ${displayName}.`,
        `Réessayez dans quelques instants.`,
      ].join('\n');
    }

    return {
      handled: true,
      reply,
      action : 'FOLLOWUP_MESSAGE',
    };
  }

  // ── 4. Message non géré par ce service ──────────────────────
  // Le routeur délèguera à smsWebhookRoutes (smsHandler existant)
  return {
    handled: false,
    reply  : '',
    action : 'NOT_HYBRID',
  };
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  handleHybridSms,
  // Parseurs exposés pour les tests
  parseFirstMessage,
  parseFollowupMessage,
  isDemarrer,
  INSTRUCTIONS_DEMARRER,
  INVITATION_SUFFIX,
};
