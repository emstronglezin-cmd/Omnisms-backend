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
const {
  resolveUserByPhone,
  resolveUserByUsername,
  resolveUserByUid,
} = require('../services/userResolver');

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

// ── GET /groups/:id — Récupérer un groupe ───────────────────
router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const ref  = db.collection('groups').doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
    }
    const data = snap.data();
    if (!(data.members || []).includes(req.user.uid) && data.ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
    }
    return res.status(200).json({ id: snap.id, ...data });
  } catch (err) {
    logger.error('Erreur récupération groupe', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ── POST /groups/:id/members — Ajouter des membres ──────────
// Accepte un tableau "members" où chaque entrée peut être :
//   - un UID Firestore (alphanumérique)
//   - un numéro de téléphone (+226xxx)
//   - un username (@username)
router.post('/:id/members', authenticate, async (req, res) => {
  const { id } = req.params;
  // P4 FIX: Accepter soit un tableau `members` (ancien format)
  // soit un identifiant unique `identifier` (nouveau format envoyé par le modal d'édition)
  let rawMembers = req.body.members;
  if (!rawMembers && req.body.identifier) {
    rawMembers = [req.body.identifier];
  }
  const members = rawMembers;

  if (!members || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'members (tableau d\'UIDs, phones ou usernames) ou identifier requis.', code: 'MISSING_FIELDS' });
  }

  try {
    const ref  = db.collection('groups').doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
    }

    const data = snap.data();

    // Admins et propriétaires peuvent ajouter des membres
    const isOwner = data.ownerId === req.user.uid;
    const admins  = data.admins || [];
    const isAdmin = admins.includes(req.user.uid);
    const isMember = (data.members || []).includes(req.user.uid);

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Seul le propriétaire ou un administrateur peut ajouter des membres.', code: 'FORBIDDEN' });
    }

    // Résoudre chaque identifiant → UID réel
    const resolved  = [];
    const failed    = [];
    const PHONE_RE  = /^\+?[0-9\s\-()+]{7,20}$/;
    const USERNAME_RE = /^@?[a-zA-Z0-9_.-]{2,50}$/;

    for (const identifier of members) {
      if (!identifier || typeof identifier !== 'string') continue;
      const s = identifier.trim();
      let uid = null;

      if (PHONE_RE.test(s) && !s.includes('-')) {
        // Numéro de téléphone
        const r = await resolveUserByPhone(s, { includeDeleted: false });
        if (r.found) uid = r.uid;
      } else if (USERNAME_RE.test(s)) {
        const clean = s.startsWith('@') ? s.slice(1) : s;
        // Essayer username d'abord
        const r = await resolveUserByUsername(clean, { includeDeleted: false });
        if (r.found) {
          uid = r.uid;
        } else {
          // Peut-être un UID direct
          const r2 = await resolveUserByUid(s, { includeDeleted: false });
          if (r2.found) uid = r2.uid;
        }
      } else {
        // UID direct
        const r = await resolveUserByUid(s, { includeDeleted: false });
        if (r.found) uid = r.uid;
      }

      if (uid) {
        resolved.push(uid);
      } else {
        failed.push({ identifier: s, reason: 'Utilisateur OmniSMS introuvable' });
        logger.warn('[Groups] Could not resolve member identifier', { identifier: s, groupId: id });
      }
    }

    if (resolved.length === 0 && failed.length > 0) {
      return res.status(400).json({
        error : 'Aucun utilisateur OmniSMS trouvé pour les identifiants fournis.',
        code  : 'NO_MEMBERS_RESOLVED',
        failed,
      });
    }

    const current = data.members || [];
    const merged  = [...new Set([...current, ...resolved])];

    await ref.update({ members: merged, updatedAt: new Date().toISOString() });

    const updated = await ref.get();
    const updatedData = updated.data();

    // Notifier les nouveaux membres via Socket.IO
    try {
      const { emitToUser } = require('../services/socketService');
      const newlyAdded = resolved.filter(uid => !current.includes(uid));
      newlyAdded.forEach(memberUid => {
        emitToUser(memberUid, 'group:added', {
          groupId  : id,
          groupName: updatedData.name || id,
          addedBy  : req.user.uid,
          timestamp: new Date().toISOString(),
        });
      });
    } catch (_) {}

    logger.info('[Groups] Members added', {
      groupId : id,
      addedBy : req.user.uid,
      resolved: resolved.length,
      failed  : failed.length,
    });

    return res.status(200).json({
      id     : updated.id,
      ...updatedData,
      addedCount : resolved.length,
      failedCount: failed.length,
      failed,
    });
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
// Stratégie: stockage base64 dans Firestore (résout ephemeral FS Render)
// Accepte multipart (champ "image") OU body JSON { imageBase64: "data:image/..." }
const MAX_GROUP_IMG_B64 = 800 * 1024; // 800 KB

let groupImageUpload    = null;
let groupMulterErrHndlr = null;
try {
  const uploadService  = require('../services/uploadService');
  groupImageUpload     = uploadService.imageUpload;
  groupMulterErrHndlr = uploadService.multerErrorHandler;
} catch (_) {}

router.post('/:id/avatar', authenticate, (req, res, next) => {
  // Cas JSON base64 direct
  if (req.is('application/json') || req.body?.imageBase64) return next();

  // Cas multipart — wrap multer pour capturer les erreurs proprement
  if (groupImageUpload) {
    groupImageUpload.single('image')(req, res, (err) => {
      if (err) {
        logger.warn('[Groups] Multer error on group avatar upload', { error: err.message, code: err.code });
        if (groupMulterErrHndlr) return groupMulterErrHndlr(err, req, res, next);
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Fichier trop volumineux.', code: 'FILE_TOO_LARGE' });
        if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Champ inattendu. Utilisez le champ "image".', code: 'UNEXPECTED_FIELD' });
        return res.status(400).json({ error: err.message || 'Erreur upload.', code: 'UPLOAD_ERROR' });
      }
      next();
    });
  } else {
    next();
  }
}, async (req, res) => {
  const { id } = req.params;
  try {
    const ref  = db.collection('groups').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Groupe non trouvé.', code: 'NOT_FOUND' });
    if (snap.data().ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Seul le propriétaire peut modifier l\'image.', code: 'FORBIDDEN' });
    }

    let imageBase64 = null;

    // A) Fichier multipart → convertir en base64
    if (req.file) {
      const fs   = require('fs');
      const mime = req.file.mimetype || 'image/jpeg';
      const buf  = fs.readFileSync(req.file.path);
      const b64  = buf.toString('base64');
      if (b64.length > MAX_GROUP_IMG_B64) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(413).json({ error: 'Image trop grande (max ~600 KB). Compressez et réessayez.', code: 'IMAGE_TOO_LARGE' });
      }
      imageBase64 = `data:${mime};base64,${b64}`;
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }

    // B) base64 JSON direct
    else if (req.body?.imageBase64) {
      const raw = req.body.imageBase64;
      if (!raw.startsWith('data:image/')) return res.status(400).json({ error: 'imageBase64 doit être un data URI image.', code: 'INVALID_DATA_URI' });
      if (raw.length > MAX_GROUP_IMG_B64) return res.status(413).json({ error: 'Image trop grande.', code: 'IMAGE_TOO_LARGE' });
      imageBase64 = raw;
    }

    else {
      return res.status(400).json({ error: 'Aucun fichier fourni. Champ multipart: "image" ou body JSON: "imageBase64".', code: 'NO_FILE' });
    }

    // Stocker base64 dans Firestore (persistant après redeploy Render)
    await ref.update({ image: imageBase64, updatedAt: new Date().toISOString() });
    logger.info('[Groups] Group avatar updated (base64 in Firestore)', { groupId: id });
    return res.status(200).json({ success: true, imageUrl: imageBase64 });
  } catch (err) {
    logger.error('Erreur upload image groupe', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

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
