'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║     OmniSMS — Route SMS Hybride (NOUVEAU)                   ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║                                                              ║
 * ║  Ce routeur est ADDITIONNEL et N'interfère PAS avec          ║
 * ║  les routes existantes (sms.webhook.js, smsHandler.js, etc.) ║
 * ║                                                              ║
 * ║  Endpoint principal :                                        ║
 * ║    POST /sms/hybrid/incoming                                 ║
 * ║      → Webhook universel (Africa's Talking / Twilio / Orange)║
 * ║      → Détecte le format hybride @NOM NUMERO message         ║
 * ║      → Si format hybride → hybridSms.handleHybridSms()      ║
 * ║      → Sinon → délègue au handler existant (smsHandler)      ║
 * ║                                                              ║
 * ║  Endpoints utilitaires :                                     ║
 * ║    GET  /sms/hybrid/aliases?from=PHONE                       ║
 * ║    GET  /sms/hybrid/status                                   ║
 * ║    POST /sms/hybrid/test    (dev/staging uniquement)         ║
 * ║                                                              ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const express = require('express');
const router  = express.Router();

const { handleHybridSms } = require('../services/hybridSms');
const { handleSMS }       = require('../services/smsHandler');   // handler existant (fallback)
const { sendSMS }         = require('../services/smsProvider');
const Alias               = require('../models/Alias');
const { logger }          = require('../middleware/logger');
const { normalizePhone }  = require('../config/db');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Extraire le numéro de téléphone et le message depuis les différents
 * formats de webhook (Africa's Talking, Twilio, Orange, générique).
 * Identique au parser de sms.webhook.js — dupliqué pour isolation totale.
 */
function extractPhoneAndMessage(body) {
  // Africa's Talking
  if (body.from && body.text) {
    return { phone: body.from, message: body.text };
  }
  // Twilio (URLencoded)
  if (body.From && body.Body) {
    return { phone: body.From, message: body.Body };
  }
  // Orange (format custom)
  if (body.sender && body.content) {
    return { phone: body.sender, message: body.content };
  }
  // Format générique / test manuel
  if (body.phone && body.message) {
    return { phone: body.phone, message: body.message };
  }
  // Format compact
  if (body.number && body.msg) {
    return { phone: body.number, message: body.msg };
  }
  return null;
}

/**
 * Envoyer la réponse SMS à l'expéditeur si une réponse est définie.
 * Silencieux en cas d'erreur (ne bloque pas la réponse HTTP).
 */
async function replyToSender(phone, replyText) {
  if (!replyText || !replyText.trim()) return;
  try {
    await sendSMS(phone, replyText);
    logger.info('[HybridRoute] Réponse envoyée', { to: phone, chars: replyText.length });
  } catch (err) {
    logger.warn('[HybridRoute] Impossible d\'envoyer la réponse', {
      to   : phone,
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /sms/hybrid/incoming
// ─────────────────────────────────────────────────────────────

/**
 * Webhook universel pour le flow SMS hybride.
 *
 * Priorité de traitement :
 *   1. hybridSms.handleHybridSms() — tente de traiter le message
 *   2. Si le flow hybride n'a pas géré (handled=false) → handleSMS() existant
 *
 * Réponse HTTP : toujours 200 immédiatement.
 * L'envoi de la réponse SMS est asynchrone (setImmediate).
 */
router.post('/incoming', async (req, res) => {
  // ── Répondre 200 immédiatement pour éviter le retry webhook ─
  res.status(200).json({ received: true });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || '0.0.0.0';

  setImmediate(async () => {
    try {
      const extracted = extractPhoneAndMessage(req.body);

      if (!extracted) {
        logger.warn('[HybridRoute] Payload invalide — impossible d\'extraire phone/message', {
          body: JSON.stringify(req.body).slice(0, 200),
          ip,
        });
        return;
      }

      const { phone, message } = extracted;
      let from;
      try {
        from = normalizePhone(phone);
      } catch {
        logger.warn('[HybridRoute] Numéro expéditeur invalide', { phone, ip });
        return;
      }

      logger.info('[HybridRoute] SMS entrant', {
        from,
        preview: (message || '').slice(0, 50),
        ip,
      });

      // ── Tenter le flow hybride en priorité ────────────────────
      const result = await handleHybridSms(from, message, { ip });

      if (result.handled) {
        // Le flow hybride a traité le message → envoyer la réponse
        logger.info('[HybridRoute] Traité par flow hybride', {
          from,
          action: result.action,
          hasReply: !!result.reply,
        });
        await replyToSender(from, result.reply);
        return;
      }

      // ── Déléguer au handler SMS existant (fallback) ───────────
      logger.info('[HybridRoute] Délégation au handler SMS existant', { from });
      const fallbackReply = await handleSMS(from, message, ip);
      await replyToSender(from, fallbackReply);

    } catch (err) {
      logger.error('[HybridRoute] Erreur non gérée dans le traitement', {
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 3).join(' | '),
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// GET /sms/hybrid/aliases?from=PHONE
// ─────────────────────────────────────────────────────────────

/**
 * Lister les alias d'un utilisateur.
 * Utile pour le debugging et les interfaces admin.
 *
 * Query params :
 *   from : numéro de l'expéditeur (requis)
 *
 * Réponse : { phone, aliases: [{alias, targetPhone, targetName, createdAt}] }
 */
router.get('/aliases', async (req, res) => {
  const { from } = req.query;

  if (!from) {
    return res.status(400).json({
      error  : 'Paramètre "from" requis.',
      example: '/sms/hybrid/aliases?from=+22670000000',
    });
  }

  try {
    const phone   = normalizePhone(from);
    const aliases = await Alias.listAliases(phone);

    return res.status(200).json({
      success: true,
      phone,
      count  : aliases.length,
      aliases: aliases.map(a => ({
        alias      : `@${a.alias}`,
        targetPhone: a.targetPhone,
        targetName : a.targetName,
        createdAt  : a.createdAt,
        updatedAt  : a.updatedAt,
      })),
    });
  } catch (err) {
    logger.error('[HybridRoute] Erreur listage aliases', { error: err.message });
    return res.status(500).json({ error: 'Erreur interne.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /sms/hybrid/status
// ─────────────────────────────────────────────────────────────

/**
 * Statut du service SMS hybride.
 * Retourne les endpoints disponibles et la version.
 */
router.get('/status', (_req, res) => {
  return res.status(200).json({
    service : 'OmniSMS Hybrid SMS',
    version : '1.0.0',
    status  : 'active',
    endpoints: {
      webhook : 'POST /sms/hybrid/incoming',
      aliases : 'GET  /sms/hybrid/aliases?from=PHONE',
      test    : 'POST /sms/hybrid/test  (non-production seulement)',
    },
    formats: {
      demarrer       : 'DÉMARRER',
      premierMessage : '@NOM NUMERO message',
      messageSuivant : '@NOM message',
    },
    collections: {
      aliases    : 'aliases',
      invitations: 'invitations',
      users      : 'users  (partagée — lecture/écriture non-destructive)',
    },
  });
});

// ─────────────────────────────────────────────────────────────
// POST /sms/hybrid/test (NON-PRODUCTION uniquement)
// ─────────────────────────────────────────────────────────────

/**
 * Endpoint de test pour simuler un SMS entrant sans passer par
 * un vrai provider.
 *
 * Body : { phone: "+22670000000", message: "@MAMAN 70223344 Bonjour" }
 *
 * Retourne la réponse qui aurait été envoyée par SMS.
 * Désactivé en production pour éviter les abus.
 */
router.post('/test', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      error: 'Endpoint de test désactivé en production.',
    });
  }

  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({
      error  : 'Champs "phone" et "message" requis.',
      example: { phone: '+22670000000', message: '@MAMAN 70223344 Bonjour' },
    });
  }

  try {
    let from;
    try {
      from = normalizePhone(phone);
    } catch {
      return res.status(400).json({ error: `Numéro invalide : "${phone}"` });
    }

    // Tenter le flow hybride
    const result = await handleHybridSms(from, message, { ip: req.ip });

    if (result.handled) {
      return res.status(200).json({
        success : true,
        from,
        message,
        action  : result.action,
        reply   : result.reply,
        note    : 'En production, cette réponse serait envoyée par SMS.',
      });
    }

    // Fallback vers handler existant
    const fallbackReply = await handleSMS(from, message, req.ip);
    return res.status(200).json({
      success    : true,
      from,
      message,
      action     : 'FALLBACK_SMS_HANDLER',
      reply      : fallbackReply,
      note       : 'Traité par le handler SMS existant.',
    });

  } catch (err) {
    logger.error('[HybridTest] Erreur', { error: err.message });
    return res.status(500).json({
      error  : 'Erreur interne.',
      details: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────
module.exports = router;
