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
      .get();

    // Sort in-memory (avoids composite index requirement)
    const groups = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

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

// ── PUT /groups/:id — Modifier un groupe (nom, image, icône) ─
router.put('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  const { name, image, icon, description } = req.body;

  try {
    const ref  = db.collection('groups').doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
    }

    if (snap.data().ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Seul le propriétaire peut modifier le groupe.', code: 'FORBIDDEN' });
    }

    const updates = { updatedAt: new Date().toISOString() };
    if (name        !== undefined) updates.name        = String(name).trim();
    if (image       !== undefined) updates.image       = image;
    if (icon        !== undefined) updates.icon        = icon;
    if (description !== undefined) updates.description = String(description).trim();

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.', code: 'NO_FIELDS' });
    }

    await ref.update(updates);
    const updated = await ref.get();

    logger.info('Groupe mis à jour', { groupId: id, owner: req.user.uid });
    return res.status(200).json({ id: updated.id, ...updated.data() });
  } catch (err) {
    logger.error('Erreur mise à jour groupe', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── POST /groups/:id/avatar — Upload image de groupe ─────────
let groupImageUpload = null;
let groupBuildFileUrl = null;
try {
  const uploadService  = require('../services/uploadService');
  groupImageUpload     = uploadService.imageUpload;
  groupBuildFileUrl    = uploadService.buildFileUrl;
} catch (_) {}

if (groupImageUpload && groupBuildFileUrl) {
  router.post('/:id/avatar', authenticate, groupImageUpload.single('image'), async (req, res) => {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni.', code: 'NO_FILE' });
    }
    try {
      const ref  = db.collection('groups').doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
      if (snap.data().ownerId !== req.user.uid) {
        return res.status(403).json({ error: 'Seul le propriétaire peut modifier l\'image.', code: 'FORBIDDEN' });
      }
      const imageUrl = groupBuildFileUrl('images', req.file.filename);
      await ref.update({ image: imageUrl, updatedAt: new Date().toISOString() });
      return res.status(200).json({ success: true, imageUrl });
    } catch (err) {
      logger.error('Erreur upload image groupe', { error: err.message });
      return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
    }
  });
}

// ── GET /groups/:id/members — Lister les membres ────────────
router.get('/:id/members', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const ref  = db.collection('groups').doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
    }

    const data = snap.data();
    if (!(data.members || []).includes(req.user.uid)) {
      return res.status(403).json({ error: 'Vous n\'êtes pas membre de ce groupe.', code: 'FORBIDDEN' });
    }

    // Enrichir avec les données utilisateur (name, avatar) depuis Firestore
    const memberIds = data.members || [];
    const memberDetails = [];

    for (let i = 0; i < memberIds.length; i += 10) {
      const batch = memberIds.slice(i, i + 10);
      try {
        const userDocs = await Promise.all(
          batch.map(uid => db.collection('users').doc(uid).get())
        );
        userDocs.forEach((doc, idx) => {
          const uid = batch[idx];
          if (doc.exists) {
            const u = doc.data();
            memberDetails.push({
              uid,
              name    : u.name     || u.username || uid,
              username: u.username || null,
              avatar  : u.avatar   || null,
              phone   : u.phone    || null,
              isOwner : uid === data.ownerId,
            });
          } else {
            memberDetails.push({ uid, name: uid, isOwner: uid === data.ownerId });
          }
        });
      } catch (_) {
        batch.forEach(uid => memberDetails.push({ uid, name: uid, isOwner: uid === data.ownerId }));
      }
    }

    return res.status(200).json({
      id,
      name   : data.name,
      ownerId: data.ownerId,
      members: memberDetails,
    });
  } catch (err) {
    logger.error('Erreur liste membres groupe', { error: err.message });
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

    // NOTE: NO orderBy('createdAt') — requires composite Firestore index which may not exist.
    // We fetch without ordering and sort in-memory (avoids FAILED_PRECONDITION / infinite loading).
    const snap = await db
      .collection('group_messages')
      .where('groupId', '==', id)
      .limit(100)
      .get();

    const messages = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));  // ASC for chat display

    return res.status(200).json(messages);
  } catch (err) {
    logger.error('Erreur messages groupe', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── PUT /groups/:id/admin — Changer l'administrateur ────────
router.put('/:id/admin', authenticate, async (req, res) => {
  const { id }      = req.params;
  const { newOwner } = req.body;

  if (!newOwner) {
    return res.status(400).json({ error: 'newOwner est requis.', code: 'MISSING_FIELDS' });
  }

  try {
    const ref  = db.collection('groups').doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
    }

    const data = snap.data();
    if (data.ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Seul le propriétaire peut changer l\'admin.', code: 'FORBIDDEN' });
    }

    if (!data.members.includes(newOwner)) {
      return res.status(400).json({ error: 'Le nouvel admin doit être membre du groupe.', code: 'NOT_MEMBER' });
    }

    await ref.update({
      ownerId  : newOwner,
      updatedAt: new Date().toISOString(),
    });

    logger.info('Admin groupe changé', { groupId: id, from: req.user.uid, to: newOwner });
    return res.status(200).json({ success: true, groupId: id, newOwner });
  } catch (err) {
    logger.error('Erreur changement admin groupe', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
