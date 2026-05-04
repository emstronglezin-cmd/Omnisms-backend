'use strict';
/**
 * OmniSMS — Gestionnaire SMS Complet
 *
 * Commandes supportées :
 *
 *  ── Inscription ─────────────────────────────────────────────
 *   START              → Bienvenue + instructions inscription
 *   NOM Jean           → Créer le compte utilisateur
 *
 *  ── Contacts ────────────────────────────────────────────────
 *   ADD Jean 77000000  → Ajouter un contact
 *   CONTACTS           → Lister les contacts
 *
 *  ── Envoi SMS ───────────────────────────────────────────────
 *   *Jean\nMessage     → Envoyer à un contact par nom (préfixe * ou #)
 *   #Jean\nMessage     → Identique avec le préfixe #
 *   @Jean\nMessage     → Aussi accepté (rétrocompatibilité)
 *   *+22670000000\nMsg → Envoyer à un numéro
 *
 *  ── Crédits & Recharge ──────────────────────────────────────
 *   RECHARGE <montant> → Instructions de paiement
 *   CONFIRM <montant>  → Valider une recharge
 *   PREMIUM            → Instructions paiement premium
 *   CONFIRM PREMIUM    → Activer le compte Premium
 *   SOLDE              → Voir crédits / statut
 *   AIDE               → Aide commandes
 */

const UserSms   = require('../models/UserSms');
const { sendSMS } = require('./smsProvider');
const { resolveCredits, getRechargeTable, PAYMENT_NUMBER, PREMIUM_AMOUNT } = require('./creditSystem');
const { logPaymentAttempt } = require('./antifraud');
const { logger } = require('../middleware/logger');
const { normalizePhone } = require('../config/db');

// Lien d'abonnement GeniusPay
const SUBSCRIPTION_LINK = process.env.GENIUSPAY_PAYMENT_LINK
  || `${process.env.BACKEND_URL || 'https://omnisms-backend.onrender.com'}/api/payment/link`;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Vérifier si un message est un envoi SMS formaté *Dest\nMessage
 * Préfixes acceptés : * # @
 */
function isSmsSendCommand(msg) {
  return /^[*#@]/.test(msg) && msg.includes('\n');
}

// ─────────────────────────────────────────────────────────────
// Gestionnaire principal
// ─────────────────────────────────────────────────────────────

/**
 * Traiter un SMS entrant et retourner la réponse à envoyer.
 * @param {string} phone      - Numéro expéditeur (normalisé E.164)
 * @param {string} rawMessage - Contenu brut du SMS
 * @param {string} ip         - IP de la requête (pour logs anti-fraude)
 * @returns {Promise<string>} - Réponse à envoyer par SMS
 */
async function handleSMS(phone, rawMessage, ip = '0.0.0.0') {
  const normalized = normalizePhone(phone);
  const msg        = rawMessage.trim();
  const msgUpper   = msg.toUpperCase();

  logger.info('SMS entrant', { from: normalized, preview: msg.substring(0, 40) });

  // ── S'assurer que l'utilisateur existe dans Firestore ────────
  let user = await UserSms.getOrCreate(normalized);

  /* ============================================================
     COMMANDE : START — Inscription
  ============================================================ */
  if (msgUpper === 'START') {
    if (user.name) {
      return `👋 Bienvenue ${user.name} !\n\nVous avez déjà un compte OmniSMS.\nTapez AIDE pour les commandes.`;
    }
    return (
      `✅ Bienvenue sur OmniSMS !\n\n` +
      `Pour créer votre compte, envoyez :\n` +
      `NOM VotrePrenom\n\n` +
      `Exemple : NOM Jean`
    );
  }

  /* ============================================================
     COMMANDE : NOM <prénom> — Création de compte
  ============================================================ */
  if (msgUpper.startsWith('NOM ')) {
    const name = msg.slice(4).trim();

    if (!name || name.length < 2) {
      return `❌ Prénom invalide.\n\nExemple : NOM Jean`;
    }

    if (user.name) {
      // Mise à jour du nom
      await UserSms.update(normalized, { name });
      return `✅ Nom mis à jour : ${name}`;
    }

    // Création du compte
    await UserSms.update(normalized, { name });
    user = await UserSms.getByPhone(normalized);

    logger.info('Compte créé via SMS', { phone: normalized, name });

    return (
      `✅ Compte créé avec succès !\n\n` +
      `👤 Nom    : ${name}\n` +
      `📱 Quota  : ${user.smsQuota} SMS gratuits\n\n` +
      `Tapez AIDE pour voir les commandes.`
    );
  }

  /* ============================================================
     COMMANDE : ADD <nom> <numéro> — Ajouter un contact
  ============================================================ */
  if (msgUpper.startsWith('ADD ')) {
    const parts = msg.slice(4).trim().split(/\s+/);

    if (parts.length < 2) {
      return `❌ Format invalide.\n\nExemple : ADD Jean 70000000`;
    }

    const contactName  = parts[0];
    const contactPhone = parts.slice(1).join('');

    try {
      const contactNormalized = normalizePhone(contactPhone);
      const { added, contact } = await UserSms.addContact(normalized, contactName, contactNormalized);

      if (!added) {
        return `ℹ️ Contact ${contact.name} (${contact.phone}) existe déjà.`;
      }

      logger.info('Contact ajouté', { owner: normalized, contact: contactNormalized });
      return `✅ Contact ${contactName} (${contact.phone}) ajouté !\n\nEnvoyez *${contactName}\\nVotreMessage pour lui écrire.`;
    } catch (err) {
      logger.error('Erreur ADD contact', { error: err.message });
      return `❌ Numéro invalide : ${contactPhone}\n\nExemple : ADD Jean +22670000000`;
    }
  }

  /* ============================================================
     COMMANDE : CONTACTS — Lister les contacts
  ============================================================ */
  if (msgUpper === 'CONTACTS' || msgUpper === 'MES CONTACTS') {
    const contacts = user.contacts || [];

    if (contacts.length === 0) {
      return `📋 Aucun contact.\n\nAjoutez un contact :\nADD Jean 70000000`;
    }

    const list = contacts.slice(0, 10).map((c, i) => `${i + 1}. ${c.name} → ${c.phone}`).join('\n');
    const more = contacts.length > 10 ? `\n...et ${contacts.length - 10} autres` : '';
    return `📋 Vos contacts (${contacts.length}) :\n\n${list}${more}`;
  }

  /* ============================================================
     COMMANDE : *Dest\nMessage — Envoi SMS intelligent
     Préfixes acceptés : * # @
  ============================================================ */
  if (isSmsSendCommand(msg)) {
    const lines    = msg.split('\n');
    const target   = lines[0].trim();
    const content  = lines.slice(1).join('\n').trim();

    if (!content) {
      return `❌ Message vide.\n\nFormat : *Jean\\nVotre message`;
    }

    // Vérifier l'abonnement ou le quota
    if (!user.isSubscribed) {
      const { allowed, remaining } = await UserSms.decrementQuota(normalized);
      if (!allowed) {
        return (
          `⚠️ Quota SMS épuisé (${UserSms.DEFAULT_QUOTA}/jour).\n\n` +
          `Pour envoyer illimité, passez Premium :\n` +
          `${SUBSCRIPTION_LINK}\n\n` +
          `Ou tapez PREMIUM pour les instructions.`
        );
      }
      logger.info('Quota décrémenté', { phone: normalized, remaining });
    }

    // Résoudre le destinataire
    const resolved = await UserSms.resolveTarget(normalized, target);

    if (!resolved) {
      return (
        `❌ Destinataire "${target}" introuvable.\n\n` +
        `Format *Nom → cherche dans vos contacts.\n` +
        `Ajoutez ce contact : ADD ${target.slice(1)} NUMERO`
      );
    }

    // Envoyer le SMS via le provider configuré
    const result = await sendSMS(resolved.phone, content);

    if (result.success) {
      const displayName = resolved.name || resolved.phone;
      logger.info('SMS envoyé', { from: normalized, to: resolved.phone, provider: result.provider });
      return `✅ SMS envoyé à ${displayName} via ${result.provider}.`;
    }

    // Provider non configuré ou erreur
    if (result.provider === 'none') {
      return (
        `⚠️ Service SMS temporairement indisponible.\n` +
        `Votre message a été enregistré.\n` +
        `Réessayez dans quelques minutes.`
      );
    }

    return `❌ Échec envoi SMS à ${resolved.name || resolved.phone}.\n\nErreur : ${result.error}`;
  }

  /* ============================================================
     COMMANDE : SOLDE / BALANCE
  ============================================================ */
  if (['SOLDE', 'BALANCE', 'CREDIT', 'CREDITS', 'STATUT'].includes(msgUpper)) {
    const status = user.isSubscribed
      ? `⭐ Premium actif (illimité)`
      : `💰 ${user.smsQuota || 0} SMS gratuit(s) restant(s)`;

    const name = user.name ? `👤 ${user.name}\n` : '';
    return `📊 Votre compte OmniSMS :\n${name}${status}\n\nTapez AIDE pour les commandes.`;
  }

  /* ============================================================
     COMMANDE : AIDE / HELP
  ============================================================ */
  if (['AIDE', 'HELP', 'MENU', '?'].includes(msgUpper)) {
    return (
      '📱 OmniSMS — Commandes :\n\n' +
      '── Compte ──\n' +
      'START           → Inscription\n' +
      'NOM <prénom>    → Définir son nom\n\n' +
      '── Contacts ──\n' +
      'ADD Nom Num     → Ajouter contact\n' +
      'CONTACTS        → Voir contacts\n\n' +
      '── Envoi SMS ──\n' +
      '*Nom ou #Nom    → Envoyer (suivi du msg)\n\n' +
      '── Recharge ──\n' +
      'RECHARGE <F>    → Instructions recharge\n' +
      'CONFIRM <F>     → Valider recharge\n' +
      'PREMIUM         → Passer Premium\n' +
      'SOLDE           → Voir solde\n\n' +
      `Barème :\n${getRechargeTable()}`
    );
  }

  /* ============================================================
     COMMANDE : RECHARGE <montant>
  ============================================================ */
  if (msgUpper.startsWith('RECHARGE ')) {
    const amount = parseInt(msg.split(' ')[1], 10);

    if (!amount || isNaN(amount)) {
      return `❌ Montant invalide.\n\nExemple : RECHARGE 500\n\nMontants valides :\n${getRechargeTable()}`;
    }

    const credits = resolveCredits(amount);
    if (!credits) {
      return (
        `❌ Montant ${amount}F non reconnu.\n\n` +
        `Montants acceptés :\n${getRechargeTable()}\n\n` +
        `Exemple : RECHARGE 500`
      );
    }

    logPaymentAttempt({ phone: normalized, ip, action: 'RECHARGE_REQUEST', status: 'info', details: `amount=${amount}F` });

    return (
      `💸 Recharge ${amount}F :\n\n` +
      `Envoyez ${amount}F au ${PAYMENT_NUMBER}\n\n` +
      `Puis confirmez :\nCONFIRM ${amount}\n\n` +
      `→ +${credits} crédit(s) ✅`
    );
  }

  /* ============================================================
     COMMANDE : PREMIUM
  ============================================================ */
  if (msgUpper === 'PREMIUM') {
    if (user.isSubscribed) {
      return `⭐ Vous êtes déjà Premium !\n\nEnvoi SMS illimité activé.`;
    }

    logPaymentAttempt({ phone: normalized, ip, action: 'PREMIUM_REQUEST', status: 'info' });

    return (
      `⭐ Passer Premium OmniSMS :\n\n` +
      `Prix : ${PREMIUM_AMOUNT}F (paiement unique)\n\n` +
      `Option 1 — Lien de paiement :\n${SUBSCRIPTION_LINK}\n\n` +
      `Option 2 — Virement :\nEnvoyez ${PREMIUM_AMOUNT}F au ${PAYMENT_NUMBER}\n` +
      `Puis : CONFIRM PREMIUM`
    );
  }

  /* ============================================================
     COMMANDE : CONFIRM PREMIUM
  ============================================================ */
  if (msgUpper === 'CONFIRM PREMIUM') {
    if (user.isSubscribed) {
      return `⭐ Premium déjà actif sur votre compte !`;
    }

    await UserSms.activatePremium(normalized);

    logPaymentAttempt({
      phone  : normalized, ip,
      action : 'CONFIRM_PREMIUM_OFFLINE',
      status : 'success',
      details: 'premium=true via SMS offline',
    });

    logger.info('Premium activé via SMS', { phone: normalized });

    return (
      `✅ Premium activé !\n\n` +
      `⭐ Bienvenue dans OmniSMS Premium !\n` +
      `Envoi SMS illimité débloqué.\n\n` +
      `Merci 🙏`
    );
  }

  /* ============================================================
     COMMANDE : CONFIRM <montant>
  ============================================================ */
  if (msgUpper.startsWith('CONFIRM ')) {
    const amount  = parseInt(msg.split(' ')[1], 10);

    if (!amount || isNaN(amount)) {
      return `❌ Format invalide.\n\nExemple : CONFIRM 500`;
    }

    const credits = resolveCredits(amount);
    if (!credits) {
      return (
        `❌ Montant ${amount}F non reconnu.\n\n` +
        `Montants valides :\n${getRechargeTable()}`
      );
    }

    const current    = user.smsQuota || 0;
    const newCredits = current + credits;

    await UserSms.update(normalized, {
      smsQuota    : newCredits,
      lastPaymentAt: new Date().toISOString(),
    });

    logPaymentAttempt({
      phone  : normalized, ip,
      action : 'CONFIRM_RECHARGE_OFFLINE',
      status : 'success',
      details: `amount=${amount}F credits_added=${credits} new_balance=${newCredits}`,
    });

    logger.info('Recharge confirmée', { phone: normalized, credits, newCredits });

    return (
      `✅ Recharge validée !\n\n` +
      `+${credits} crédit(s) ajouté(s)\n` +
      `💰 Solde : ${newCredits} crédit(s)\n\n` +
      `Merci d'utiliser OmniSMS 🙏`
    );
  }

  /* ============================================================
     COMMANDE NON RECONNUE
  ============================================================ */

  // Si l'utilisateur n'est pas encore inscrit, l'encourager
  if (!user.name) {
    return (
      `👋 Bienvenue sur OmniSMS !\n\n` +
      `Envoyez START pour commencer votre inscription.`
    );
  }

  return (
    `❓ Commande non reconnue.\n\n` +
    `Tapez AIDE pour voir toutes les commandes.`
  );
}

module.exports = { handleSMS };
