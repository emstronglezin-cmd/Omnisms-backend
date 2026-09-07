'use strict';
/**
 * OmniSMS — Webhook SMS Gateway for Android™ (SMS Entrants)
 *
 * Application : SMS Gateway for Android™ (sms-gate.app) sur Z Fold2
 *
 * Route principale :
 *   POST /api/webhooks/sms-gateway/inbound
 *
 * Configuration dans l'app SMS Gateway (onglet Settings → Webhooks) :
 *   URL  : https://omnisms-backend.onrender.com/api/webhooks/sms-gateway/inbound
 *   Event: sms:received
 *   (Enregistrer séparément pour chaque event si nécessaire)
 *
 * Workflow complet SMS entrant via Z Fold2 :
 *
 *   Utilisateur externe
 *     ↓ SMS
 *   SIM Z Fold2
 *     ↓ capture
 *   SMS Gateway for Android™ (app Z Fold2)
 *     ↓ POST webhook ici
 *   Backend OmniSMS
 *     ↓ validateWebhookSignature (HMAC si SMS_GATEWAY_WEBHOOK_SECRET configuré)
 *     ↓ Déduplication (Redis SETNX ou Map mémoire)
 *     ↓ normalizePhone(sender) → E.164
 *     ↓ Protocole # : si message commence par "#NUMERO " → resolveUserByPhone(target)
 *     ↓ Sinon : findExternalConvByPhone(from) → ownerUid depuis external_conversations
 *     ↓ getOrCreateExternalConv(db, ownerUid, from, null, recipientNumber)
 *     ↓ db.collection('messages').add({ channel: 'sms', direction: 'inbound' })
 *     ↓ emitToUser(ownerUid, 'message:receive', payload)
 *     ↓ Si ownerUid offline → message en Firestore, récupéré à la reconnexion
 *
 * Format du webhook (event sms:received) :
 *   {
 *     "deviceId"  : "ffffffffceb0b1db0000018e937c815b",
 *     "event"     : "sms:received",
 *     "id"        : "Ey6ECgOkVVFjz3CL48B8C",        ← ID unique de l'événement
 *     "webhookId" : "LreFUt-Z3sSq0JufY9uWB",
 *     "payload"   : {
 *       "messageId"  : "abc123",                     ← ID du message (dédup)
 *       "message"    : "Bonjour Emmanuel !",
 *       "sender"     : "+22670000000",               ← numéro expéditeur
 *       "recipient"  : "+22600000000",               ← numéro SIM Z Fold2 (peut être null)
 *       "simNumber"  : 1,
 *       "receivedAt" : "2024-06-22T15:46:11.000+07:00"
 *     }
 *   }
 *
 * Signature HMAC (X-Signature) :
 *   HMAC-SHA256(rawBody + X-Timestamp, SMS_GATEWAY_WEBHOOK_SECRET)
 *   Headers : X-Signature, X-Timestamp (Unix timestamp en secondes)
 *
 * Événements gérés :
 *   sms:received   → SMS entrant (traitement complet)
 *   sms:sent       → Accusé de livraison (update Firestore)
 *   sms:delivered  → Accusé de livraison (update Firestore)
 *   sms:failed     → SMS échoué (update Firestore)
 *   sms:batch:received → Lot de SMS entrants
 *   app:started    → Z Fold2 redémarré (log uniquement)
 *   system:ping    → Ping health check (réponse 200)
 *
 * IMPORTANT : Route Infobip conservée et indépendante :
 *   POST /api/webhooks/infobip/inbound  ← reste actif en standby
 */

const express = require('express');
const router  = express.Router();

const { logger }              = require('../middleware/logger');
const { normalizePhone }      = require('../services/phoneNormalizer');
const { resolveUserByPhone }  = require('../services/userResolver');
const {
  findExternalConvByPhone,
  getOrCreateExternalConv,
  makeExternalConvId,
  updateExternalConvLastMessage,
} = require('../services/messageRouter');

/* ── Lazy imports ────────────────────────────────────────────── */
function getDb() {
  try {
    const db = require('../config/firebase');
    if (db._stub) return null;
    return db;
  } catch (_) { return null; }
}

function getEmitToUser() {
  try { return require('../services/socketService').emitToUser; } catch (_) { return () => {}; }
}

function getIO() {
  try { return require('../services/socketService').getIO(); } catch (_) { return null; }
}

function getRedis() {
  try { return require('../services/redis'); } catch (_) { return null; }
}

function getSmsGateway() {
  try { return require('../services/smsGateway'); } catch (_) { return null; }
}

/* ── Déduplication des webhooks entrants ───────────────────── */
/**
 * Vérifie et marque un ID d'événement SMS Gateway comme traité.
 * Utilise l'event ID (id du webhook) OU le messageId du payload.
 *
 * La rétry du SMS Gateway est agressive : jusqu'à 14 fois (expo backoff).
 * Sans déduplication, le même SMS peut être inséré 14 fois en Firestore.
 *
 * Stratégie :
 *  1. Redis SETNX avec TTL 24h (si Redis disponible)
 *  2. Fallback mémoire (Map) si Redis absent
 */
const _dedupGatewayStore = new Map();

async function isAlreadyProcessed(eventId) {
  if (!eventId) return false;
  const key = `omnisms:gateway:dedup:${eventId}`;

  const redis = getRedis();
  if (redis) {
    try {
      const set = await redis.setnx(key, '1');
      if (set === 1) {
        await redis.expire(key, 86400).catch(() => {});
        return false; // nouveau
      }
      return true; // doublon
    } catch (_) {
      // Redis error → fallback mémoire
    }
  }

  if (_dedupGatewayStore.has(eventId)) return true;
  _dedupGatewayStore.set(eventId, Date.now());
  // Nettoyage des entrées > 24h
  if (_dedupGatewayStore.size > 50000) {
    const cutoff = Date.now() - 86400000;
    for (const [k, ts] of _dedupGatewayStore) {
      if (ts < cutoff) _dedupGatewayStore.delete(k);
    }
  }
  return false;
}

/* ── Parsing du préfixe # ──────────────────────────────────── */
/**
 * Protocole # : premier SMS peut commencer par "#NUMERO message"
 * pour indiquer le destinataire OmniSMS.
 * Identique au protocole de infobip.inbound.js — cohérence maintenue.
 */
function parseHashPrefix(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const match   = trimmed.match(/^[#]?\s*(\+?[\d]{6,15})\s+([\s\S]+)$/);
  if (!match) return null;

  const rawPhone  = match[1];
  const cleanText = match[2].trim();
  const e164      = normalizePhone(rawPhone);

  if (!e164 || !cleanText) return null;
  return { targetPhone: e164, cleanText };
}

/* ── Mise à jour statut livraison ───────────────────────────── */
/**
 * Traite les événements sms:sent, sms:delivered, sms:failed, sms:cancelled.
 * Met à jour le statut dans Firestore (messages + external_conversations).
 */
async function updateDeliveryStatus(event, payload, db) {
  if (!db) return;

  const gwMessageId = payload?.messageId;
  if (!gwMessageId) return;

  const statusMap = {
    'sms:sent'      : 'sent',
    'sms:delivered' : 'delivered',
    'sms:failed'    : 'failed',
    'sms:cancelled' : 'cancelled',
  };
  const newStatus = statusMap[event];
  if (!newStatus) return;

  try {
    // Chercher le message par son ID Gateway
    // Le message a été sauvegardé avec smsMessageId = gatewayMessageId = "omnisms-{firestoreId}"
    // On cherche donc par smsMessageId (format "omnisms-{id}") ou directement par gwMessageId
    const snap = await db.collection('messages')
      .where('smsMessageId', '==', gwMessageId)
      .limit(1)
      .get();

    if (!snap.empty) {
      const updateData = {
        status   : newStatus,
        updatedAt: new Date().toISOString(),
      };
      if (event === 'sms:failed')    updateData.smsError = payload?.reason || 'unknown';
      if (event === 'sms:delivered') updateData.deliveredAt = payload?.deliveredAt || null;
      if (event === 'sms:sent')      updateData.sentAt     = payload?.sentAt || null;

      await snap.docs[0].ref.update(updateData);

      logger.info('[SmsGateway/DLR] Statut message mis à jour', {
        gwMessageId,
        event,
        newStatus,
        docId: snap.docs[0].id,
      });
    } else {
      // Essayer avec le format "omnisms-{id}" préfixé
      logger.debug('[SmsGateway/DLR] Message non trouvé par smsMessageId', { gwMessageId });
    }
  } catch (err) {
    logger.warn('[SmsGateway/DLR] Update failed', { error: err.message, gwMessageId });
  }

  // Émettre l'événement Socket.IO pour les clients connectés
  const io = getIO();
  if (io) {
    io.emit('sms:delivery', {
      messageId : gwMessageId,
      status    : newStatus,
      event,
      provider  : 'sms_gateway',
      timestamp : new Date().toISOString(),
    });
  }
}

/* ── Traitement SMS entrant (sms:received) ──────────────────── */
async function processSmsReceived(webhookBody) {
  const db      = getDb();
  const emitFn  = getEmitToUser();
  const io      = getIO();

  const {
    deviceId,
    event,
    id: eventId,        // ID unique de l'événement webhook
    webhookId,
    payload,
  } = webhookBody || {};

  if (!payload) {
    logger.debug('[SmsGateway/Inbound] Payload manquant — ignoré');
    return;
  }

  const {
    messageId: gwMessageId,
    message  : textRaw,
    sender   : senderRaw,
    recipient: recipientRaw,
    simNumber,
    receivedAt,
  } = payload;

  // ── Événements non-SMS (livraison, ping, app:started) ────────
  if (event === 'system:ping' || event === 'app:started') {
    logger.info('[SmsGateway/Webhook] Système event reçu', { event, deviceId });
    return;
  }

  // ── Statuts de livraison ─────────────────────────────────────
  if (['sms:sent', 'sms:delivered', 'sms:failed', 'sms:cancelled'].includes(event)) {
    logger.info('[SmsGateway/DLR] Événement livraison', {
      event,
      gwMessageId,
      to: payload?.recipient,
    });
    await updateDeliveryStatus(event, payload, db);
    return;
  }

  // ── SMS entrant (sms:received ou sms:batch:received) ─────────
  // Utiliser l'eventId (id du webhook) comme clé de déduplication principale
  // Le gwMessageId peut aussi être utilisé en clé secondaire
  const dedupKey = eventId || gwMessageId;
  if (dedupKey) {
    const duplicate = await isAlreadyProcessed(dedupKey);
    if (duplicate) {
      logger.info('[SmsGateway/Inbound] Doublon ignoré', {
        eventId   : dedupKey,
        gwMessageId,
        sender    : senderRaw ? senderRaw.replace(/\d{4}$/, '****') : null,
      });
      return;
    }
  }

  if (textRaw === undefined) {
    logger.debug('[SmsGateway/Inbound] Événement sans texte', { event, keys: Object.keys(payload || {}) });
    return;
  }

  const fromE164    = normalizePhone(senderRaw)    || senderRaw    || '';
  const recipientE164 = normalizePhone(recipientRaw) || recipientRaw || null;

  logger.info('[SmsGateway/Inbound] SMS reçu', {
    from      : fromE164.replace(/\d{4}$/, '****'),
    recipient : recipientE164 ? recipientE164.replace(/\d{4}$/, '****') : null,
    textLength: textRaw.length,
    gwMessageId,
    simNumber,
    receivedAt,
    deviceId,
  });

  // ─────────────────────────────────────────────────────────────
  // ÉTAPE 1 : Trouver le destinataire OmniSMS (ownerUid)
  // ─────────────────────────────────────────────────────────────
  // Cas A : Le texte commence par # → nouveau protocole d'adressage
  // Cas B : Conversation externe existante → retrouver le propriétaire
  // Cas C : Dernier recours via le numéro SIM (recipient)

  let ownerUid  = null;
  let convId    = null;
  let finalText = textRaw;
  let isNewConv = false;

  // Cas A : Protocole #
  const hashParsed = parseHashPrefix(textRaw);
  if (hashParsed) {
    logger.info('[SmsGateway/Inbound] Protocole # détecté', {
      targetPhone: hashParsed.targetPhone.replace(/\d{4}$/, '****'),
    });

    const targetUser = await resolveUserByPhone(hashParsed.targetPhone);
    if (targetUser.found) {
      ownerUid  = targetUser.uid;
      finalText = hashParsed.cleanText;
      isNewConv = true;
      logger.info('[SmsGateway/Inbound] # protocol → OmniSMS user trouvé', {
        targetUid: ownerUid,
      });
    } else {
      logger.warn('[SmsGateway/Inbound] # protocol : numéro cible non OmniSMS', {
        targetPhone: hashParsed.targetPhone.replace(/\d{4}$/, '****'),
      });
    }
  }

  // Cas B : Conversation externe existante
  if (!ownerUid) {
    const existingConv = await findExternalConvByPhone(db, fromE164, recipientE164);
    if (existingConv) {
      ownerUid = existingConv.ownerUid;
      convId   = existingConv.conversationId;
      logger.info('[SmsGateway/Inbound] Conversation externe trouvée', {
        from    : fromE164.replace(/\d{4}$/, '****'),
        ownerUid,
        convId,
      });
    }
  }

  // Cas C : Résoudre via le numéro SIM destinataire (recipient de l'app)
  if (!ownerUid && recipientE164) {
    const toUser = await resolveUserByPhone(recipientE164);
    if (toUser.found) {
      ownerUid  = toUser.uid;
      isNewConv = true;
      logger.info('[SmsGateway/Inbound] Owner résolu via numéro SIM', {
        recipient: recipientE164.replace(/\d{4}$/, '****'),
        ownerUid,
      });
    }
  }

  if (!ownerUid) {
    logger.warn('[SmsGateway/Inbound] Impossible de trouver le destinataire OmniSMS', {
      from     : fromE164.replace(/\d{4}$/, '****'),
      recipient: recipientE164 ? recipientE164.replace(/\d{4}$/, '****') : null,
      hint     : 'Associer le numéro SIM du Z Fold2 à un compte OmniSMS, ou utiliser le protocole #NUMERO message',
    });
  }

  // ─────────────────────────────────────────────────────────────
  // ÉTAPE 2 : Créer/récupérer la conversation externe
  // ─────────────────────────────────────────────────────────────
  if (ownerUid && !convId) {
    const extConv = await getOrCreateExternalConv(
      db, ownerUid, fromE164, null, recipientE164
    );
    convId = extConv?.conversationId || makeExternalConvId(ownerUid, fromE164);
  }

  // Fallback conversationId si aucun owner
  if (!convId) {
    convId = `sms-gateway-inbound-${fromE164.replace(/\W/g, '')}-${Date.now()}`;
  }

  // ─────────────────────────────────────────────────────────────
  // ÉTAPE 3 : Stocker le message en Firestore
  // ─────────────────────────────────────────────────────────────
  const nowIso  = new Date().toISOString();
  const msgDoc  = {
    channel         : 'sms',
    direction       : 'inbound',
    senderId        : fromE164,
    receiverId      : ownerUid || recipientE164 || deviceId || 'unknown',
    conversationId  : convId,
    content         : finalText,
    type            : 'text',
    smsMessageId    : gwMessageId || null,
    from            : fromE164,
    to              : recipientE164 || null,
    status          : 'delivered',
    smsProvider     : 'sms_gateway',
    deviceId        : deviceId || null,
    simNumber       : simNumber || null,
    createdAt       : receivedAt || nowIso,
    updatedAt       : nowIso,
  };

  let savedMsgId = null;
  if (db) {
    try {
      const ref = await db.collection('messages').add(msgDoc);
      savedMsgId = ref.id;
      if (ownerUid) {
        await updateExternalConvLastMessage(db, convId, finalText, gwMessageId || null);
      }
      logger.info('[SmsGateway/Inbound] Message stocké Firestore', {
        id      : savedMsgId,
        convId,
        ownerUid,
      });
    } catch (dbErr) {
      logger.error('[SmsGateway/Inbound] Erreur stockage Firestore', { error: dbErr.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ÉTAPE 4 : Notifier le propriétaire via Socket.IO
  // ─────────────────────────────────────────────────────────────
  const socketPayload = {
    id            : savedMsgId || `gw-inbound-${Date.now()}`,
    type          : 'text',
    channel       : 'sms',
    direction     : 'inbound',
    senderId      : fromE164,
    receiverId    : ownerUid || recipientE164 || 'unknown',
    conversationId: convId,
    content       : finalText,
    from          : fromE164,
    to            : recipientE164 || null,
    status        : 'delivered',
    smsProvider   : 'sms_gateway',
    smsMessageId  : gwMessageId || null,
    createdAt     : receivedAt || nowIso,
    timestamp     : nowIso,
  };

  if (ownerUid) {
    emitFn(ownerUid, 'message:receive', socketPayload);
    emitFn(ownerUid, 'new_message',     socketPayload); // rétrocompat
    logger.info('[SmsGateway/Inbound] message:receive émis', {
      uid   : ownerUid,
      from  : fromE164.replace(/\d{4}$/, '****'),
      convId,
    });
  }

  // Broadcast général (debug, clients non identifiés)
  if (io) {
    io.emit('sms:inbound', socketPayload);
  }
}

/* ── Traitement lot (sms:batch:received) ────────────────────── */
async function processBatchReceived(webhookBody) {
  const messages = webhookBody?.payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    logger.debug('[SmsGateway/Batch] Batch vide');
    return;
  }

  logger.info('[SmsGateway/Batch] Traitement lot', { count: messages.length });

  for (const msg of messages) {
    // Construire un corps de webhook individuel pour chaque message
    await processSmsReceived({
      deviceId : webhookBody.deviceId,
      event    : 'sms:received',
      id       : `${webhookBody.id}-${msg.messageId}`,
      webhookId: webhookBody.webhookId,
      payload  : msg,
    });
  }
}

/* ── Dispatcher principal ───────────────────────────────────── */
async function processGatewayWebhook(body) {
  const { event } = body || {};

  try {
    switch (event) {
      case 'sms:received':
        await processSmsReceived(body);
        break;

      case 'sms:batch:received':
        await processBatchReceived(body);
        break;

      case 'sms:sent':
      case 'sms:delivered':
      case 'sms:failed':
      case 'sms:cancelled':
        await processSmsReceived(body); // délègue au handler qui traite aussi les DLR
        break;

      case 'system:ping':
        logger.info('[SmsGateway/Webhook] Ping reçu', {
          deviceId: body.deviceId,
          health  : body.payload?.health,
        });
        break;

      case 'app:started':
        logger.info('[SmsGateway/Webhook] App Z Fold2 démarrée', {
          deviceId: body.deviceId,
          simCards: body.payload?.simCards,
        });
        break;

      default:
        logger.debug('[SmsGateway/Webhook] Événement inconnu', { event, keys: Object.keys(body || {}) });
    }
  } catch (err) {
    logger.error('[SmsGateway/Webhook] Erreur traitement', {
      error : err.message,
      event,
      stack : err.stack,
    });
  }
}

/* ─────────────────────────────────────────────────────────────
   POST /api/webhooks/sms-gateway/inbound
   Route principale SMS entrant du Z Fold2
   ─────────────────────────────────────────────────────────── */
router.post('/sms-gateway/inbound', (req, res) => {
  const smsGateway = getSmsGateway();

  // Validation de la signature HMAC si configurée
  if (smsGateway && !smsGateway.validateWebhookSignature(req)) {
    logger.warn('[SmsGateway/Inbound] Signature invalide — requête rejetée');
    return res.status(401).json({
      error: 'Signature invalide.',
      code : 'INVALID_SIGNATURE',
    });
  }

  // Répondre 200 IMMÉDIATEMENT pour stopper les retries du Gateway
  // (le Gateway retente jusqu'à 14 fois avec backoff expo si pas de 2xx)
  res.status(200).json({
    received : true,
    provider : 'sms_gateway',
    timestamp: new Date().toISOString(),
  });

  // Traitement asynchrone (ne bloque pas la réponse 200)
  setImmediate(() => processGatewayWebhook(req.body || {}));
});

/* ─────────────────────────────────────────────────────────────
   GET /api/webhooks/sms-gateway/status
   Health check + configuration guide
   ─────────────────────────────────────────────────────────── */
router.get('/sms-gateway/status', (_req, res) => {
  const smsGateway = getSmsGateway();
  const backendUrl = process.env.RENDER_EXTERNAL_URL || 'https://omnisms-backend.onrender.com';

  return res.status(200).json({
    status       : 'active',
    service      : 'SMS Gateway for Android™ Inbound Webhook v1',
    webhookUrl   : `${backendUrl}/api/webhooks/sms-gateway/inbound`,
    provider     : smsGateway ? smsGateway.getStatus() : { configured: false },
    configuration: {
      step1: 'Installer SMS Gateway for Android™ sur Z Fold2',
      step2: 'Se connecter au compte Cloud (onglet Home) — noter login, password, deviceId',
      step3: `Configurer le webhook dans Settings → Webhooks : URL = ${backendUrl}/api/webhooks/sms-gateway/inbound, Event = sms:received`,
      step4: 'Récupérer la Signing Key (Settings → Webhooks → Signing Key) → SMS_GATEWAY_WEBHOOK_SECRET',
      step5: 'Configurer les env vars Render : SMS_GATEWAY_LOGIN, SMS_GATEWAY_PASSWORD, SMS_GATEWAY_DEVICE_ID, SMS_GATEWAY_WEBHOOK_SECRET',
    },
    envVarsRequired: [
      'SMS_GATEWAY_LOGIN',
      'SMS_GATEWAY_PASSWORD',
    ],
    envVarsRecommended: [
      'SMS_GATEWAY_DEVICE_ID',
      'SMS_GATEWAY_WEBHOOK_SECRET',
      'SMS_GATEWAY_API_URL (défaut: https://api.sms-gate.app/3rdparty/v1)',
    ],
  });
});

module.exports = router;
