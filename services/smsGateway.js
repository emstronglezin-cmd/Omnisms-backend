'use strict';
/**
 * OmniSMS — Répartiteur SMS sortant (module générique, ex « Service INfiniReach »).
 *
 * ── LEGACY DÉSACTIVÉ ──────────────────────────────────────────────────────
 * Ce module était le client INfiniReach (https://api.infinireach.io).
 * INfiniReach a été RETIRÉ du projet : plus aucune variable INFINIREACH_*,
 * plus aucune URL, clé API ni appel réseau vers ce fournisseur. Le nom de
 * fichier historique (smsGateway.js) est conservé car des harnais de test et
 * des modules l'injectent ; l'interface publique est inchangée.
 *
 * Fournisseur officiel : SMSGate (services/smsGateProvider.js — application
 * « SMS Gateway for Android » sur le téléphone passerelle, variables
 * SMS_GATEWAY_LOGIN / SMS_GATEWAY_PASSWORD / SMS_GATEWAY_DEVICE_ID /
 * SMS_GATEWAY_SERVER_ADDRESS).
 *
 * Chaîne d'envoi :
 *   1. SMSGate (prioritaire, fournisseur sélectionné) ;
 *   2. Sinon : erreur explicite — AUCUN fallback legacy, aucune bascule
 *      silencieuse de fournisseur (règle projet).
 * (Le pool multi-appareils — services/gatewayPool.js — reste disponible en
 * module mais n'est plus branché dans cette chaîne : son dispatch était
 * couplé au flux INfiniReach retiré.)
 *
 * Interface publique conservée :
 *   isConfigured(), isSmsGatewayProvider() [→ false, legacy],
 *   getActiveProvider(), sendSMS({ to, text, messageId }),
 *   validateWebhookSignature(req), getStatus(), logStartupDiagnostic()
 */
const crypto = require('crypto');
const { logger } = require('../middleware/logger');

/* ── SMSGate actif ? ─────────────────────────────────────────── */
function smsgateReady() {
  try {
    const p = require('./smsGateProvider');
    return !!(p.isEnabled && p.isEnabled());
  } catch (_) { return false; }
}

/** true si le transport SMSGate est disponible. */
function isConfigured() {
  return smsgateReady();
}

/**
 * DEPRÉCIÉ — l'ancien fournisseur INfiniReach est désactivé définitivement.
 * Retourne toujours false : AUCUNE configuration ne peut plus le sélectionner.
 */
function isSmsGatewayProvider() {
  return false;
}

/** Fournisseur officiel : SMSGate. */
function getActiveProvider() {
  return 'smsgate';
}

/* ── Envoi ──────────────────────────────────────────────────── */
/**
 * Envoie un SMS via SMSGate.
 * @param {object} p { to, text, messageId? }
 * @returns {Promise<{success:boolean, gatewayMessageId?:string, provider:string, error?:string, ...}>}
 */
async function sendSMS({ to, text, messageId = null } = {}) {
  if (!to || !text) {
    throw new Error('[SMS] sendSMS: "to" et "text" sont requis');
  }

  try {
    const smsgate = require('./smsGateProvider');
    if (smsgate.isEnabled && smsgate.isEnabled()) {
      const started = Date.now();
      const r = await smsgate.sendSMS({ to, text, messageId });
      try {
        const { metricsService } = require('./metrics');
        metricsService.smsSend('smsgate', !!r.success, Date.now() - started);
      } catch (_) {}
      return r;
    }
  } catch (sgErr) {
    logger.warn('[SMSGate] Délégation impossible', { error: sgErr.message });
  }

  return {
    success: false,
    provider: 'none',
    error: 'Aucun transport SMS actif — SMSGate requis (SMS_GATEWAY_LOGIN/PASSWORD/DEVICE_ID/SERVER_ADDRESS).',
  };
}

/* ── Validation des webhooks de la passerelle ───────────────── */
/**
 * Valide la signature HMAC-SHA256 d'un webhook passerelle entrant.
 * Variables GÉNÉRIQUES (l'ancien couple INFINIREACH_* est retiré) :
 *   - SMS_GATEWAY_WEBHOOK_SECRET            : secret partagé (vide = permissif)
 *   - SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE : 'true' → échec fermé si absent
 * Comportement identique à l'historique : permissif par défaut, strict si
 * explicitement demandé. Ne journalise JAMAIS la valeur du secret.
 * @param {object} req - Requête Express
 * @returns {boolean}
 */
function validateWebhookSignature(req) {
  const webhookSecret = String(process.env.SMS_GATEWAY_WEBHOOK_SECRET || '').trim();
  const enforced = String(process.env.SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE || '').trim().toLowerCase() === 'true';

  if (!webhookSecret) {
    // Pas de secret configuré : permissif par défaut, mais échec FERMÉ si le
    // mode strict est demandé (on n'accepte jamais un webhook non signé alors).
    if (enforced) {
      logger.error('[SMSGATE] webhook:rejected REQUIRE_SIGNATURE=true mais SMS_GATEWAY_WEBHOOK_SECRET absent — requête rejetée');
      return false;
    }
    return true;
  }

  // Lire la signature depuis l'en-tête (alias historique toléré en transition).
  const sig = req.headers['x-signature']
    || req.headers['x-gateway-signature']
    || req.headers['x-infinireach-signature']
    || '';

  if (!sig) {
    if (enforced) {
      logger.warn('[SMSGATE] webhook:invalid Signature manquante (mode strict)');
      return false;
    }
    logger.warn('[SMSGATE] webhook:invalid Signature manquante (mode permissif)');
    return true;
  }

  const rawBody = req.rawBody || (req.body ? JSON.stringify(req.body) : '');
  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  const sigNorm      = String(sig).trim().toLowerCase().replace(/^sha256=/, '');
  const expectedNorm = expectedSig.toLowerCase();

  if (sigNorm.length !== expectedNorm.length) {
    logger.warn('[SMSGATE] webhook:invalid Longueur signature incorrecte');
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedNorm, 'hex'),
      Buffer.from(sigNorm, 'hex')
    );
  } catch (_) {
    return false;
  }
}

/* ── Statut (sans secret) ───────────────────────────────────── */
function getStatus() {
  return {
    provider        : 'smsgate',
    configured      : isConfigured(),
    legacy          : 'infinireach disabled',
    webhookSecret   : String(process.env.SMS_GATEWAY_WEBHOOK_SECRET || '').trim() ? 'CONFIGURED' : 'non défini (mode permissif)',
    webhookStrict   : String(process.env.SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE || '').trim().toLowerCase() === 'true',
  };
}

/* ── Diagnostic de démarrage ────────────────────────────────── */
/**
 * Logs de démarrage sûrs (jamais de secret). Appelé UNE SEULE FOIS depuis server.js.
 */
function logStartupDiagnostic() {
  const st = getStatus();
  logger.info('SMS PROVIDER: SMSGATE');
  logger.info('LEGACY PROVIDER: INFINIREACH DISABLED');
  logger.info('[SMSGATE] Config au démarrage (aucun secret) : ' + JSON.stringify({
    smsgateConfigured : st.configured,
    offlineSmsProvider: String(process.env.OFFLINE_SMS_PROVIDER || 'smsgate (défaut)'),
    webhookSecret     : st.webhookSecret,
    webhookStrict     : st.webhookStrict,
  }));
}

module.exports = {
  isConfigured,
  isSmsGatewayProvider,
  getActiveProvider,
  sendSMS,
  validateWebhookSignature,
  getStatus,
  logStartupDiagnostic,
};
