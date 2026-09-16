'use strict';
/**
 * OmniSMS — Webhook INfiniReach (SMS Entrants)
 *
 * Fournisseur : INfiniReach (https://api.infinireach.io)
 * Transport   : INfiniReach → Samsung Z Fold2 → SIM → réseau SMS (et retour)
 *
 * Route principale :
 *   POST /api/webhooks/sms-gateway/inbound
 *
 * Configuration dans l'app INfiniReach sur Z Fold2 :
 *   URL webhook : https://omnisms-backend.onrender.com/api/webhooks/sms-gateway/inbound
 *   Events      : message.inbound (+ message.delivered, message.failed optionnel)
 *
 * Workflow complet SMS entrant via INfiniReach Z Fold2 :
 *
 *   Utilisateur externe
 *     ↓ SMS
 *   SIM Z Fold2
 *     ↓ capture
 *   App INfiniReach (Z Fold2)
 *     ↓ POST webhook ici
 *   Backend OmniSMS
 *     ↓ validateWebhookSignature (HMAC si INFINIREACH_WEBHOOK_SECRET configuré)
 *     ↓ Déduplication (Redis SETNX ou Map mémoire) — clé = data.messageId
 *     ↓ normalizePhone(data.from) → E.164
 *     ↓ Protocole # : si message commence par "#NUMERO " → resolveUserByPhone(target)
 *     ↓ Sinon : findExternalConvByPhone(from) → ownerUid depuis external_conversations
 *     ↓ getOrCreateExternalConv(db, ownerUid, from, null, recipientNumber)
 *     ↓ db.collection('messages').add({ channel: 'sms', direction: 'inbound' })
 *     ↓ emitToUser(ownerUid, 'message:receive', payload)
 *     ↓ Si ownerUid offline → message en Firestore, récupéré à la reconnexion
 *
 * Format du webhook INfiniReach (event message.inbound) :
 *   {
 *     "event"     : "message.inbound",
 *     "timestamp" : "2024-06-22T15:46:11.000Z",
 *     "data"      : {
 *       "messageId" : "ir-msg-abc123",         ← ID unique du message (dédup)
 *       "direction" : "inbound",
 *       "from"      : "+22670000000",           ← numéro expéditeur
 *       "to"        : "+22600000000",           ← numéro SIM Z Fold2
 *       "body"      : "Bonjour Emmanuel !",     ← contenu SMS
 *       "deviceId"  : "zfold2-device-xxx",
 *       "timestamp" : "2024-06-22T15:46:11.000Z",
 *       "status"    : "delivered"
 *     }
 *   }
 *
 * Événements DLR (statuts sortants) :
 *   message.sent, message.delivered, message.failed
 *
 * Signature HMAC (optionnelle, premier test sans secret) :
 *   INFINIREACH_WEBHOOK_SECRET non configuré → mode permissif (accepte tout)
 *   INFINIREACH_WEBHOOK_SECRET configuré     → HMAC-SHA256 via validateWebhookSignature()
 *
 * Événements gérés :
 *   message.inbound   → SMS entrant (traitement complet)
 *   message.sent      → Accusé envoi (update Firestore)
 *   message.delivered → Accusé livraison (update Firestore)
 *   message.failed    → SMS échoué (update Firestore)
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
 * Vérifie et marque un ID de message INfiniReach comme traité.
 * Utilise data.messageId comme clé principale.
 *
 * INfiniReach peut réessayer plusieurs fois si le webhook échoue.
 * Sans déduplication, le même SMS peut être inséré plusieurs fois.
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
 * Traite les événements message.sent, message.delivered, message.failed.
 * Met à jour le statut dans Firestore (messages + external_conversations).
 *
 * INfiniReach DLR payload:
 *   {
 *     "event": "message.delivered",
 *     "data": {
 *       "messageId": "ir-xxx",     ← ID gateway (correspond à externalId=omnisms-{firestoreId})
 *       "status": "delivered",
 *       ...
 *     }
 *   }
 */
async function updateDeliveryStatus(event, data, db) {
  if (!db) return;

  // data.messageId = ID INfiniReach du message sortant
  // Lors de l'envoi, on a positionné externalId = "omnisms-{firestoreId}"
  // INfiniReach renvoie cet externalId dans les DLR events
  const gwMessageId = data?.messageId || data?.externalId;
  if (!gwMessageId) return;

  const statusMap = {
    'message.sent'      : 'sent',
    'message.delivered' : 'delivered',
    'message.failed'    : 'failed',
  };
  const newStatus = statusMap[event];
  if (!newStatus) return;

  try {
    // Chercher le message par smsMessageId (= gatewayMessageId retourné au moment de l'envoi)
    const snap = await db.collection('messages')
      .where('smsMessageId', '==', gwMessageId)
      .limit(1)
      .get();

    if (!snap.empty) {
      const updateData = {
        status   : newStatus,
        updatedAt: new Date().toISOString(),
      };
      if (event === 'message.failed')    updateData.smsError   = data?.reason || data?.error || 'unknown';
      if (event === 'message.delivered') updateData.deliveredAt = data?.deliveredAt || data?.timestamp || null;
      if (event === 'message.sent')      updateData.sentAt      = data?.sentAt     || data?.timestamp || null;

      await snap.docs[0].ref.update(updateData);

      logger.info('[INfiniReach/DLR] Statut message mis à jour', {
        gwMessageId,
        event,
        newStatus,
        docId: snap.docs[0].id,
      });
    } else {
      logger.debug('[INfiniReach/DLR] Message non trouvé par smsMessageId', { gwMessageId });
    }
  } catch (err) {
    logger.warn('[INfiniReach/DLR] Update failed', { error: err.message, gwMessageId });
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

  logger.info('[INfiniReach] status:' + newStatus, {
    gwMessageId,
    event,
  });
}

/* ── Traitement SMS entrant (message.inbound) ───────────────── */
/**
 * Mappe le payload INfiniReach vers le format interne OmniSMS.
 *
 * INfiniReach payload (body.data.*) :
 *   data.messageId  → clé déduplication principale
 *   data.from       → expéditeur (E.164)
 *   data.to         → destinataire = numéro SIM Z Fold2
 *   data.body       → texte du SMS
 *   data.deviceId   → ID device INfiniReach
 *   data.timestamp  → horodatage réception
 *   data.status     → statut INfiniReach (ex: "delivered")
 */
async function processSmsReceived(webhookBody) {
  const db      = getDb();
  const emitFn  = getEmitToUser();
  const io      = getIO();

  const event    = webhookBody?.event;
  const data     = webhookBody?.data || {};

  // ── Extraction des champs INfiniReach ───────────────────────
  const {
    messageId : gwMessageId,   // ID unique INfiniReach — clé de déduplication
    from      : senderRaw,     // numéro expéditeur
    to        : recipientRaw,  // numéro SIM Z Fold2
    body      : textRaw,       // contenu SMS
    deviceId,                  // device ID INfiniReach
    timestamp : receivedAt,    // horodatage
    status    : msgStatus,     // statut INfiniReach
    direction,                 // "inbound"
  } = data;

  // ── Déduplication ────────────────────────────────────────────
  // Utiliser data.messageId comme clé principale (recommandé INfiniReach)
  const dedupKey = gwMessageId;
  if (dedupKey) {
    const duplicate = await isAlreadyProcessed(dedupKey);
    if (duplicate) {
      logger.info('[INfiniReach] webhook:duplicate', {
        messageId : dedupKey,
        sender    : senderRaw ? senderRaw.replace(/\d{4}$/, '****') : null,
      });
      return;
    }
  }

  if (textRaw === undefined || textRaw === null) {
    logger.debug('[INfiniReach] webhook:received Événement sans texte', {
      event,
      keys: Object.keys(data),
    });
    return;
  }

  const fromE164      = normalizePhone(senderRaw)    || senderRaw    || '';
  const recipientE164 = normalizePhone(recipientRaw) || recipientRaw || null;

  logger.info('[INfiniReach] webhook:inbound', {
    from      : fromE164.replace(/\d{4}$/, '****'),
    to        : recipientE164 ? recipientE164.replace(/\d{4}$/, '****') : null,
    textLength: String(textRaw).length,
    messageId : gwMessageId,
    deviceId,
    receivedAt,
    direction,
  });

  // ─────────────────────────────────────────────────────────────
  // ÉTAPE 1 : Trouver le destinataire OmniSMS (ownerUid)
  // ─────────────────────────────────────────────────────────────
  // Cas A : Le texte commence par # → protocole d'adressage direct
  // Cas B : Conversation externe existante → retrouver le propriétaire
  // Cas C : Dernier recours via le numéro SIM (to = numéro destinataire)

  let ownerUid  = null;
  let convId    = null;
  let finalText = String(textRaw);
  let isNewConv = false;

  // Cas A : Protocole #
  const hashParsed = parseHashPrefix(finalText);
  if (hashParsed) {
    logger.info('[INfiniReach] webhook:inbound Protocole # détecté', {
      targetPhone: hashParsed.targetPhone.replace(/\d{4}$/, '****'),
    });

    const targetUser = await resolveUserByPhone(hashParsed.targetPhone);
    if (targetUser.found) {
      ownerUid  = targetUser.uid;
      finalText = hashParsed.cleanText;
      isNewConv = true;
      logger.info('[INfiniReach] webhook:inbound # protocol → OmniSMS user trouvé', {
        targetUid: ownerUid,
      });
    } else {
      logger.warn('[INfiniReach] webhook:inbound # protocol : numéro cible non OmniSMS', {
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
      logger.info('[INfiniReach] webhook:inbound Conversation externe trouvée', {
        from    : fromE164.replace(/\d{4}$/, '****'),
        ownerUid,
        convId,
      });
    }
  }

  // Cas C : Résoudre via le numéro SIM destinataire
  if (!ownerUid && recipientE164) {
    const toUser = await resolveUserByPhone(recipientE164);
    if (toUser.found) {
      ownerUid  = toUser.uid;
      isNewConv = true;
      logger.info('[INfiniReach] webhook:inbound Owner résolu via numéro SIM', {
        to      : recipientE164.replace(/\d{4}$/, '****'),
        ownerUid,
      });
    }
  }

  if (!ownerUid) {
    logger.warn('[INfiniReach] webhook:inbound Impossible de trouver le destinataire OmniSMS', {
      from     : fromE164.replace(/\d{4}$/, '****'),
      to       : recipientE164 ? recipientE164.replace(/\d{4}$/, '****') : null,
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
    convId = `sms-infinireach-inbound-${fromE164.replace(/\W/g, '')}-${Date.now()}`;
  }

  // ─────────────────────────────────────────────────────────────
  // ÉTAPE 3 : Stocker le message en Firestore
  // ─────────────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  const msgDoc = {
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
    smsProvider     : 'sms_gateway',          // identique à l'ancien format → aucune migration nécessaire
    deviceId        : deviceId || null,
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
      logger.info('[INfiniReach] webhook:inbound Message stocké Firestore', {
        id      : savedMsgId,
        convId,
        ownerUid,
      });
    } catch (dbErr) {
      logger.error('[INfiniReach] webhook:inbound Erreur stockage Firestore', { error: dbErr.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ÉTAPE 4 : Vérifier la présence puis livrer le message
  // ─────────────────────────────────────────────────────────────
  // Règle de routage :
  //   ownerUid trouvé + connecté  → OmniSMS (Socket.IO)
  //   ownerUid trouvé + déconnecté → SMS ordinaire (fallback)
  //   ownerUid absent              → message en Firestore seulement

  const socketPayload = {
    id            : savedMsgId || `infinireach-inbound-${Date.now()}`,
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

  // ─────────────────────────────────────────────────────────────
  // ÉTAPE 4 : Vérifier la présence DU DESTINATAIRE puis livrer
  // ─────────────────────────────────────────────────────────────
  //
  // RÈGLE ABSOLUE DU ROUTAGE :
  //   SMS entrant :  from = expéditeur (57...)  /  to = destinataire (75...)
  //
  //   Si destinataire possède OmniSMS :
  //     → Vérifier présence de CE UID SPÉCIFIQUE
  //     → ONLINE  → OmniSMS (Socket.IO vers ownerUid)
  //     → OFFLINE → SMS ordinaire vers le numéro DESTINATAIRE (to / recipientE164)
  //                 JAMAIS vers l'expéditeur (from / fromE164)
  //
  //   Si destinataire sans OmniSMS :
  //     → SMS ordinaire vers le numéro destinataire
  //
  // Logs diagnostics : incomingFrom, incomingTo, resolvedRecipientUid,
  //                    recipientPresence, routingDecision, fallbackTo

  // ── Log de routage structuré ─────────────────────────────────
  logger.info('[INfiniReach] ROUTING — diagnostic', {
    incomingFrom          : fromE164.replace(/\d{4}$/, '****'),
    incomingTo            : recipientE164 ? recipientE164.replace(/\d{4}$/, '****') : null,
    resolvedRecipientPhone: recipientE164 ? recipientE164.replace(/\d{4}$/, '****') : null,
    resolvedRecipientUid  : ownerUid || null,
    recipientOmniSms      : !!ownerUid,
    convId,
  });

  if (ownerUid) {
    // ── Vérification de présence : UID DESTINATAIRE uniquement ──────
    //
    // Double vérification :
    //   1. Redis hget('online_users', ownerUid) — source de vérité principale
    //   2. Socket.IO room 'user:{ownerUid}' — fallback si Redis absent/vide
    //      (le socket rejoint cette room à la connexion dans socketService.js)
    //
    // IMPORTANT : on vérifie EXCLUSIVEMENT ownerUid.
    // La présence d'un autre UID (ex: rvVb...) ne doit JAMAIS
    // rendre ownerUid (ex: MGvh...) comme connecté.
    let ownerIsOnline = false;

    try {
      const socketSvc = require('../services/socketService');

      // 1. Vérification Redis (par UID)
      ownerIsOnline = await socketSvc.isUserOnline(ownerUid);

      // 2. Fallback Socket.IO room si Redis ne connaît pas encore ce UID
      //    (connexion récente avant que le heartbeat ait été enregistré)
      if (!ownerIsOnline) {
        const io = socketSvc.getIO ? socketSvc.getIO() : null;
        if (io) {
          try {
            const sockets = await io.in(`user:${ownerUid}`).fetchSockets();
            ownerIsOnline = sockets.length > 0;
            if (ownerIsOnline) {
              logger.info('[INfiniReach] ROUTING — présence confirmée via Socket.IO room (pas encore en Redis)', {
                resolvedRecipientUid: ownerUid,
                socketsCount: sockets.length,
              });
            }
          } catch (_) { /* io.fetchSockets non disponible — ignorer */ }
        }
      }
    } catch (_) {
      // socketService non disponible → supposer offline (dégradation sécurisée)
      ownerIsOnline = false;
    }

    if (ownerIsOnline) {
      // ── ONLINE → livraison OmniSMS temps réel ──────────────────
      emitFn(ownerUid, 'message:receive', socketPayload);
      emitFn(ownerUid, 'new_message',     socketPayload); // rétrocompat

      logger.info('[INfiniReach] ROUTING — décision', {
        incomingFrom          : fromE164.replace(/\d{4}$/, '****'),
        incomingTo            : recipientE164 ? recipientE164.replace(/\d{4}$/, '****') : null,
        resolvedRecipientUid  : ownerUid,
        recipientPresence     : 'online',
        routingDecision       : 'omnisms',
      });

    } else {
      // ── OFFLINE → SMS ordinaire vers le numéro DESTINATAIRE ────
      //
      // RÈGLE CRITIQUE : to = recipientE164 (le destinataire du SMS entrant)
      //                  JAMAIS fromE164 (l'expéditeur)
      //
      // Le message est déjà en Firestore → sera récupéré à la reconnexion.
      const smsGateway = getSmsGateway();

      logger.info('[INfiniReach] ROUTING — décision', {
        incomingFrom          : fromE164.replace(/\d{4}$/, '****'),
        incomingTo            : recipientE164 ? recipientE164.replace(/\d{4}$/, '****') : null,
        resolvedRecipientUid  : ownerUid,
        recipientPresence     : 'offline',
        routingDecision       : 'sms_fallback',
        fallbackTo            : recipientE164 ? recipientE164.replace(/\d{4}$/, '****') : '(non résolu)',
        fallbackFrom          : '(numéro SIM passerelle InfiniReach)',
        // NE JAMAIS utiliser fromE164 comme destination du fallback
        smsGatewayConfigured  : !!(smsGateway && smsGateway.isConfigured()),
      });

      if (smsGateway && smsGateway.isConfigured()) {
        // Notifier le DESTINATAIRE (recipientE164) qu'il a reçu un message
        // pendant son absence. Le `from` d'InfiniReach est le numéro SIM
        // passerelle (INFINIREACH_FROM_NUMBER) — inchangé, validé.
        if (recipientE164) {
          try {
            const smsText = `[OmniSMS] Message reçu de ${fromE164} : ${finalText}`;
            const smsResult = await smsGateway.sendSMS({
              to       : recipientE164,   // ← DESTINATAIRE ORIGINAL (75...) — JAMAIS l'expéditeur (57...)
              text     : smsText,
              messageId: savedMsgId || null,
              ttl      : 3600,
            });
            logger.info('[INfiniReach] SMS fallback envoyé', {
              fallbackTo  : recipientE164.replace(/\d{4}$/, '****'),  // toujours le destinataire
              fallbackFrom: '(SIM passerelle)',
              success     : smsResult?.success,
            });
          } catch (smsErr) {
            logger.warn('[INfiniReach] SMS fallback échoué', {
              fallbackTo: recipientE164 ? recipientE164.replace(/\d{4}$/, '****') : null,
              error     : smsErr.message,
            });
          }
        } else {
          logger.warn('[INfiniReach] SMS fallback impossible — recipientE164 non résolu', {
            hint: 'Le numéro SIM destinataire (to) doit être configuré dans InfiniReach',
          });
        }
      } else {
        // Pas de SMS Gateway configuré — message en Firestore seulement
        logger.warn('[INfiniReach] Pas de SMS Gateway configuré → message en Firestore seulement', {
          hint             : 'Configurer INFINIREACH_API_KEY pour le fallback SMS',
          recipientUid     : ownerUid,
          recipientPresence: 'offline',
        });
      }
    }
  }

  // Broadcast général (debug, clients non identifiés)
  if (io) {
    io.emit('sms:inbound', socketPayload);
  }
}

/* ── Dispatcher principal ───────────────────────────────────── */
/**
 * Aiguille le webhook INfiniReach selon event :
 *   message.inbound   → SMS entrant complet
 *   message.sent      → DLR envoi
 *   message.delivered → DLR livraison
 *   message.failed    → DLR échec
 */
async function processGatewayWebhook(body) {
  const event = body?.event;
  const data  = body?.data || {};

  logger.info('[INfiniReach] webhook:received', {
    event,
    messageId: data.messageId,
    direction: data.direction,
  });

  try {
    switch (event) {
      // ── SMS entrant ────────────────────────────────────────
      case 'message.inbound':
        await processSmsReceived(body);
        break;

      // ── DLR sortants ───────────────────────────────────────
      case 'message.sent':
      case 'message.delivered':
      case 'message.failed':
        await updateDeliveryStatus(event, data, getDb());
        break;

      // ── Inconnu ────────────────────────────────────────────
      default:
        logger.debug('[INfiniReach] webhook:received Événement inconnu', {
          event,
          keys: Object.keys(body || {}),
        });
    }
  } catch (err) {
    logger.error('[INfiniReach] webhook:received Erreur traitement', {
      error : err.message,
      event,
      stack : err.stack,
    });
  }
}

/* ─────────────────────────────────────────────────────────────
   POST /api/webhooks/sms-gateway/inbound
   Route principale SMS entrant INfiniReach Z Fold2
   ─────────────────────────────────────────────────────────── */
router.post('/sms-gateway/inbound', (req, res) => {
  const body       = req.body || {};
  const event      = body?.event || '(unknown)';
  const data       = body?.data  || {};
  const messageId  = data?.messageId  || null;
  const fromRaw    = data?.from       || null;
  const toRaw      = data?.to         || null;
  const bodyLength = typeof data?.body === 'string' ? data.body.length : 0;

  // Log d'entrée sûr — aucun secret, aucun contenu SMS complet
  logger.info('[InfiniReach Webhook] received', {
    event,
    messageId,
    from      : fromRaw   ? String(fromRaw).replace(/\d{4}$/, '****') : null,
    to        : toRaw     ? String(toRaw).replace(/\d{4}$/, '****')   : null,
    bodyLength,
    direction : data?.direction || null,
    deviceId  : data?.deviceId  || null,
    ip        : req.ip || req.headers['x-forwarded-for'] || null,
  });

  const smsGateway = getSmsGateway();

  // Validation de la signature HMAC si INFINIREACH_WEBHOOK_SECRET configuré
  // Sans secret → mode permissif (cas initial INfiniReach, premier test)
  if (smsGateway && !smsGateway.validateWebhookSignature(req)) {
    logger.warn('[InfiniReach Webhook] Signature invalide — requête rejetée', { event, messageId });
    return res.status(401).json({
      error: 'Signature invalide.',
      code : 'INVALID_SIGNATURE',
    });
  }

  // Répondre 200 IMMÉDIATEMENT pour stopper les retries INfiniReach
  res.status(200).json({
    received : true,
    provider : 'sms_gateway',
    timestamp: new Date().toISOString(),
  });

  // Traitement asynchrone (ne bloque pas la réponse 200)
  setImmediate(() => processGatewayWebhook(body));
});

/* ─────────────────────────────────────────────────────────────
   GET /api/webhooks/sms-gateway/status
   Health check + guide de configuration INfiniReach
   ─────────────────────────────────────────────────────────── */
router.get('/sms-gateway/status', (_req, res) => {
  const smsGateway = getSmsGateway();
  const backendUrl = process.env.RENDER_EXTERNAL_URL || 'https://omnisms-backend.onrender.com';

  return res.status(200).json({
    status       : 'active',
    service      : 'INfiniReach Inbound Webhook v2',
    webhookUrl   : `${backendUrl}/api/webhooks/sms-gateway/inbound`,
    provider     : smsGateway ? smsGateway.getStatus() : { configured: false },
    transport    : {
      name       : 'INfiniReach',
      apiUrl     : 'https://api.infinireach.io',
      sendEndpoint: 'POST /api/v1/messages',
      auth       : 'X-API-Key header',
    },
    configuration: {
      step1: 'Installer l\'application INfiniReach sur le Z Fold2',
      step2: 'Se connecter et enregistrer le device',
      step3: `Configurer le webhook dans INfiniReach : URL = ${backendUrl}/api/webhooks/sms-gateway/inbound, Event = message.inbound`,
      step4: 'Configurer les env vars Render : INFINIREACH_API_KEY, INFINIREACH_FROM_NUMBER',
      step5: '(Optionnel) Configurer INFINIREACH_WEBHOOK_SECRET pour valider les signatures webhook',
    },
    envVarsRequired: [
      'INFINIREACH_API_KEY',
      'INFINIREACH_FROM_NUMBER',
    ],
    envVarsOptional: [
      'INFINIREACH_API_URL (défaut: https://api.infinireach.io)',
      'INFINIREACH_ENABLED (défaut: true)',
      'INFINIREACH_WEBHOOK_SECRET (vide = mode permissif)',
      'INFINIREACH_REQUIRE_SIGNATURE (défaut: false)',
    ],
  });
});

module.exports = router;
