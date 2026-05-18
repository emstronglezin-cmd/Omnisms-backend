'use strict';
/**
 * OmniSMS — Routes Messages v2 (Temps Réel + Audio)
 *
 * Endpoints REST (complément au Socket.IO) :
 *   POST /api/messages/send              → Envoyer un message (text ou audio)
 *   GET  /api/messages/conversation/:uid → Récupérer une conversation
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
      const cId = convId(uid, receiverId);

      const msg = {
        senderId    : uid,
        receiverId,
        conversationId: cId,
        content     : content ? content.trim() : null,
        type,
        audioUrl    : audioUrl || null,
        imageUrl    : imageUrl || null,
        fileUrl     : fileUrl  || null,
        duration    : duration || null,
        replyTo     : replyTo  || null,
        status      : 'sent',
        reactions   : [],
        transcription: null,
        transcriptionStatus: type === 'audio' ? 'pending' : null,
        createdAt   : now,
        updatedAt   : now,
      };

      const db = getDb();
      let docId = `msg-${Date.now()}`;

      if (db) {
        const ref = await db.collection('messages').add(msg);
        docId = ref.id;
      }

      const fullMsg = { id: docId, ...msg };

      // Notifier le destinataire en temps réel via Socket.IO
      try {
        emitToUser(receiverId, 'message:receive', fullMsg);
      } catch (_) {
        // Socket.IO peut ne pas être initialisé — non bloquant
      }

      logger.info('[Messages] Sent', { from: uid, to: receiverId, type, id: docId });

      return res.status(201).json({
        success: true,
        message: fullMsg,
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

      let q = db.collection('messages')
        .where('conversationId', '==', cId)
        .orderBy('createdAt', 'desc')
        .limit(limit);

      if (before) {
        q = q.startAfter(before);
      }

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
      db.collection('messages').where('senderId',   '==', uid).orderBy('createdAt', 'desc').limit(limit * 2).get(),
      db.collection('messages').where('receiverId', '==', uid).orderBy('createdAt', 'desc').limit(limit * 2).get(),
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
