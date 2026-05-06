'use strict';
/**
 * OmniSMS — Infobip SMS Routes
 *
 * POST /api/sms/send          — Send outbound SMS via Infobip
 * POST /webhooks/infobip      — Inbound SMS + delivery-report webhook
 *
 * Webhook URL to set in Infobip portal:
 *   https://omnisms-backend.onrender.com/webhooks/infobip
 *
 * Required environment variables:
 *   INFOBIP_API_KEY    — API key from https://portal.infobip.com
 *   INFOBIP_BASE_URL   — e.g. https://XXXXX.api.infobip.com
 *   INFOBIP_SENDER_ID  — Sender name shown on recipient's phone (default: OmniSMS)
 */

const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');

const infobip        = require('../services/infobip');
const { logger }     = require('../middleware/logger');
const authenticate   = require('../middleware/authenticate');

// ── Validation helper ───────────────────────────────────────
function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error : 'Données invalides.',
      code  : 'VALIDATION_ERROR',
      fields: errors.array().map((e) => ({ field: e.path, msg: e.msg })),
    });
  }
  return null;
}

// ── Auto-response templates ─────────────────────────────────
const AUTO_REPLIES = {
  'HELP'  : 'OmniSMS — Commandes : STOP pour se désabonner, INFO pour informations, AIDE pour aide.',
  'AIDE'  : 'OmniSMS — Commandes : STOP pour se désabonner, INFO pour informations.',
  'INFO'  : 'OmniSMS — Service de messagerie premium. Visitez notre application pour plus d\'informations.',
  'STOP'  : 'Vous avez été désabonné. Répondez START pour vous réabonner.',
  'START' : 'Vous êtes maintenant abonné à OmniSMS. Répondez STOP pour vous désabonner.',
};

/**
 * Determine auto-reply text for a received message.
 * Returns null when no automatic reply is needed.
 */
function getAutoReply(text) {
  if (!text || typeof text !== 'string') return null;
  const keyword = text.trim().toUpperCase().split(/\s+/)[0];
  return AUTO_REPLIES[keyword] || null;
}

// ─────────────────────────────────────────────────────────────
// POST /api/sms/send
// ─────────────────────────────────────────────────────────────
/**
 * Send an outbound SMS via Infobip.
 *
 * Body (JSON):
 *   { to: "+22600000000", text: "Hello!", from?: "OmniSMS" }
 *
 * Authentication: Bearer JWT token required.
 * Rate-limited by global limiter (300 req / 15 min).
 */
router.post(
  '/api/sms/send',
  authenticate,
  [
    body('to')
      .trim()
      .notEmpty()
      .withMessage('Le numéro de destination est requis.')
      .matches(/^\+?[1-9]\d{6,14}$/)
      .withMessage('Numéro de téléphone invalide. Format E.164 requis (ex: +22600000000).'),
    body('text')
      .trim()
      .notEmpty()
      .withMessage('Le message est requis.')
      .isLength({ max: 1600 })
      .withMessage('Le message ne peut pas dépasser 1600 caractères.'),
    body('from')
      .optional()
      .trim()
      .isLength({ max: 15 })
      .withMessage('L\'identifiant expéditeur ne peut pas dépasser 15 caractères.'),
  ],
  async (req, res) => {
    const err = validationErrors(req, res);
    if (err) return;

    if (!infobip.isConfigured()) {
      return res.status(503).json({
        error  : 'Service SMS Infobip non configuré.',
        code   : 'INFOBIP_NOT_CONFIGURED',
        details: 'Ajoutez INFOBIP_API_KEY et INFOBIP_BASE_URL dans les variables d\'environnement Render.',
      });
    }

    const { to, text, from } = req.body;
    const userId = req.user?.uid || 'unknown';

    logger.info('[SMS/Infobip] Send request', { userId, to, textLength: text.length });

    try {
      const result = await infobip.sendSMS({ to, text, from });

      if (result.success) {
        return res.status(200).json({
          success   : true,
          messageId : result.messageId,
          status    : result.status,
          provider  : 'infobip',
          to,
        });
      }

      return res.status(502).json({
        success : false,
        error   : result.error || 'Échec de l\'envoi SMS.',
        code    : 'SMS_SEND_FAILED',
        provider: 'infobip',
      });

    } catch (e) {
      logger.error('[SMS/Infobip] Unexpected error', { error: e.message, userId });
      return res.status(500).json({
        success: false,
        error  : 'Erreur interne du serveur.',
        code   : 'SERVER_ERROR',
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// POST /webhooks/infobip
// ─────────────────────────────────────────────────────────────
/**
 * Receive inbound SMS messages and delivery reports from Infobip.
 *
 * Infobip sends two event types to this URL:
 *
 *  1. Inbound SMS (MO — Mobile Originated)
 *     { results: [{ from, to, text, messageId, receivedAt, ... }] }
 *
 *  2. Delivery report (DLR)
 *     { results: [{ messageId, to, sentAt, doneAt, status: { name }, ... }] }
 *
 * We respond 200 immediately, then process asynchronously.
 * Set this URL in Infobip portal under:
 *   Channels → SMS → Configuration → Default SMS webhook URL
 */
router.post('/webhooks/infobip', (req, res) => {
  // Always respond 200 immediately so Infobip does not retry
  res.status(200).json({ received: true });

  const payload = req.body;
  if (!payload) return;

  setImmediate(() => processInfobipWebhook(payload));
});

async function processInfobipWebhook(payload) {
  try {
    const results = payload.results || [];

    if (results.length === 0) {
      logger.debug('[Infobip/Webhook] Empty results payload — ignored');
      return;
    }

    for (const item of results) {
      // ── Delivery report ───────────────────────────────────
      if (item.status && item.sentAt && !item.text) {
        const dlr = {
          messageId: item.messageId,
          to       : item.to,
          status   : item.status?.name || item.status?.groupName || 'UNKNOWN',
          sentAt   : item.sentAt,
          doneAt   : item.doneAt,
          price    : item.price,
        };
        logger.info('[Infobip/Webhook] Delivery report', dlr);
        // TODO: persist delivery status to Firestore if needed
        continue;
      }

      // ── Inbound SMS (MO) ──────────────────────────────────
      if (item.text !== undefined) {
        const inbound = {
          from      : item.from,
          to        : item.to,
          text      : item.text,
          messageId : item.messageId,
          receivedAt: item.receivedAt,
        };
        logger.info('[Infobip/Webhook] Inbound SMS', inbound);

        // Auto-reply logic
        const replyText = getAutoReply(item.text);
        if (replyText && item.from && infobip.isConfigured()) {
          try {
            const sendResult = await infobip.sendSMS({
              to  : item.from,
              text: replyText,
            });
            if (sendResult.success) {
              logger.info('[Infobip/Webhook] Auto-reply sent', { to: item.from, messageId: sendResult.messageId });
            } else {
              logger.warn('[Infobip/Webhook] Auto-reply failed', { to: item.from, error: sendResult.error });
            }
          } catch (autoErr) {
            logger.error('[Infobip/Webhook] Auto-reply error', { error: autoErr.message });
          }
        }

        // TODO: persist inbound message to Firestore, trigger business logic, etc.
        continue;
      }

      logger.debug('[Infobip/Webhook] Unknown event type', { item });
    }
  } catch (err) {
    logger.error('[Infobip/Webhook] Processing error', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// GET /api/sms/infobip/status
// ─────────────────────────────────────────────────────────────
/**
 * Check Infobip configuration status (no auth required — used for health checks).
 */
router.get('/api/sms/infobip/status', (_req, res) => {
  const status = infobip.getStatus();
  return res.status(200).json({
    provider  : 'infobip',
    configured: status.configured,
    active    : status.configured,
    baseUrl   : status.baseUrl,
    senderId  : status.senderId,
    webhookUrl: (process.env.BACKEND_URL || 'https://omnisms-backend.onrender.com') + '/webhooks/infobip',
    endpoints : {
      send   : 'POST /api/sms/send',
      webhook: 'POST /webhooks/infobip',
      status : 'GET  /api/sms/infobip/status',
    },
  });
});

module.exports = router;
