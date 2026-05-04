'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║       OmniSMS — Service SMS Hybride (v3)                    ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║                                                              ║
 * ║  Préfixes acceptés pour les alias : *  ou  #                ║
 * ║  (le @ est également conservé pour rétrocompatibilité)       ║
 * ║                                                              ║
 * ║  1. PREMIER MESSAGE HORS LIGNE                               ║
 * ║     Format : *NOM NUMERO message                             ║
 * ║     Aussi  : #NOM NUMERO message                             ║
 * ║     Ex    : *MAMAN 70223344 Bonjour maman                   ║
 * ║     → Créer l'utilisateur si absent                          ║
 * ║     → Sauvegarder l'alias scopé à l'expéditeur              ║
 * ║     → Envoyer le message au destinataire                     ║
 * ║     → Répondre : "Alias *MAMAN enregistré et message envoyé."║
 * ║                                                              ║
 * ║  2. MESSAGES SUIVANTS HORS LIGNE                             ║
 * ║     Format : *NOM message   ou   #NOM message               ║
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
 * ╚══════════════════════════════════════════════════════════════╝
 */

const { sendSMS }        = require('./smsProvider');
const UserSms            = require('../models/UserSms');
const Alias              = require('../models/Alias');
const Invitation         = require('../models/Invitation');
const { logger }         = require('../middleware/logger');
const { normalizePhone } = require('../config/db');

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────

/**
 * Préfixes acceptés pour les alias SMS.
 * * et # sont les préfixes principaux.
 * @ est conservé pour la rétrocompatibilité.
 */
const ALIAS_PREFIXES = ['*', '#', '@'];

/** Regex correspondant à l'un des préfixes d'alias */
const PREFIX_RE = /^[*#@]/;

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
• Première fois : *NOM NUMERO message
  Exemple : *PAPA 70112233 Bonsoir papa

• Fois suivantes : *NOM message
  Exemple : *PAPA Je rentre à 20h

💡 Le # fonctionne aussi : #PAPA 70112233 Bonsoir

🎁 5 SMS offerts dès l'inscription.
💎 Abonnement illimité disponible.

Tapez NOM VotrePrenom pour commencer.
`.trim();

// ─────────────────────────────────────────────────────────────
// Parseurs
// ─────────────────────────────────────────────────────────────

/**
 * Détecter si le message est la commande DÉMARRER.
 * Variantes acceptées : DÉMARRER, DEMARRER, START, COMMENCER, INSCRIRE, INSCRIPTION
 *
 * @param {string} msg
 * @returns {boolean}
 */
function isDemarrer(msg) {
  const upper = msg.trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip accents
  return ['DEMARRER', 'START', 'COMMENCER', 'INSCRIRE', 'INSCRIPTION'].includes(upper);
}

/**
 * Retirer le préfixe d'alias (* # @) d'une chaîne.
 * @param {string} s
 * @returns {string}
 */
function stripPrefix(s) {
  return s.replace(/^[*#@]+/, '');
}

/**
 * Tenter de parser un message au format "PREFIX_NOM NUMERO texte".
 * Préfixes acceptés : * # @
 * Le NUMERO peut être :
 *   - 8 chiffres locaux : 70223344
 *   - Avec indicatif    : +22670223344 / 0022670223344
 *
 * @param {string} msg - Message brut de l'expéditeur
 * @returns {{ prefix:string, alias:string, targetRaw:string, text:string }|null}
 */
function parseFirstMessage(msg) {
  const trimmed = msg.trim();

  // Doit commencer par un préfixe d'alias
  if (!PREFIX_RE.test(trimmed)) return null;

  // Regex : PREFIX ALIAS NUMERO texte
  // PREFIX = [*#@]
  // ALIAS  = [A-Za-zÀ-ÿ0-9_-]+
  // NUMERO = séquence de chiffres avec éventuellement + ou 00 au début
  const RE = /^([*#@])([A-Za-zÀ-ÿ0-9_\-]+)\s+(\+?[0-9]{7,15})\s+(.+)$/s;
  const match = trimmed.match(RE);
  if (!match) return null;

  return {
    prefix   : match[1],
    alias    : match[2],
    targetRaw: match[3],
    text     : match[4].trim(),
  };
}

/**
 * Tenter de parser un message au format "PREFIX_NOM texte" (sans numéro).
 * Ce format est utilisé pour les messages suivants (alias déjà enregistré).
 *
 * @param {string} msg
 * @returns {{ prefix:string, alias:string, text:string }|null}
 */
function parseFollowupMessage(msg) {
  const trimmed = msg.trim();

  // Doit commencer par un préfixe d'alias
  if (!PREFIX_RE.test(trimmed)) return null;

  const RE = /^([*#@])([A-Za-zÀ-ÿ0-9_\-]+)\s+(.+)$/s;
  const match = trimmed.match(RE);
  if (!match) return null;

  // Vérifier que ce n'est PAS un numéro (sinon c'est un premier message)
  const secondWord = match[3].split(/\s+/)[0];
  if (/^\+?[0-9]{7,15}$/.test(secondWord)) return null; // → c'est un premier message

  return {
    prefix: match[1],
    alias : match[2],
    text  : match[3].trim(),
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────

/**
 * Envoyer un SMS et logger le résultat.
 * Ne lève jamais d'exception — retourne toujours un résultat.
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
 *   1. DÉMARRER              → instructions inscription
 *   2. *NOM NUMERO texte     → premier message (alias + envoi)
 *   3. *NOM texte            → message suivant (résolution alias)
 *   4. Autres                → { handled: false } → délégué à smsHandler
 *
 * @param {string} fromPhone  - Numéro expéditeur (normalisé E.164)
 * @param {string} rawMessage - Contenu brut du SMS
 * @param {object} [opts]
 * @param {string} [opts.ip]
 * @returns {Promise<{ handled:boolean, reply:string, action:string }>}
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

    const joined = await Invitation.markAsJoined(from).catch(() => 0);
    if (joined > 0) {
      logger.info('[HybridSMS] Invitations converties', { from, count: joined });
    }

    await UserSms.getOrCreate(from);

    return {
      handled: true,
      reply  : INSTRUCTIONS_DEMARRER,
      action : 'DEMARRER',
    };
  }

  // ── 2. PREMIER MESSAGE : *NOM NUMERO texte ──────────────────
  const first = parseFirstMessage(msg);
  if (first) {
    const p = first.prefix; // * ou # ou @

    logger.info('[HybridSMS] Premier message détecté', {
      from,
      prefix: p,
      alias : first.alias,
      target: first.targetRaw,
    });

    await UserSms.getOrCreate(from);

    let targetPhone;
    try {
      targetPhone = normalizePhone(first.targetRaw);
    } catch (e) {
      return {
        handled: true,
        reply  : `❌ Numéro invalide : "${first.targetRaw}".\n\nFormat attendu : ${p}MAMAN 70223344 Bonjour`,
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

    // Vérifier si le destinataire est inscrit
    const recipientRegistered = await isRegistered(targetPhone);
    let outgoingMessage = first.text;

    if (!recipientRegistered) {
      outgoingMessage += INVITATION_SUFFIX;

      const senderUser = await UserSms.getByPhone(from);
      await Invitation.recordInvitation({
        inviterPhone  : from,
        inviterName   : senderUser && senderUser.name ? senderUser.name : null,
        inviteePhone  : targetPhone,
        messagePreview: first.text.slice(0, 40),
      });

      logger.info('[HybridSMS] Invitation enregistrée', { inviter: from, invitee: targetPhone });
    }

    const sendResult = await safeSend(
      targetPhone, outgoingMessage, `(premier msg alias ${p}${first.alias})`
    );

    const actionWord = created ? 'enregistré' : 'mis à jour';
    let reply;

    if (sendResult.success) {
      reply = [
        `✅ Alias ${p}${first.alias} ${actionWord}.`,
        `📤 Message envoyé à ${targetPhone}.`,
        ``,
        `Prochain message : ${p}${first.alias} VotreMessage`,
        `(sans numéro, OmniSMS se souvient ! 🧠)`,
      ].join('\n');
    } else {
      reply = [
        `✅ Alias ${p}${first.alias} ${actionWord}.`,
        `⚠️ Message non livré (erreur réseau) — réessayez :`,
        `  ${p}${first.alias} ${first.text}`,
      ].join('\n');
    }

    return {
      handled: true,
      reply,
      action : created ? 'FIRST_MESSAGE_NEW_ALIAS' : 'FIRST_MESSAGE_UPDATE_ALIAS',
    };
  }

  // ── 3. MESSAGE SUIVANT : *NOM texte ─────────────────────────
  const followup = parseFollowupMessage(msg);
  if (followup) {
    const p = followup.prefix;

    logger.info('[HybridSMS] Message suivant détecté', {
      from,
      prefix: p,
      alias : followup.alias,
    });

    await UserSms.getOrCreate(from);

    const resolved = await Alias.resolveAlias(from, followup.alias);

    if (!resolved) {
      return {
        handled: true,
        reply  : [
          `❓ Alias ${p}${followup.alias} inconnu.`,
          ``,
          `Pour l'enregistrer, envoyez :`,
          `${p}${followup.alias} NUMERO message`,
          ``,
          `Exemple : ${p}${followup.alias} 70223344 Bonjour`,
        ].join('\n'),
        action : 'ALIAS_NOT_FOUND',
      };
    }

    const { targetPhone, targetName } = resolved;

    const recipientRegistered = await isRegistered(targetPhone);
    let outgoingMessage = followup.text;

    if (!recipientRegistered) {
      outgoingMessage += INVITATION_SUFFIX;

      const senderUser = await UserSms.getByPhone(from);
      await Invitation.recordInvitation({
        inviterPhone  : from,
        inviterName   : senderUser && senderUser.name ? senderUser.name : null,
        inviteePhone  : targetPhone,
        messagePreview: followup.text.slice(0, 40),
      });
    }

    const sendResult = await safeSend(
      targetPhone, outgoingMessage, `(alias ${p}${followup.alias})`
    );
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
  parseFirstMessage,
  parseFollowupMessage,
  isDemarrer,
  stripPrefix,
  ALIAS_PREFIXES,
  INSTRUCTIONS_DEMARRER,
  INVITATION_SUFFIX,
};
