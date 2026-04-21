'use strict';
/**
 * OmniSMS — Routes Groupes
 *
 * Utilise Firestore comme base de données.
 * Aucune dépendance Mongoose/Parse.
 */

const express      = require('express');
const router       = express.Router();
const db           = require('../config/firebase');
const authenticate = require('../middleware/authenticate');
const { logger }   = require('../middleware/logger');

// ── POST /groups — Créer un groupe ──────────────────────────
router.post('/', authenticate, async (req, res) => {
  const { name, members = [] } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name est requis.', code: 'MISSING_FIELDS' });
  }

  try {
    const now = new Date().toISOString();
    const groupData = {
      name,
      members : [...new Set([req.user.uid, ...members])],  // owner inclus
      ownerId : req.user.uid,
      createdAt: now,
      updatedAt: now,
    };

    const ref = await db.collection('groups').add(groupData);
    logger.info('Groupe créé', { groupId: ref.id, owner: req.user.uid });
    return res.status(201).json({ id: ref.id, ...groupData });
  } catch (err) {
    logger.error('Erreur création groupe', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── GET /groups — Lister les groupes de l'utilisateur ───────
router.get('/', authenticate, async (req, res) => {
  try {
    const snap = await db
      .collection('groups')
      .where('members', 'array-contains', req.user.uid)
      .orderBy('createdAt', 'desc')
      .get();

    const groups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.status(200).json(groups);
  } catch (err) {
    logger.error('Erreur liste groupes', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── POST /groups/:id/members — Ajouter des membres ──────────
router.post('/:id/members', authenticate, async (req, res) => {
  const { id }      = req.params;
  const { members } = req.body;

  if (!members || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'members (tableau) est requis.', code: 'MISSING_FIELDS' });
  }

  try {
    const ref  = db.collection('groups').doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
    }

    if (snap.data().ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Seul le propriétaire peut ajouter des membres.', code: 'FORBIDDEN' });
    }

    const current = snap.data().members || [];
    const merged  = [...new Set([...current, ...members])];

    await ref.update({ members: merged, updatedAt: new Date().toISOString() });
    const updated = await ref.get();
    return res.status(200).json({ id: updated.id, ...updated.data() });
  } catch (err) {
    logger.error('Erreur ajout membres', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── DELETE /groups/:id/members/:memberId — Retirer un membre
router.delete('/:id/members/:memberId', authenticate, async (req, res) => {
  const { id, memberId } = req.params;

  try {
    const ref  = db.collection('groups').doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
    }

    if (snap.data().ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Seul le propriétaire peut retirer des membres.', code: 'FORBIDDEN' });
    }

    const members = (snap.data().members || []).filter(m => m !== memberId);
    await ref.update({ members, updatedAt: new Date().toISOString() });

    const updated = await ref.get();
    return res.status(200).json({ id: updated.id, ...updated.data() });
  } catch (err) {
    logger.error('Erreur suppression membre', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── POST /groups/:id/messages — Envoyer un message de groupe
router.post('/:id/messages', authenticate, async (req, res) => {
  const { id }      = req.params;
  const { content } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'content est requis.', code: 'MISSING_FIELDS' });
  }

  try {
    const groupSnap = await db.collection('groups').doc(id).get();

    if (!groupSnap.exists) {
      return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
    }

    if (!(groupSnap.data().members || []).includes(req.user.uid)) {
      return res.status(403).json({ error: 'Vous n\'êtes pas membre de ce groupe.', code: 'FORBIDDEN' });
    }

    const now = new Date().toISOString();
    const msgData = {
      groupId  : id,
      senderId : req.user.uid,
      content  : content.trim(),
      createdAt: now,
    };

    const ref = await db.collection('group_messages').add(msgData);
    return res.status(201).json({ id: ref.id, ...msgData });
  } catch (err) {
    logger.error('Erreur message groupe', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── GET /groups/:id/messages — Récupérer les messages ───────
router.get('/:id/messages', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const groupSnap = await db.collection('groups').doc(id).get();

    if (!groupSnap.exists) {
      return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
    }

    if (!(groupSnap.data().members || []).includes(req.user.uid)) {
      return res.status(403).json({ error: 'Vous n\'êtes pas membre de ce groupe.', code: 'FORBIDDEN' });
    }

    const snap = await db
      .collection('group_messages')
      .where('groupId', '==', id)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.status(200).json(messages);
  } catch (err) {
    logger.error('Erreur messages groupe', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
