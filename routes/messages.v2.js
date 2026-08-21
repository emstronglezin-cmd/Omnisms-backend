'use strict';
/**
 * OmniSMS — Routes Messages v2 (Temps Réel + Audio + SMS Infobip)
 *
 * Endpoints REST :
 *   GET  /api/messages                   → Lister conversations (alias /conversations)
 *   GET  /api/messages/:conversationId   → Historique d'une conversation
 *   POST /api/messages/send              → Envoyer message (in-app + SMS Infobip si numéro)
 *   GET  /api/messages/conversation/:uid → Récupérer une conversation (rétrocompat)
 *   GET  /api/messages/conversations     → Lister toutes les conversations
 *   PUT  /api/messages/:id/read          → Marquer message comme lu
 *   DELETE /api/messages/:id             → Supprimer un message
 *   POST /api/messages/:id/react         → Réagir à un message (emoji)
 */

const express  = require('express');
const router   = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const firebaseAuth = require('../middleware/firebaseAuth');
const { normalizePhone } = require('../services/phoneNormalizer');
const { emitToUser }    = require('../services/socketService');
const { logger }        = require('../middleware/logger');
/* ── Routage central (OmniSMS ↔ Infobip) ────────────────── */
let routeMessage = null;
try { ({ routeMessage } = require('../services/messageRouter')); } catch (_) {}
/* ── Transcription auto pour messages vocaux ─────────────── */
let addTranscriptionJob = null;
try { ({ addTranscriptionJob } = require('../services/queueService')); } catch (_) {}

const auth = firebaseAuth;

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error : 'Données invalides.',
      code  : 'VALIDATION_ERROR',
      fields: errors.array().map(e => ({ field: e.path, msg: e.msg })),
    });
  }
  return null;
}

function getDb() {
  try {
    const db = require('../config/firebase');
    if (db._stub) return null;
    return db;
  } catch (_) { return null; }
}

function convId(uid1, uid2) {
  return [uid1, uid2].sort().join('-');
}

/* ─────────────────────────────────────────────────────────────
   GET /api/messages
   Liste les conversations de l'utilisateur (alias /conversations)
   Supporte aussi ?type=sms pour filtrer par canal
   ─────────────────────────────────────────────────────────── */
router.get('/', auth, async (req, res) => {
  const uid   = req.user.uid;
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const page  = Math.max(parseInt(req.query.page  || '1',  10), 1);
  const type  = req.query.type || null;   // 'sms' | 'app' | null (tous)

  try {
    const db = getDb();
    if (!db) {
      // Retourner une liste vide plutôt qu'une erreur 503 si Firestore absent
      return res.status(200).json({
        count        : 0,
        page,
        limit,
        conversations: [],
        message      : 'Firebase non configuré — conversations indisponibles.',
      });
    }

    // Note: orderBy('createdAt') requires a composite Firestore index.
    // Sorting is done in-memory to avoid index errors on new projects.
    const [sent, received] = await Promise.all([
      db.collection('messages').where('senderId',   '==', uid).limit(limit * 2).get(),
      db.collection('messages').where('receiverId', '==', uid).limit(limit * 2).get(),
    ]);

    const convMap = new Map();
    const allDocs = [
      ...sent.docs.map(d => ({ id: d.id, ...d.data() })),
      ...received.docs.map(d => ({ id: d.id, ...d.data() })),
    ];

    allDocs.forEach(msg => {
      const cId = msg.conversationId;
      if (!cId) return;
      // Filtre par type de canal si demandé
      if (type && msg.channel && msg.channel !== type) return;

      const existing = convMap.get(cId);
      if (!existing || new Date(msg.createdAt) > new Date(existing.lastMessageAt || 0)) {
        const otherUid = msg.senderId === uid ? msg.receiverId : msg.senderId;
        convMap.set(cId, {
          id                 : cId,
          otherUserId        : otherUid,
          channel            : msg.channel || 'app',
          lastMessage        : msg.content || msg.text || (msg.type === 'audio' ? '🎤 Message vocal' : msg.type === 'image' ? '📷 Image' : ''),
          lastMessageContent : msg.content || msg.text || '',
          lastMessageAt      : msg.createdAt,
          lastMessageTime    : msg.createdAt,
          lastMessageType    : msg.type    || 'text',
          lastMessageSenderId: msg.senderId,
          unreadCount        : 0,
        });
      }
    });

    // Comptage non-lus (conversations OmniSMS)
    received.docs.forEach(d => {
      const msg = d.data();
      if (msg.status !== 'seen') {
        const cId = msg.conversationId;
        if (convMap.has(cId)) convMap.get(cId).unreadCount++;
      }
    });

    // ── Conversations externes (external_conversations) ──────────────
    // Fusionner les conversations SMS ↔ OmniSMS dans la liste principale.
    // Ces entrées n'ont pas de messages dans 'messages' mais ont un lastMessage.
    if (!type || type === 'sms') {
      try {
        const extSnap = await db.collection('external_conversations')
          .where('ownerUid', '==', uid)
          .limit(limit * 2)
          .get();

        extSnap.docs.forEach(d => {
          const ext  = d.data();
          const cId  = d.id;  // ext-{ownerUid}-{e164}
          if (convMap.has(cId)) return;  // déjà présent via 'messages' (rare mais possible)

          convMap.set(cId, {
            id                 : cId,
            otherUserId        : ext.externalPhone || cId,
            channel            : 'sms',
            isExternal         : true,
            externalPhone      : ext.externalPhone || null,
            externalName       : ext.externalName  || ext.externalPhone || null,
            lastMessage        : ext.lastMessage   || '',
            lastMessageContent : ext.lastMessage   || '',
            lastMessageAt      : ext.lastMessageAt || ext.createdAt || null,
            lastMessageTime    : ext.lastMessageAt || ext.createdAt || null,
            lastMessageType    : 'text',
            lastMessageSenderId: ext.externalPhone || cId,
            unreadCount        : 0,  // TODO: compter les non-lus dans external_conversations
            otherUserName      : ext.externalName  || ext.externalPhone || null,
            otherUserPhone     : ext.externalPhone || null,
            contactName        : ext.externalName  || ext.externalPhone || null,
          });
        });
      } catch (extErr) {
        logger.warn('[Messages] GET / external_conversations fetch error', { error: extErr.message });
        // Non bloquant — continuer sans les conversations externes
      }
    }

    // Enrichir les conversations avec le nom de l'autre utilisateur
    if (db) {
      // Séparer les UIDs Firestore des numéros de téléphone
      const otherUids   = [...new Set([...convMap.values()].map(c => c.otherUserId).filter(Boolean))];
      const phoneOthers = otherUids.filter(u => /^\+?[0-9\s\-()+]{7,20}$/.test(u) && !u.includes('-'));
      const uidOthers   = otherUids.filter(u => !phoneOthers.includes(u));

      const userCache = new Map();

      // 1. Lookup des vrais UIDs Firestore
      for (let i = 0; i < uidOthers.length; i += 10) {
        const batch = uidOthers.slice(i, i + 10);
        try {
          const userDocs = await Promise.all(batch.map(u => db.collection('users').doc(u).get()));
          userDocs.forEach((doc, idx) => {
            if (doc.exists) {
              const d = doc.data();
              userCache.set(batch[idx], { name: d.name, avatar: d.avatar || null, phone: d.phone });
            }
          });
        } catch (_) {}
      }

      // 2. Pour les numéros de téléphone : chercher le nom dans les contacts de l'utilisateur
      if (phoneOthers.length > 0) {
        try {
          const mySnap = await db.collection('users').doc(uid).get();
          if (mySnap.exists) {
            const myData = mySnap.data();
            const allContacts = [
              ...(myData.contacts_manual || []),
              ...(myData.contacts_synced || []),
            ];
            phoneOthers.forEach(phone => {
              const match = allContacts.find(c => c.phone === phone || c.phone === phone.replace(/\s/g,''));
              if (match && match.name) {
                userCache.set(phone, { name: match.name, avatar: match.avatar || null, phone });
              }
            });
          }
        } catch (_) {}
      }

      convMap.forEach((conv) => {
        const info = userCache.get(conv.otherUserId);
        if (info) {
          conv.otherUserName  = info.name  || conv.otherUserName  || conv.otherUserId;
          conv.otherUserAvatar= info.avatar|| conv.otherUserAvatar|| null;
          conv.otherUserPhone = info.phone || conv.otherUserPhone || null;
          conv.contactName    = info.name  || conv.contactName    || conv.otherUserId;
        } else {
          // Fallback : utiliser otherUserId comme displayName
          if (!conv.otherUserName) conv.otherUserName = conv.otherUserId;
          if (!conv.contactName)   conv.contactName   = conv.otherUserId;
        }
      });
    }

    const allConvs = [...convMap.values()]
      .sort((a, b) => new Date(b.lastMessageAt || b.lastMessageTime || 0) - new Date(a.lastMessageAt || a.lastMessageTime || 0));

    // Pagination manuelle
    const totalCount = allConvs.length;
    const start      = (page - 1) * limit;
    const conversations = allConvs.slice(start, start + limit);

    return res.status(200).json({
      count        : conversations.length,
      total        : totalCount,
      page,
      limit,
      hasMore      : start + conversations.length < totalCount,
      conversations,
    });

  } catch (err) {
    logger.error('[Messages] GET / error', { error: err.message });
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/messages/:conversationId
   Historique complet d'une conversation (par conversationId)
   Doit être AVANT les routes /:id/* pour éviter le conflit
   ─────────────────────────────────────────────────────────── */
router.get(
  '/:conversationId([a-zA-Z0-9_\\-]{10,})',   // pattern large : uid1-uid2 ou IDs Firestore
  auth,
  async (req, res) => {
    const uid            = req.user.uid;
    const { conversationId } = req.params;
    const limit          = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const page           = Math.max(parseInt(req.query.page   || '1',  10), 1);
    const before         = req.query.before || null;

    try {
      const db = getDb();
      if (!db) {
        return res.status(200).json({
          conversationId,
          count   : 0,
          messages: [],
          message : 'Firebase non configuré.',
        });
      }

      // Vérifier que l'utilisateur appartient à cette conversation
      if (!conversationId.includes(uid)) {
        // Pour les IDs personnalisés, vérifier via un premier message
        const checkSnap = await db.collection('messages')
          .where('conversationId', '==', conversationId)
          .where('senderId', '==', uid)
          .limit(1)
          .get();
        const checkSnap2 = await db.collection('messages')
          .where('conversationId', '==', conversationId)
          .where('receiverId', '==', uid)
          .limit(1)
          .get();

        if (checkSnap.empty && checkSnap2.empty) {
          return res.status(403).json({ error: 'Accès refusé à cette conversation.', code: 'FORBIDDEN' });
        }
      }

      // orderBy without composite index — sort in-memory
      let q = db.collection('messages')
        .where('conversationId', '==', conversationId)
        .limit(limit * 2);

      const snap     = await q.get();
      let messages   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      messages.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      messages = messages.slice(0, limit);

      // Marquer comme lus les messages reçus non lus
      const unread = messages.filter(m => m.receiverId === uid && m.status !== 'seen');
      if (unread.length > 0) {
        const batch = db.batch();
        unread.forEach(m => {
          batch.update(db.collection('messages').doc(m.id), {
            status: 'seen', seenAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          });
        });
        batch.commit().catch(() => {});
        unread.forEach(m => {
          try { emitToUser(m.senderId, 'message:seen', { messageId: m.id, seenBy: uid, seenAt: new Date().toISOString() }); } catch (_) {}
        });
      }

      return res.status(200).json({
        conversationId,
        count     : messages.length,
        page,
        limit,
        messages  : messages.reverse(),  // chronologique
        hasMore   : messages.length === limit,
        nextCursor: messages.length > 0 ? messages[messages.length - 1].createdAt : null,
        attachments: messages.filter(m => m.type === 'image' || m.type === 'file').map(m => ({
          messageId: m.id, type: m.type, url: m.imageUrl || m.fileUrl, createdAt: m.createdAt,
        })),
        voiceMessages: messages.filter(m => m.type === 'audio').map(m => ({
          messageId: m.id, audioUrl: m.audioUrl, duration: m.duration,
          transcription: m.transcription, transcriptionStatus: m.transcriptionStatus,
          createdAt: m.createdAt,
        })),
      });

    } catch (err) {
      logger.error('[Messages] GET /:conversationId error', { error: err.message, conversationId });
      return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   POST /api/messages/send
   ─────────────────────────────────────────────────────────── */
router.post(
  '/send',
  auth,
  [
    body('receiverId').trim().notEmpty().withMessage('receiverId requis.'),
    body('type').optional().isIn(['text', 'audio', 'image', 'file']).withMessage('type invalide.'),
    body('content').optional().isLength({ max: 10000 }),
  ],
  async (req, res) => {
    const err = validate(req, res);
    if (err) return;

    const {
      receiverId, content, type = 'text',
      audioUrl, imageUrl, fileUrl, duration,
      replyTo,
      // Champs optionnels passés par le frontend pour contexte SMS
      phone, smsFrom,
    } = req.body;

    const uid = req.user.uid;

    if (type === 'text' && !content) {
      return res.status(400).json({ error: 'content requis pour type text.', code: 'MISSING_CONTENT' });
    }
    if (type === 'audio' && !audioUrl) {
      return res.status(400).json({ error: 'audioUrl requis pour type audio.', code: 'MISSING_AUDIO_URL' });
    }

    try {
      const now = new Date().toISOString();
      const db  = getDb();

      // ── ROUTAGE CENTRAL ────────────────────────────────────────────
      // Déléguer toute la logique OmniSMS↔Infobip au service central.
      // routeMessage() : résolution phone→UID, Firestore, Socket.IO, Infobip.
      // Pour les messages audio/image, on gère le Firestore manuellement
      // (routeMessage est optimisé pour le texte) — on déroute vers le flux
      // existant pour les types non-texte.
      // ---------------------------------------------------------------

      // Déterminer si le receiverId est un téléphone ou un UID Firestore
      // UID Firestore : chaîne alphanumérique sans '+' ni espaces, peut contenir des '-'
      // Téléphone     : que des chiffres, +, espaces, tirets, parenthèses — sans '-' à l'intérieur d'un UID
      const looksLikePhone = /^\+?[0-9\s\-()+]{7,20}$/.test(receiverId) && !receiverId.includes('-');

      let routeResult = null;
      let effectiveReceiverId = receiverId;
      let cId = convId(uid, receiverId);

      if (routeMessage && db) {
        try {
          // Récupérer le nom de l'expéditeur pour le SMS Infobip
          let senderName  = req.user.name  || req.user.displayName || null;
          let senderPhone = req.user.phone || null;
          if (!senderName || !senderPhone) {
            try {
              const senderDoc = await db.collection('users').doc(uid).get();
              if (senderDoc.exists) {
                const sd = senderDoc.data();
                senderName  = senderName  || sd.name  || sd.username || uid;
                senderPhone = senderPhone || sd.phone || null;
              }
            } catch (_) {}
          }

          routeResult = await routeMessage({
            senderUid  : uid,
            // Si receiverId est un UID (pas un téléphone) : passer comme targetUid
            // Si receiverId est un téléphone : passer comme targetPhone
            targetPhone: looksLikePhone ? (phone || receiverId) : (phone || null),
            targetUid  : looksLikePhone ? null : receiverId,
            content    : content || (type === 'audio' ? '🎤 Message vocal' : type === 'image' ? '📷 Image' : ''),
            type,
            audioUrl   : audioUrl || null,
            duration   : duration || null,
            senderName,
            senderPhone,
            db,
          });

          if (routeResult && routeResult.route !== 'ERROR') {
            cId                 = routeResult.conversationId;
            effectiveReceiverId = routeResult.resolvedUid || receiverId;
          } else if (routeResult && routeResult.route === 'ERROR') {
            logger.warn('[Messages] routeMessage returned ERROR, falling back to direct save', {
              error: routeResult.message, receiverId,
            });
          }
        } catch (routeErr) {
          logger.warn('[Messages] routeMessage threw, falling back to direct save', { error: routeErr.message });
        }
      }

      // Si routeMessage a déjà sauvegardé le message (route OMNISMS ou INFOBIP),
      // réutiliser l'ID Firestore qu'il a créé. Sinon créer le message ici.
      let docId = routeResult?.messageId || null;
      let fullMsg;

      if (docId && routeResult?.route !== 'ERROR') {
        // Message déjà sauvegardé par routeMessage — récupérer le doc pour la réponse
        // (routeMessage stocke dans 'messages' pour OmniSMS, sinon 'messages' + Infobip)
        fullMsg = {
          id             : docId,
          senderId       : uid,
          receiverId     : effectiveReceiverId,
          conversationId : cId,
          content        : content ? content.trim() : null,
          type,
          channel        : routeResult.route === 'INFOBIP' ? 'sms' : 'app',
          audioUrl       : audioUrl || null,
          imageUrl       : imageUrl || null,
          fileUrl        : fileUrl  || null,
          duration       : duration || null,
          replyTo        : replyTo  || null,
          status         : 'sent',
          reactions      : [],
          transcription  : null,
          transcriptionStatus: type === 'audio' ? 'pending' : null,
          createdAt      : now,
          updatedAt      : now,
        };
      } else {
        // Fallback : routeMessage absent ou en erreur → sauvegarder directement
        const msg = {
          senderId       : uid,
          receiverId     : effectiveReceiverId,
          conversationId : cId,
          content        : content ? content.trim() : null,
          type,
          channel        : 'app',
          audioUrl       : audioUrl || null,
          imageUrl       : imageUrl || null,
          fileUrl        : fileUrl  || null,
          duration       : duration || null,
          replyTo        : replyTo  || null,
          status         : 'sent',
          reactions      : [],
          transcription  : null,
          transcriptionStatus: type === 'audio' ? 'pending' : null,
          createdAt      : now,
          updatedAt      : now,
        };

        docId = `msg-${Date.now()}`;
        if (db) {
          const ref = await db.collection('messages').add(msg);
          docId = ref.id;
        }
        fullMsg = { id: docId, ...msg };

        // Notifier le destinataire (fallback)
        try { emitToUser(effectiveReceiverId, 'message:receive', fullMsg); } catch (_) {}
      }

      // ── Auto-transcription pour messages vocaux ───────────────
      if (type === 'audio' && audioUrl && addTranscriptionJob) {
        try {
          const pathMod = require('path');
          const fs      = require('fs');
          // Cas 1 : data URI base64 — écrire un fichier temporaire
          if (audioUrl.startsWith('data:')) {
            const matches = audioUrl.match(/^data:([^;]+);base64,(.+)$/s);
            if (matches) {
              const ext      = matches[1].replace('audio/', '').replace(/[^a-z0-9]/g, '');
              const tmpName  = `tmp_auto_${docId}_${Date.now()}.${ext || 'webm'}`;
              const tmpPath  = pathMod.join(__dirname, '..', 'uploads', 'audio', tmpName);
              try {
                fs.writeFileSync(tmpPath, Buffer.from(matches[2], 'base64'));
                await addTranscriptionJob({
                  audioPath : tmpPath,
                  tempFile  : tmpPath,
                  messageId : docId,
                  userId    : uid,
                  language  : 'fr',
                  collection: 'messages',
                });
                logger.info('[Messages] Transcription job lancé auto (base64→tempFile)', { msgId: docId });
              } catch (tmpErr) {
                logger.warn('[Messages] Échec écriture temp file pour transcription', { error: tmpErr.message });
              }
            }
          } else {
            // Cas 2 : URL disque — vérifier existence
            const fname = audioUrl.split('/').pop();
            const audioPath = pathMod.join(__dirname, '..', 'uploads', 'audio', fname);
            if (fs.existsSync(audioPath)) {
              await addTranscriptionJob({
                audioPath,
                messageId : docId,
                userId    : uid,
                language  : 'fr',
                collection: 'messages',
              });
              logger.info('[Messages] Transcription job lancé auto (disk file)', { msgId: docId });
            }
          }
        } catch (transcErr) {
          logger.warn('[Messages] Échec lancement transcription auto', { error: transcErr.message });
        }
      }

      logger.info('[ROUTING] POST /send complete', {
        from   : uid,
        to     : receiverId,
        type,
        id     : docId,
        route  : routeResult?.route || 'FALLBACK',
        convId : cId,
      });

      return res.status(201).json({
        success            : true,
        message            : fullMsg,
        route              : routeResult?.route || 'FALLBACK',
        providerMessageId  : routeResult?.smsResult?.messageId  || null,
        smsStatus          : routeResult?.smsResult?.status      || null,
        smsSent            : routeResult?.route === 'INFOBIP'    || false,
        timestamp          : now,
      });

    } catch (err) {
      logger.error('[Messages] send error', { error: err.message });
      return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   GET /api/messages/conversation/:uid
   Récupérer une conversation
   ─────────────────────────────────────────────────────────── */
router.get(
  '/conversation/:targetUid',
  auth,
  async (req, res) => {
    const uid       = req.user.uid;
    const targetUid = req.params.targetUid;
    const limit     = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const before    = req.query.before || null;  // cursor pagination

    try {
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable.', code: 'DB_UNAVAILABLE' });

      const cId = convId(uid, targetUid);

      // orderBy without composite index — sort in-memory
      let q = db.collection('messages')
        .where('conversationId', '==', cId)
        .limit(limit * 2);

      // before cursor not used in memory-sort mode

      const snap = await q.get();
      const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Marquer les messages reçus comme lus
      const unread = messages.filter(m => m.receiverId === uid && m.status !== 'seen');
      if (unread.length > 0) {
        const batch = db.batch();
        unread.forEach(m => {
          batch.update(db.collection('messages').doc(m.id), {
            status   : 'seen',
            seenAt   : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        });
        batch.commit().catch(() => {});

        // Notifier l'expéditeur
        unread.forEach(m => {
          try {
            emitToUser(m.senderId, 'message:seen', {
              messageId: m.id,
              seenBy   : uid,
              seenAt   : new Date().toISOString(),
            });
          } catch (_) {}
        });
      }

      return res.status(200).json({
        conversationId: cId,
        count         : messages.length,
        messages      : messages.reverse(), // chronologique
        hasMore       : messages.length === limit,
        nextCursor    : messages.length > 0 ? messages[messages.length - 1].createdAt : null,
      });

    } catch (err) {
      logger.error('[Messages] conversation error', { error: err.message });
      return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   GET /api/messages/conversations
   Lister toutes mes conversations
   ─────────────────────────────────────────────────────────── */
router.get('/conversations', auth, async (req, res) => {
  const uid   = req.user.uid;
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB unavailable.', code: 'DB_UNAVAILABLE' });

    // Récupérer le dernier message de chaque conversation
    const [sent, received] = await Promise.all([
      db.collection('messages').where('senderId',   '==', uid).limit(limit * 2).get(),
      db.collection('messages').where('receiverId', '==', uid).limit(limit * 2).get(),
    ]);

    // Regrouper par conversationId
    const convMap = new Map();
    const allDocs = [
      ...sent.docs.map(d => ({ id: d.id, ...d.data() })),
      ...received.docs.map(d => ({ id: d.id, ...d.data() })),
    ];

    allDocs.forEach(msg => {
      const cId = msg.conversationId;
      if (!cId) return;
      if (!convMap.has(cId) || new Date(msg.createdAt) > new Date(convMap.get(cId).lastMessage.createdAt)) {
        const otherUid = msg.senderId === uid ? msg.receiverId : msg.senderId;
        convMap.set(cId, {
          id          : cId,
          otherUserId : otherUid,
          lastMessage : msg,
          unreadCount : 0,
        });
      }
    });

    // Compter les non lus
    received.docs.forEach(d => {
      const msg = d.data();
      if (msg.status !== 'seen') {
        const cId = msg.conversationId;
        if (convMap.has(cId)) {
          convMap.get(cId).unreadCount++;
        }
      }
    });

    const conversations = [...convMap.values()]
      .sort((a, b) => new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt))
      .slice(0, limit);

    return res.status(200).json({
      count        : conversations.length,
      conversations,
    });

  } catch (err) {
    logger.error('[Messages] conversations list error', { error: err.message });
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

/* ─────────────────────────────────────────────────────────────
   PUT /api/messages/:id/read
   ─────────────────────────────────────────────────────────── */
router.put('/:id/read', auth, async (req, res) => {
  const { id } = req.params;
  const uid    = req.user.uid;

  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB unavailable.', code: 'DB_UNAVAILABLE' });

    const snap = await db.collection('messages').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Message non trouvé.', code: 'NOT_FOUND' });

    const msg = snap.data();
    if (msg.receiverId !== uid) {
      return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
    }

    await db.collection('messages').doc(id).update({
      status   : 'seen',
      seenAt   : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Notifier l'expéditeur
    try { emitToUser(msg.senderId, 'message:seen', { messageId: id, seenBy: uid, seenAt: new Date().toISOString() }); } catch (_) {}

    return res.status(200).json({ success: true, messageId: id });

  } catch (err) {
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /api/messages/:id
   ─────────────────────────────────────────────────────────── */
router.delete('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const uid    = req.user.uid;

  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB unavailable.', code: 'DB_UNAVAILABLE' });

    const snap = await db.collection('messages').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Message non trouvé.', code: 'NOT_FOUND' });

    const msg = snap.data();
    if (msg.senderId !== uid) {
      return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
    }

    await db.collection('messages').doc(id).delete();

    // Notifier le destinataire
    try { emitToUser(msg.receiverId, 'message:deleted', { messageId: id, deletedBy: uid }); } catch (_) {}

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /api/messages/:id/react
   ─────────────────────────────────────────────────────────── */
router.post(
  '/:id/react',
  auth,
  [body('emoji').trim().notEmpty().withMessage('emoji requis.')],
  async (req, res) => {
    const { id }   = req.params;
    const { emoji } = req.body;
    const uid       = req.user.uid;

    try {
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable.', code: 'DB_UNAVAILABLE' });

      const snap = await db.collection('messages').doc(id).get();
      if (!snap.exists) return res.status(404).json({ error: 'Message non trouvé.', code: 'NOT_FOUND' });

      const msg      = snap.data();
      const reactions = msg.reactions || [];

      // Mettre à jour ou ajouter la réaction
      const idx = reactions.findIndex(r => r.uid === uid);
      if (idx >= 0) {
        reactions[idx] = { uid, emoji, reactedAt: new Date().toISOString() };
      } else {
        reactions.push({ uid, emoji, reactedAt: new Date().toISOString() });
      }

      await db.collection('messages').doc(id).update({
        reactions,
        updatedAt: new Date().toISOString(),
      });

      // Notifier les participants
      const otherUid = msg.senderId === uid ? msg.receiverId : msg.senderId;
      try {
        emitToUser(otherUid, 'message:reaction', { messageId: id, uid, emoji });
      } catch (_) {}

      return res.status(200).json({ success: true, reactions });

    } catch (err) {
      return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
  }
);

module.exports = router;
