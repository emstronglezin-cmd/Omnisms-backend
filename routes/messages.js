'use strict';
/**
 * OmniSMS — Routes Messages
 *
 * Utilise Firestore comme base de données.
 * Aucune dépendance Mongoose/Parse.
 */

const express      = require('express');
const router       = express.Router();
const db           = require('../config/firebase');
const authenticate = require('../middleware/authenticate');
const { logger }   = require('../middleware/logger');

// ── POST /messages/send ──────────────────────────────────────
router.post('/send', authenticate, async (req, res) => {
  const { receiverId, content, type = 'text' } = req.body;

  if (!receiverId || !content) {
    return res.status(400).json({ error: 'receiverId et content sont requis.', code: 'MISSING_FIELDS' });
  }

  try {
    const now = new Date().toISOString();
    const msgData = {
      senderId  : req.user.uid,
      receiverId,
      content   : content.trim(),
      type,
      reactions : [],
      createdAt : now,
      updatedAt : now,
    };

    const ref = await db.collection('messages').add(msgData);

    // Notification temps réel via Socket.IO (non bloquant)
    if (type === 'text') {
      try {
        const { emitToUser } = require('../services/socketService');
        emitToUser(receiverId, 'message:receive', { id: ref.id, ...msgData });
      } catch (_) {
        // Socket.IO peut ne pas être initialisé — non bloquant
      }
    }

    logger.info('Message envoyé', { messageId: ref.id, senderId: req.user.uid });
    return res.status(201).json({ message: 'Message envoyé avec succès.', data: { id: ref.id, ...msgData } });
  } catch (err) {
    logger.error('Erreur envoi message', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── GET /messages/:userId ────────────────────────────────────
router.get('/:userId', authenticate, async (req, res) => {
  const { userId } = req.params;

  // Un utilisateur ne peut lire que ses propres messages
  if (req.user.uid !== userId) {
    return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
  }

  try {
    const [sent, received] = await Promise.all([
      db.collection('messages').where('senderId', '==', userId).orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('messages').where('receiverId', '==', userId).orderBy('createdAt', 'desc').limit(100).get(),
    ]);

    const messages = [
      ...sent.docs.map(d => ({ id: d.id, ...d.data() })),
      ...received.docs.map(d => ({ id: d.id, ...d.data() })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json(messages);
  } catch (err) {
    logger.error('Erreur récupération messages', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── POST /messages/:id/react ─────────────────────────────────
router.post('/:id/react', authenticate, async (req, res) => {
  const { id }    = req.params;
  const { emoji } = req.body;

  if (!emoji) {
    return res.status(400).json({ error: 'emoji est requis.', code: 'MISSING_FIELDS' });
  }

  try {
    const ref  = db.collection('messages').doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Message non trouvé.', code: 'NOT_FOUND' });
    }

    const reactions = snap.data().reactions || [];
    reactions.push({ userId: req.user.uid, emoji, at: new Date().toISOString() });

    await ref.update({ reactions, updatedAt: new Date().toISOString() });
    return res.status(200).json({ message: 'Réaction ajoutée avec succès.' });
  } catch (err) {
    logger.error('Erreur réaction message', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── DELETE /messages/:id ─────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const ref  = db.collection('messages').doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Message non trouvé.', code: 'NOT_FOUND' });
    }

    if (snap.data().senderId !== req.user.uid) {
      return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres messages.', code: 'FORBIDDEN' });
    }

    await ref.delete();
    return res.status(200).json({ message: 'Message supprimé avec succès.' });
  } catch (err) {
    logger.error('Erreur suppression message', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
