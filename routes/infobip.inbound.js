'use strict';
/**
 * OmniSMS — Webhook Infobip SMS Entrants
 *
 * Route :
 *   POST /api/webhooks/infobip/inbound
 *
 * Workflow complet :
 *   Utilisateur → SMS → Numéro Infobip → POST ici → Firestore + Socket.IO
 *
 * Configurer dans Infobip portal :
 *   Channels → SMS → Configuration → Default inbound webhook URL
 *   → https://omnisms-backend.onrender.com/api/webhooks/infobip/inbound
 *
 * Infobip envoie deux types d'événements :
 *   1. SMS entrant  (MO) : { results: [{ from, to, text, messageId, receivedAt }] }
 *   2. Rapport livraison : { results: [{ messageId, status, sentAt, doneAt }] }
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { logger } = require('../middleware/logger');

/* ── Lazy imports ────────────────────────────────────────────── */
function getDb() {
  try {
    const db = require('../config/firebase');
    if (db._stub) return null;
    return db;
  } catch (_) { return null; }
}

function getIO() {
  try { return require('../services/socketService').getIO(); } catch (_) { return null; }
}

function getEmitToUser() {
  try { return require('../services/socketService').emitToUser; } catch (_) { return () => {}; }
}

/* ── Validation signature Infobip (optionnelle) ─────────────── */
/**
 * Infobip peut signer les webhooks avec HMAC-SHA256.
 * Variable env : INFOBIP_WEBHOOK_SECRET
 * Header      : Authorization ou X-Hub-Signature
 * Si absent : on accepte (pas de rejet — Infobip n'impose pas la signature)
 */
function validateInfobipSignature(req) {
  const secret = process.env.INFOBIP_WEBHOOK_SECRET;
  if (!secret) return true;  // pas de secret configuré → accepter

  const sig = req.headers['authorization'] || req.headers['x-hub-signature'] || '';
  if (!sig) {
    logger.warn('[Infobip/Inbound] Signature manquante alors que INFOBIP_WEBHOOK_SECRET est configuré.');
    return true;  // Infobip ne signe pas toujours — on accepte en mode dégradé
  }

  const raw    = req.rawBody || JSON.stringify(req.body);
  const hmac   = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const sigVal = sig.replace(/^sha256=/, '').toLowerCase();

  try {
    const bufA = Buffer.from(hmac,   'hex');
    const bufB = Buffer.from(sigVal, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_) {
    return false;
  }
}

/* ── Auto-reply keywords ──────────────────────────────────────── */
const AUTO_REPLIES = {
  'HELP' : 'OmniSMS — Commandes : STOP pour se désabonner, INFO pour informations.',
  'AIDE' : 'OmniSMS — Commandes : STOP pour se désabonner, INFO pour informations.',
  'INFO' : 'OmniSMS — Service de messagerie premium. Visitez notre application.',
  'STOP' : 'Vous avez été désabonné. Répondez START pour vous réabonner.',
  'START': 'Vous êtes maintenant abonné à OmniSMS.',
};

function getAutoReply(text) {
  if (!text || typeof text !== 'string') return null;
  const keyword = text.trim().toUpperCase().split(/\s+/)[0];
  return AUTO_REPLIES[keyword] || null;
}

/* ── Stocker SMS entrant en Firestore ───────────────────────── */
async function storeInboundSms(item, db) {
  if (!db) return null;

  const now = new Date().toISOString();
  const doc = {
    channel    : 'sms',
    direction  : 'inbound',
    from       : item.from       || null,
    to         : item.to         || null,
    content    : item.text       || '',
    type       : 'text',
    messageId  : item.messageId  || null,
    receivedAt : item.receivedAt || now,
    // identifiants conversation basés sur les numéros
    conversationId: `sms-${[item.from, item.to].sort().join('-')}`,
    senderId   : item.from       || null,    // numéro expéditeur
    receiverId : item.to         || null,    // numéro destination (notre numéro)
    status     : 'delivered',
    createdAt  : now,
    updatedAt  : now,
  };

  try {
    const ref = await db.collection('messages').add(doc);
    logger.info('[Infobip/Inbound] Message stocké Firestore', { id: ref.id, from: item.from });
    return { id: ref.id, ...doc };
  } catch (err) {
    logger.error('[Infobip/Inbound] Erreur Firestore', { error: err.message });
    return doc;
  }
}

/* ── Trouver l'utilisateur OmniSMS propriétaire du numéro ── */
async function findUserByPhone(phone, db) {
  if (!db || !phone) return null;
  try {
    const snap = await db.collection('users')
      .where('phone', '==', phone)
      .limit(1)
      .get();
    if (!snap.empty) {
      return { uid: snap.docs[0].id, ...snap.docs[0].data() };
    }
    // Essayer avec le champ phoneNumber (normalisation)
    const snap2 = await db.collection('users')
      .where('phoneNumber', '==', phone)
      .limit(1)
      .get();
    if (!snap2.empty) return { uid: snap2.docs[0].id, ...snap2.docs[0].data() };
    return null;
  } catch (_) { return null; }
}

/* ── Mettre à jour le rapport de livraison ─────────────────── */
async function updateDeliveryStatus(item, db) {
  if (!db || !item.messageId) return;
  try {
    const snap = await db.collection('messages')
      .where('smsMessageId', '==', item.messageId)
      .limit(1)
      .get();

    if (!snap.empty) {
      await snap.docs[0].ref.update({
        status   : (item.status?.name || item.status?.groupName || 'unknown').toLowerCase(),
        doneAt   : item.doneAt    || null,
        updatedAt: new Date().toISOString(),
      });
      logger.info('[Infobip/DLR] Rapport livraison mis à jour', {
        messageId: item.messageId, status: item.status?.name,
      });
    }
  } catch (err) {
    logger.warn('[Infobip/DLR] Update failed', { error: err.message });
  }
}

/* ── Processeur principal (async, après réponse 200) ────────── */
async function processInfobipInbound(payload, rawBody) {
  const db      = getDb();
  const emitFn  = getEmitToUser();
  const io      = getIO();

  try {
    const results = payload.results || [];
    if (results.length === 0) {
      logger.debug('[Infobip/Inbound] Payload vide — ignoré');
      return;
    }

    for (const item of results) {
      /* ── Rapport de livraison (DLR) ─────────────────────── */
      if (item.messageId && item.status && !item.text) {
        logger.info('[Infobip/DLR] Rapport livraison reçu', {
          messageId: item.messageId,
          status   : item.status?.name || item.status?.groupName,
          to       : item.to,
          doneAt   : item.doneAt,
        });

        await updateDeliveryStatus(item, db);

        // Notifier via Socket.IO si un user est connecté
        if (io) {
          io.emit('sms:delivery', {
            messageId: item.messageId,
            status   : item.status?.name || 'unknown',
            to       : item.to,
            doneAt   : item.doneAt,
            timestamp: new Date().toISOString(),
          });
        }
        continue;
      }

      /* ── SMS entrant (MO — Mobile Originated) ───────────── */
      if (item.text !== undefined) {
        logger.info('[Infobip/Inbound] SMS reçu', {
          from      : item.from,
          to        : item.to,
          text      : item.text?.substring(0, 80),
          messageId : item.messageId,
          receivedAt: item.receivedAt,
        });

        // 1. Stocker en Firestore
        const storedMsg = await storeInboundSms(item, db);

        // 2. Trouver l'utilisateur OmniSMS à notifier
        //    (propriétaire du numéro Infobip "to")
        const owner = await findUserByPhone(item.to, db);

        // 3. Émettre new_message via Socket.IO
        const socketPayload = {
          type          : 'new_message',
          channel       : 'sms',
          direction     : 'inbound',
          id            : storedMsg?.id || null,
          from          : item.from,
          to            : item.to,
          content       : item.text,
          conversationId: storedMsg?.conversationId || `sms-${[item.from, item.to].sort().join('-')}`,
          receivedAt    : item.receivedAt || new Date().toISOString(),
          messageId     : item.messageId,
          timestamp     : new Date().toISOString(),
        };

        // Émettre à l'utilisateur propriétaire du numéro (si trouvé)
        if (owner?.uid) {
          emitFn(owner.uid, 'new_message', socketPayload);
          logger.info('[Infobip/Inbound] new_message émis', { uid: owner.uid, from: item.from });
        }

        // Émettre aussi à tous (broadcast) pour les cas sans mapping utilisateur
        if (io) {
          io.emit('sms:inbound', socketPayload);
        }

        // 4. Auto-reply si mot-clé
        const replyText = getAutoReply(item.text);
        if (replyText && item.from) {
          let infobip = null;
          try { infobip = require('../services/infobip'); } catch (_) {}

          if (infobip && infobip.isConfigured()) {
            try {
              const replyRes = await infobip.sendSMS({ to: item.from, text: replyText });
              if (replyRes.success) {
                logger.info('[Infobip/Inbound] Auto-reply envoyé', { to: item.from, messageId: replyRes.messageId });
              }
            } catch (autoErr) {
              logger.error('[Infobip/Inbound] Auto-reply error', { error: autoErr.message });
            }
          }
        }
        continue;
      }

      logger.debug('[Infobip/Inbound] Événement inconnu', { keys: Object.keys(item) });
    }
  } catch (err) {
    logger.error('[Infobip/Inbound] Erreur traitement', { error: err.message, stack: err.stack });
  }
}

/* ─────────────────────────────────────────────────────────────
   POST /api/webhooks/infobip/inbound
   ─────────────────────────────────────────────────────────── */
router.post('/infobip/inbound', (req, res) => {
  // Valider la signature si configurée
  if (!validateInfobipSignature(req)) {
    logger.warn('[Infobip/Inbound] Signature invalide — requête rejetée');
    return res.status(401).json({ error: 'Signature invalide.', code: 'INVALID_SIGNATURE' });
  }

  // Répondre 200 IMMÉDIATEMENT pour éviter les retries Infobip
  res.status(200).json({ received: true, timestamp: new Date().toISOString() });

  // Traitement asynchrone
  const rawBody = req.rawBody || '';
  setImmediate(() => processInfobipInbound(req.body || {}, rawBody));
});

/* ─────────────────────────────────────────────────────────────
   POST /api/webhooks/infobip      (rétrocompat ancienne URL)
   ─────────────────────────────────────────────────────────── */
router.post('/infobip', (req, res) => {
  if (!validateInfobipSignature(req)) {
    return res.status(401).json({ error: 'Signature invalide.', code: 'INVALID_SIGNATURE' });
  }
  res.status(200).json({ received: true, timestamp: new Date().toISOString() });
  const rawBody = req.rawBody || '';
  setImmediate(() => processInfobipInbound(req.body || {}, rawBody));
});

/* ─────────────────────────────────────────────────────────────
   GET /api/webhooks/infobip/inbound/status
   Vérification que le webhook est opérationnel
   ─────────────────────────────────────────────────────────── */
router.get('/infobip/inbound/status', (_req, res) => {
  let infobip = null;
  try { infobip = require('../services/infobip'); } catch (_) {}

  return res.status(200).json({
    status     : 'active',
    service    : 'Infobip Inbound Webhook',
    webhookUrl : `${process.env.RENDER_EXTERNAL_URL || 'https://omnisms-backend.onrender.com'}/api/webhooks/infobip/inbound`,
    infobip    : {
      configured   : infobip?.isConfigured() || false,
      signatureMode: process.env.INFOBIP_WEBHOOK_SECRET ? 'HMAC-SHA256' : 'none',
    },
    firestoreEnabled: !!getDb(),
    socketIOEnabled : !!getIO(),
    instructions: [
      '1. Connectez-vous sur https://portal.infobip.com',
      '2. Channels → SMS → Configuration',
      '3. Default inbound webhook URL → https://omnisms-backend.onrender.com/api/webhooks/infobip/inbound',
      '4. Optionnel: configurez INFOBIP_WEBHOOK_SECRET pour la validation HMAC',
    ],
  });
});

module.exports = router;
