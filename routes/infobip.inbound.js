'use strict';
/**
 * OmniSMS — Webhook Infobip SMS Entrants
 *
 * Route :
 *   POST /api/webhooks/infobip/inbound
 *
 * Workflow complet SMS entrant :
 *
 *   B (utilisateur externe)
 *     ↓ SMS
 *   Infobip
 *     ↓ webhook POST ici
 *   Backend
 *     ↓
 *   normalizePhone(from)
 *     ↓
 *   Protocole #NUMERO (si premier message) :
 *     → texte commence par "#" → extraire le numéro cible → resolveUserByPhone
 *   Sinon :
 *     → findExternalConvByPhone(from) → retrouver ownerUid
 *     ↓
 *   Créer message en Firestore
 *     ↓
 *   emitToUser(ownerUid, 'message:receive', ...)
 *     ↓
 *   Si ownerUid offline → message persiste en Firestore, récupéré à la reconnexion
 *
 * IMPORTANT :
 *   - La conversation externe est basée sur ext-{ownerUid}-{e164}
 *   - Le conversationId utilisé dans Firestore messages doit correspondre
 *     à ce que le frontend charge (via /api/messages/:conversationId)
 *   - Ne jamais utiliser `sms-${from}-${to}` comme conversationId persistant
 *
 * Configurer dans Infobip portal :
 *   Channels → SMS → Configuration → Default inbound webhook URL
 *   → https://omnisms-backend.onrender.com/api/webhooks/infobip/inbound
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

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

/* ── Validation signature Infobip (optionnelle) ─────────────── */
function validateInfobipSignature(req) {
  const secret = process.env.INFOBIP_WEBHOOK_SECRET;
  if (!secret) return true;

  const sig = req.headers['authorization'] || req.headers['x-hub-signature'] || '';
  if (!sig) {
    logger.warn('[Infobip/Inbound] Signature manquante alors que INFOBIP_WEBHOOK_SECRET est configuré.');
    return true; // Infobip ne signe pas toujours
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

/* ── Parsing du préfixe # (protocole SMS externe) ────────────── */
/**
 * Protocole # : le premier SMS d'un utilisateur externe peut commencer par
 *   "#NUMERO message"
 * pour indiquer le destinataire OmniSMS.
 *
 * Exemples :
 *   "#22670000000 Salut Emmanuel"   → targetPhone=+22670000000, text="Salut Emmanuel"
 *   "#0022670000000 Bonjour"        → targetPhone=+22670000000, text="Bonjour"
 *   "+22670000000 coucou"           → targetPhone=+22670000000, text="coucou" (+ accepté aussi)
 *
 * @param {string} text
 * @returns {{ targetPhone: string, cleanText: string } | null}
 */
function parseHashPrefix(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // Accepter "#NUMERO" ou "+NUMERO" au début
  const match = trimmed.match(/^[#]?\s*(\+?[\d]{6,15})\s+([\s\S]+)$/);
  if (!match) return null;

  const rawPhone  = match[1];
  const cleanText = match[2].trim();
  const e164      = normalizePhone(rawPhone);

  if (!e164 || !cleanText) return null;

  return { targetPhone: e164, cleanText };
}

/* ── Rapport de livraison (DLR) ─────────────────────────────── */
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
        messageId: item.messageId,
        status   : item.status?.name,
      });
    }
  } catch (err) {
    logger.warn('[Infobip/DLR] Update failed', { error: err.message });
  }
}

/* ── Processeur principal des SMS entrants ──────────────────── */
async function processInfobipInbound(payload) {
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
      if (item.messageId && item.status && item.text === undefined) {
        logger.info('[Infobip/DLR] Rapport livraison reçu', {
          messageId: item.messageId,
          status   : item.status?.name || item.status?.groupName,
        });
        await updateDeliveryStatus(item, db);

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

      /* ── SMS entrant (MO — Mobile Originated) ────────────── */
      if (item.text === undefined) {
        logger.debug('[Infobip/Inbound] Événement inconnu', { keys: Object.keys(item) });
        continue;
      }

      const fromRaw    = item.from    || '';
      const toRaw      = item.to      || '';
      const textRaw    = item.text    || '';
      const fromE164   = normalizePhone(fromRaw) || fromRaw;

      logger.info('[INFOBIP_INBOUND] SMS reçu', {
        from      : fromE164.replace(/\d{4}$/, '****'),
        to        : toRaw,
        textLength: textRaw.length,
        messageId : item.messageId,
        receivedAt: item.receivedAt,
      });

      // ── Auto-reply si mot-clé ──────────────────────────────
      const autoReply = getAutoReply(textRaw);
      if (autoReply) {
        let infobip = null;
        try { infobip = require('../services/infobip'); } catch (_) {}
        if (infobip && infobip.isConfigured()) {
          infobip.sendSMS({ to: fromE164, text: autoReply })
            .then(r => r.success && logger.info('[Infobip/Inbound] Auto-reply envoyé', { to: fromE164.replace(/\d{4}$/, '****') }))
            .catch(() => {});
        }
        continue; // ne pas traiter les mots-clés comme des messages
      }

      // ─────────────────────────────────────────────────────────
      // ÉTAPE 1 : Trouver le destinataire OmniSMS (ownerUid)
      // ─────────────────────────────────────────────────────────
      // Cas A : Le texte commence par # → nouveau protocole d'adressage
      // Cas B : Conversation externe existante → retrouver le propriétaire
      // Cas C : Pas de conversation existante ET pas de # → broadcast ou ignoré

      let ownerUid     = null;
      let convId       = null;
      let finalText    = textRaw;
      let isNewConv    = false;

      // Cas A : Protocole # (nouveau destinataire)
      const hashParsed = parseHashPrefix(textRaw);
      if (hashParsed) {
        logger.info('[INFOBIP_INBOUND] Protocole # détecté', {
          targetPhone: hashParsed.targetPhone.replace(/\d{4}$/, '****'),
        });

        const targetUser = await resolveUserByPhone(hashParsed.targetPhone);
        if (targetUser.found) {
          ownerUid  = targetUser.uid;
          finalText = hashParsed.cleanText;
          isNewConv = true;

          logger.info('[USER_RESOLUTION] # protocol resolved → OmniSMS', {
            from     : fromE164.replace(/\d{4}$/, '****'),
            targetUid: ownerUid,
            isOmniSms: true,
          });
        } else {
          logger.warn('[INFOBIP_INBOUND] Protocole # : numéro cible non trouvé dans OmniSMS', {
            targetPhone: hashParsed.targetPhone.replace(/\d{4}$/, '****'),
          });
          // Continuer sans ownerUid → essayer de retrouver via conversation existante
        }
      }

      // Cas B : Retrouver la conversation externe existante via le numéro de l'expéditeur
      if (!ownerUid) {
        const existingConv = await findExternalConvByPhone(db, fromE164, toRaw);
        if (existingConv) {
          ownerUid = existingConv.ownerUid;
          convId   = existingConv.conversationId;

          logger.info('[INFOBIP_INBOUND] Conversation externe trouvée', {
            from   : fromE164.replace(/\d{4}$/, '****'),
            ownerUid,
            convId,
          });
        }
      }

      // Cas C : Dernier recours — chercher le propriétaire du numéro Infobip (item.to)
      if (!ownerUid && toRaw) {
        const toUser = await resolveUserByPhone(toRaw);
        if (toUser.found) {
          ownerUid = toUser.uid;
          isNewConv = true;
          logger.info('[INFOBIP_INBOUND] Owner résolu via numéro Infobip', {
            to: toRaw, ownerUid,
          });
        }
      }

      if (!ownerUid) {
        logger.warn('[INFOBIP_INBOUND] Impossible de trouver le destinataire OmniSMS', {
          from: fromE164.replace(/\d{4}$/, '****'), to: toRaw,
          hint: 'Configurer un numéro Infobip associé à un compte OmniSMS, ou utiliser le protocole #NUMERO message',
        });
        // Stocker quand même pour audit, mais sans conversationId owner-based
      }

      // ─────────────────────────────────────────────────────────
      // ÉTAPE 2 : Créer/récupérer la conversation externe
      // ─────────────────────────────────────────────────────────
      if (ownerUid && !convId) {
        const extConv = await getOrCreateExternalConv(db, ownerUid, fromE164, null);
        convId = extConv?.conversationId || makeExternalConvId(ownerUid, fromE164);
      }

      // Fallback conversationId si aucun owner
      if (!convId) {
        convId = `sms-inbound-${fromE164.replace(/\W/g, '')}-${Date.now()}`;
      }

      // ─────────────────────────────────────────────────────────
      // ÉTAPE 3 : Stocker le message en Firestore
      // ─────────────────────────────────────────────────────────
      const now = new Date().toISOString();
      const msgDoc = {
        channel       : 'sms',
        direction     : 'inbound',
        senderId      : fromE164,        // numéro externe (expéditeur)
        receiverId    : ownerUid || toRaw, // UID OmniSMS ou numéro Infobip
        conversationId: convId,
        content       : finalText,
        type          : 'text',
        smsMessageId  : item.messageId || null,
        from          : fromE164,
        to            : toRaw,
        status        : 'delivered',
        createdAt     : item.receivedAt || now,
        updatedAt     : now,
      };

      let savedMsgId = null;
      if (db) {
        try {
          const ref = await db.collection('messages').add(msgDoc);
          savedMsgId = ref.id;
          // Mettre à jour lastMessage dans la conversation externe
          if (ownerUid) {
            await updateExternalConvLastMessage(db, convId, finalText);
          }
          logger.info('[INFOBIP_INBOUND] Message stocké Firestore', {
            id     : savedMsgId,
            convId,
            ownerUid,
          });
        } catch (dbErr) {
          logger.error('[INFOBIP_INBOUND] Erreur stockage Firestore', { error: dbErr.message });
        }
      }

      // ─────────────────────────────────────────────────────────
      // ÉTAPE 4 : Notifier le propriétaire OmniSMS via Socket.IO
      // (Si offline → le message est en Firestore, récupéré à la reconnexion)
      // ─────────────────────────────────────────────────────────
      const socketPayload = {
        id            : savedMsgId || `inbound-${Date.now()}`,
        type          : 'text',
        channel       : 'sms',
        direction     : 'inbound',
        senderId      : fromE164,
        receiverId    : ownerUid || toRaw,
        conversationId: convId,
        content       : finalText,
        from          : fromE164,
        to            : toRaw,
        status        : 'delivered',
        createdAt     : item.receivedAt || now,
        timestamp     : now,
        smsMessageId  : item.messageId || null,
      };

      if (ownerUid) {
        emitFn(ownerUid, 'message:receive', socketPayload);
        emitFn(ownerUid, 'new_message',     socketPayload); // rétrocompat
        logger.info('[INFOBIP_INBOUND] message:receive émis', {
          uid  : ownerUid,
          from : fromE164.replace(/\d{4}$/, '****'),
          convId,
        });
      }

      // Broadcast général (pour debug ou clients non identifiés)
      if (io) {
        io.emit('sms:inbound', socketPayload);
      }
    }

  } catch (err) {
    logger.error('[Infobip/Inbound] Erreur traitement', { error: err.message, stack: err.stack });
  }
}

/* ─────────────────────────────────────────────────────────────
   POST /api/webhooks/infobip/inbound
   ─────────────────────────────────────────────────────────── */
router.post('/infobip/inbound', (req, res) => {
  if (!validateInfobipSignature(req)) {
    logger.warn('[Infobip/Inbound] Signature invalide — requête rejetée');
    return res.status(401).json({ error: 'Signature invalide.', code: 'INVALID_SIGNATURE' });
  }

  // Répondre 200 IMMÉDIATEMENT pour éviter les retries Infobip
  res.status(200).json({ received: true, timestamp: new Date().toISOString() });

  // Traitement asynchrone (ne bloque pas la réponse 200)
  setImmediate(() => processInfobipInbound(req.body || {}));
});

/* ─────────────────────────────────────────────────────────────
   POST /api/webhooks/infobip      (rétrocompat ancienne URL)
   ─────────────────────────────────────────────────────────── */
router.post('/infobip', (req, res) => {
  if (!validateInfobipSignature(req)) {
    return res.status(401).json({ error: 'Signature invalide.', code: 'INVALID_SIGNATURE' });
  }
  res.status(200).json({ received: true, timestamp: new Date().toISOString() });
  setImmediate(() => processInfobipInbound(req.body || {}));
});

/* ─────────────────────────────────────────────────────────────
   GET /api/webhooks/infobip/inbound/status
   ─────────────────────────────────────────────────────────── */
router.get('/infobip/inbound/status', (_req, res) => {
  let infobip = null;
  try { infobip = require('../services/infobip'); } catch (_) {}

  return res.status(200).json({
    status     : 'active',
    service    : 'Infobip Inbound Webhook v2',
    webhookUrl : `${process.env.RENDER_EXTERNAL_URL || 'https://omnisms-backend.onrender.com'}/api/webhooks/infobip/inbound`,
    protocol   : {
      hashPrefix : 'Pour initier une conversation : #NUMERO_OMNISMS votre message',
      example    : '#22670000000 Bonjour Emmanuel !',
      reply      : 'Pour répondre, envoyer directement au numéro OmniSMS (pas besoin de #)',
    },
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
      '4. Optionnel: configurez INFOBIP_WEBHOOK_SECRET pour validation HMAC',
      '5. Protocole # : nouveau SMS sans historique → commencer par #NUMERO_DESTINATAIRE message',
    ],
  });
});

module.exports = router;
