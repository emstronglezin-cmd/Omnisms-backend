'use strict';
/**
 * OmniSMS — Service Routage des Messages (Source de Vérité)
 *
 * SEULE logique qui décide : OmniSMS (Socket.IO) ou SMS (Infobip).
 * Toutes les routes qui envoient des messages doivent passer ici.
 *
 * Architecture :
 *
 *   message entrant
 *       ↓
 *   normalizePhone()
 *       ↓
 *   resolveUserByPhone()
 *       ↓
 *   ┌── OmniSMS trouvé ──┐       ┌── Pas trouvé ──┐
 *   │  → UID réel         │       │  → externe      │
 *   │  → Firestore        │       │  → Firestore    │
 *   │  → Socket.IO        │       │  → Infobip SMS  │
 *   └────────────────────┘       └────────────────┘
 *
 * Fonctions exportées :
 *   routeMessage(opts)            → { route, conversationId, messageId, ... }
 *   makeConversationId(a, b)      → "uid1-uid2" (déterministe)
 *   makeExternalConvId(uid, phone)→ "ext-uid-phone" (stable, pour SMS externes)
 *   getOrCreateExternalConv(db, ownerUid, externalPhone, externalName)
 */

const { normalizePhone }       = require('./phoneNormalizer');
const { resolveUserByPhone }   = require('./userResolver');
const { logger }               = require('../middleware/logger');

/* ── conversationId helpers ─────────────────────────────────── */

/**
 * ID déterministe pour une conversation OmniSMS ↔ OmniSMS.
 * sort([uid1, uid2]).join('-')
 * → A→B et B→A donnent exactement le même ID.
 */
function makeConversationId(uid1, uid2) {
  if (!uid1 || !uid2) throw new Error('makeConversationId: uid1 et uid2 requis');
  return [uid1, uid2].sort().join('-');
}

/**
 * ID stable pour une conversation OmniSMS ↔ utilisateur SMS externe.
 * Format : "ext-{ownerUid}-{e164phone}"
 * Toujours basé sur le UID du propriétaire OmniSMS + le numéro E.164 externe.
 */
function makeExternalConvId(ownerUid, externalPhone) {
  const e164 = normalizePhone(externalPhone) || externalPhone.replace(/\s/g, '');
  return `ext-${ownerUid}-${e164}`;
}

/* ── Gestion des conversations externes (SMS) ───────────────── */

/**
 * Crée ou récupère une conversation externe dans Firestore.
 * La conversation externe lie un utilisateur OmniSMS à un numéro SMS.
 *
 * Structure Firestore (collection: external_conversations) :
 * {
 *   conversationId : "ext-ownerUid-+22670000000",
 *   ownerUid       : "OMNISMS_UID",
 *   externalPhone  : "+22670000000",
 *   externalName   : "Jean Dupont" | null,
 *   infobipNumber  : "+22600000000" | null,  // Numéro Infobip utilisé (item.to)
 *   channel        : "sms",
 *   createdAt,
 *   updatedAt,
 *   lastMessageAt,
 *   lastMessage    : "...",
 *   providerMessageIds: [],                  // IDs messages Infobip (pour DLR)
 * }
 *
 * @param {object} db
 * @param {string} ownerUid        - UID OmniSMS du propriétaire
 * @param {string} externalPhone   - Numéro externe (E.164)
 * @param {string|null} externalName   - Nom local du contact
 * @param {string|null} infobipNumber  - Numéro Infobip utilisé (item.to depuis webhook)
 * @returns {object} La conversation (avec son conversationId)
 */
async function getOrCreateExternalConv(db, ownerUid, externalPhone, externalName = null, infobipNumber = null) {
  if (!db || !ownerUid || !externalPhone) return null;

  const e164   = normalizePhone(externalPhone) || externalPhone;
  const convId = makeExternalConvId(ownerUid, e164);

  try {
    const ref  = db.collection('external_conversations').doc(convId);
    const snap = await ref.get();

    if (snap.exists) {
      // Mettre à jour les champs si fournis et différents
      const existing = snap.data();
      const updates  = {};
      if (externalName  && externalName  !== existing.externalName)  updates.externalName  = externalName;
      if (infobipNumber && infobipNumber !== existing.infobipNumber) updates.infobipNumber = infobipNumber;
      if (Object.keys(updates).length > 0) {
        updates.updatedAt = new Date().toISOString();
        await ref.update(updates).catch(() => {});
      }
      return { conversationId: convId, ...existing, ...updates };
    }

    // Créer la conversation externe
    const now  = new Date().toISOString();
    const conv = {
      conversationId    : convId,
      ownerUid,
      externalPhone     : e164,
      externalName      : externalName  || null,
      infobipNumber     : infobipNumber || null,
      channel           : 'sms',
      createdAt         : now,
      updatedAt         : now,
      lastMessageAt     : now,
      lastMessage       : null,
      providerMessageIds: [],
    };

    await ref.set(conv);
    logger.info('[MessageRouter] External conversation created', {
      convId,
      ownerUid,
      externalPhone: e164.replace(/\d{4}$/, '****'),
      infobipNumber: infobipNumber || null,
    });
    return conv;

  } catch (err) {
    logger.warn('[MessageRouter] getOrCreateExternalConv error', { error: err.message });
    // Retourner un objet minimal même en cas d'erreur Firestore
    return {
      conversationId: convId,
      ownerUid,
      externalPhone : e164,
      externalName  : externalName  || null,
      infobipNumber : infobipNumber || null,
      channel       : 'sms',
    };
  }
}

/**
 * Retrouve la conversation externe à partir du numéro de l'expéditeur SMS.
 * Utilisé lors de la réception d'un webhook Infobip.
 *
 * @param {object} db
 * @param {string} externalPhone   - Numéro de l'expéditeur externe (from)
 * @param {string} infobipNumber   - Numéro Infobip destinataire (to) — identifie le propriétaire
 * @returns {object|null}          - La conversation si trouvée, null sinon
 */
async function findExternalConvByPhone(db, externalPhone, infobipNumber = null) {
  if (!db || !externalPhone) return null;

  const e164 = normalizePhone(externalPhone) || externalPhone;

  try {
    // Rechercher toutes les conversations avec ce numéro externe
    const snap = await db.collection('external_conversations')
      .where('externalPhone', '==', e164)
      .limit(10)
      .get();

    if (snap.empty) return null;

    // Si on a le numéro Infobip, filtrer par le propriétaire qui possède ce numéro
    // (dans le cas où plusieurs utilisateurs OmniSMS utilisent le même service Infobip,
    //  ce qui est rare mais possible)
    if (infobipNumber && snap.docs.length > 1) {
      // Trouver le propriétaire du numéro Infobip
      const owner = await resolveUserByPhone(infobipNumber);
      if (owner.found) {
        const owned = snap.docs.find(d => d.data().ownerUid === owner.uid);
        if (owned) return { conversationId: owned.id, ...owned.data() };
      }
    }

    // Retourner la conversation la plus récente
    const sorted = snap.docs
      .map(d => ({ conversationId: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.lastMessageAt || b.updatedAt || 0) - new Date(a.lastMessageAt || a.updatedAt || 0));

    return sorted[0] || null;

  } catch (err) {
    logger.warn('[MessageRouter] findExternalConvByPhone error', { error: err.message });
    return null;
  }
}

/**
 * Met à jour lastMessage dans une conversation externe.
 * @param {object}      db
 * @param {string}      conversationId
 * @param {string}      content
 * @param {string|null} [providerMessageId]  - ID du message Infobip (pour DLR)
 */
async function updateExternalConvLastMessage(db, conversationId, content, providerMessageId = null) {
  if (!db || !conversationId) return;
  try {
    const update = {
      lastMessage   : content || '',
      lastMessageAt : new Date().toISOString(),
      updatedAt     : new Date().toISOString(),
    };
    // Stocker l'ID Infobip dans la liste providerMessageIds
    if (providerMessageId) {
      const { FieldValue } = require('firebase-admin/firestore');
      update.providerMessageIds = FieldValue.arrayUnion(providerMessageId);
    }
    await db.collection('external_conversations').doc(conversationId).update(update);
  } catch (_) {}
}

/* ── Routage central des messages ───────────────────────────── */

/**
 * Décide du canal de livraison et envoie le message.
 *
 * @param {object} opts
 * @param {string}   opts.senderUid        - UID de l'expéditeur OmniSMS
 * @param {string}   opts.targetPhone      - Numéro cible (brut, n'importe quel format)
 *                                            OR opts.targetUid si on connaît déjà l'UID
 * @param {string}  [opts.targetUid]       - UID cible si déjà résolu
 * @param {string}   opts.content          - Contenu du message texte
 * @param {string}  [opts.type='text']     - 'text' | 'audio' | 'image'
 * @param {string}  [opts.audioUrl]        - URL audio si type=audio
 * @param {number}  [opts.duration]        - Durée audio
 * @param {string}  [opts.senderName]      - Nom de l'expéditeur (pour SMS)
 * @param {string}  [opts.senderPhone]     - Téléphone de l'expéditeur (pour SMS header)
 * @param {string}  [opts.messageId]       - ID pré-généré (optionnel)
 * @param {object}  [opts.db]              - Instance Firestore (optionnel, lazy si absent)
 *
 * @returns {Promise<{
 *   route: 'OMNISMS' | 'INFOBIP' | 'ERROR',
 *   conversationId: string,
 *   messageId: string,
 *   resolvedUid?: string,
 *   smsResult?: object,
 *   error?: string
 * }>}
 */
async function routeMessage(opts = {}) {
  const {
    senderUid,
    targetPhone,
    targetUid: preResolvedUid,
    content,
    type       = 'text',
    audioUrl   = null,
    duration   = null,
    senderName = null,
    senderPhone= null,
    messageId  : preMessageId = null,
    db         : dbParam      = null,
  } = opts;

  if (!senderUid) {
    logger.error('[ROUTING] routeMessage: senderUid manquant');
    return { route: 'ERROR', error: 'senderUid manquant' };
  }

  const db  = dbParam || (function() {
    try {
      const d = require('../config/firebase');
      return d && !d._stub ? d : null;
    } catch (_) { return null; }
  })();

  const now = new Date().toISOString();
  const msgId = preMessageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /* ── 1. Résolution OmniSMS ───────────────────────────────── */
  let resolvedUid      = preResolvedUid || null;
  let resolvedUserInfo = null;

  // Si targetPhone fourni et pas encore résolu
  if (targetPhone && !resolvedUid) {
    const resolution = await resolveUserByPhone(targetPhone);
    if (resolution.found) {
      resolvedUid      = resolution.uid;
      resolvedUserInfo = resolution;
    }
  }

  // Si targetUid fourni (déjà un UID), vérifier qu'il existe
  if (targetPhone && /^\+?[0-9\s\-()+]{7,20}$/.test(targetPhone) === false && !preResolvedUid) {
    // targetPhone est en fait un UID Firestore
    resolvedUid = targetPhone;
  }

  /* ── 2. Route : OmniSMS ──────────────────────────────────── */
  if (resolvedUid) {
    const convId = makeConversationId(senderUid, resolvedUid);

    const msg = {
      id            : msgId,
      senderId      : senderUid,
      receiverId    : resolvedUid,
      conversationId: convId,
      content       : content ? content.trim() : null,
      type,
      channel       : 'app',
      audioUrl      : audioUrl || null,
      duration      : duration || null,
      status        : 'sent',
      reactions     : [],
      transcription : null,
      transcriptionStatus: type === 'audio' ? 'pending' : null,
      createdAt     : now,
      updatedAt     : now,
    };

    // Sauvegarde Firestore
    let savedId = msgId;
    if (db) {
      try {
        const ref = await db.collection('messages').add(msg);
        savedId = ref.id;
        msg.id  = savedId;
      } catch (dbErr) {
        logger.warn('[ROUTING] Firestore save failed (OmniSMS)', { error: dbErr.message });
      }

      // ── Si message audio : stocker receiverId sur audio_messages ──────
      // audio_messages ne connaît pas le destinataire (uploaderId seulement).
      // On le stocke maintenant pour permettre la vérification d'accès sur
      // GET /api/audio/:id sans requête secondaire coûteuse sur messages.
      if (type === 'audio' && audioUrl && savedId !== msgId) {
        try {
          // Extraire l'ID audio depuis l'URL ou la data URI
          // Le docId audio est stocké par audio.v2.js et référencé dans audioUrl
          // Format: /uploads/audio/{filename} ou data:audio/...;base64,...
          // On met à jour via une requête sur audioUrl
          const audioSnap = await db.collection('audio_messages')
            .where('url', '==', audioUrl)
            .limit(1)
            .get();
          if (!audioSnap.empty) {
            await audioSnap.docs[0].ref.update({
              receiverId: resolvedUid,
              updatedAt : new Date().toISOString(),
            }).catch(() => {});
          } else if (audioUrl.startsWith('data:')) {
            // base64 URI — chercher aussi par audioDataUri
            const audioSnap2 = await db.collection('audio_messages')
              .where('audioDataUri', '==', audioUrl)
              .limit(1)
              .get();
            if (!audioSnap2.empty) {
              await audioSnap2.docs[0].ref.update({
                receiverId: resolvedUid,
                updatedAt : new Date().toISOString(),
              }).catch(() => {});
            }
          }
        } catch (audioUpdateErr) {
          logger.warn('[ROUTING] Could not update receiverId on audio_messages', { error: audioUpdateErr.message });
        }
      }
    }

    // Socket.IO — délivraison temps réel
    try {
      const emitToUser = require('./socketService').emitToUser;
      emitToUser(resolvedUid, 'message:receive', msg);
    } catch (_) {}

    logger.info('[ROUTING] Message routed → OMNISMS', {
      senderUid,
      targetPhone: targetPhone ? targetPhone.replace(/\d{4}$/, '****') : '(uid direct)',
      resolvedUid,
      conversationId: convId,
      type,
      messageId: savedId,
    });

    return {
      route         : 'OMNISMS',
      conversationId: convId,
      messageId     : savedId,
      resolvedUid,
      message       : msg,
    };
  }

  /* ── 3. Route : Infobip SMS ──────────────────────────────── */
  // Destinataire n'a pas OmniSMS → SMS via Infobip
  const e164Target = normalizePhone(targetPhone) || (targetPhone || '').replace(/\s/g, '');

  let infobip = null;
  try { infobip = require('./infobip'); } catch (_) {}

  if (!infobip || !infobip.isConfigured()) {
    logger.warn('[ROUTING] Infobip non configuré — message externe non délivré', {
      senderUid,
      targetPhone: e164Target.replace(/\d{4}$/, '****'),
    });
  }

  // Créer/récupérer la conversation externe
  const extConv = await getOrCreateExternalConv(db, senderUid, e164Target, null);
  const convId  = extConv?.conversationId || makeExternalConvId(senderUid, e164Target);

  const msg = {
    id            : msgId,
    senderId      : senderUid,
    receiverId    : e164Target,
    conversationId: convId,
    content       : content ? content.trim() : null,
    type,
    channel       : 'sms',
    audioUrl      : audioUrl || null,
    duration      : duration || null,
    status        : 'pending',
    reactions     : [],
    createdAt     : now,
    updatedAt     : now,
  };

  // Sauvegarde Firestore
  let savedId = msgId;
  if (db) {
    try {
      const ref = await db.collection('messages').add(msg);
      savedId = ref.id;
      msg.id  = savedId;
      // Mettre à jour lastMessage dans la conversation externe
      await updateExternalConvLastMessage(db, convId, content || '[audio]');
    } catch (dbErr) {
      logger.warn('[ROUTING] Firestore save failed (Infobip)', { error: dbErr.message });
    }
  }

  // Envoi SMS via Infobip
  let smsResult = null;
  if (infobip && infobip.isConfigured() && type === 'text' && content) {
    try {
      // Construction du texte SMS avec header expéditeur
      const senderDisplay = senderName
        ? `${senderName}${senderPhone ? ` (${senderPhone})` : ''}`
        : (senderPhone || 'Un utilisateur OmniSMS');

      const smsText = `[OmniSMS] ${senderDisplay} : ${content.trim()}`;

      const deliveryUrl = `${process.env.RENDER_EXTERNAL_URL || 'https://omnisms-backend.onrender.com'}/api/webhooks/infobip/inbound`;

      smsResult = await infobip.sendSMS({
        to       : e164Target,
        text     : smsText,
        notifyUrl: deliveryUrl,
      });

      // Mettre à jour le statut du message + providerMessageId dans external conv
      if (db && savedId && savedId !== msgId) {
        await db.collection('messages').doc(savedId).update({
          status        : smsResult.success ? 'sent' : 'failed',
          smsMessageId  : smsResult.messageId || null,
          smsStatus     : smsResult.status    || null,
          updatedAt     : new Date().toISOString(),
        }).catch(() => {});
        if (smsResult.success && smsResult.messageId) {
          await updateExternalConvLastMessage(db, convId, content, smsResult.messageId).catch(() => {});
        }
      }

      logger.info('[ROUTING] Message routed → INFOBIP', {
        senderUid,
        targetPhone: e164Target.replace(/\d{4}$/, '****'),
        conversationId: convId,
        smsSuccess : smsResult.success,
        smsMessageId: smsResult.messageId || null,
      });

    } catch (smsErr) {
      logger.error('[ROUTING] Infobip sendSMS error', { error: smsErr.message });
      smsResult = { success: false, error: smsErr.message };
    }
  } else if (type !== 'text') {
    logger.info('[ROUTING] Audio/image → Infobip non supporté, message enregistré uniquement', {
      senderUid, type, convId,
    });
  }

  return {
    route         : 'INFOBIP',
    conversationId: convId,
    messageId     : savedId,
    externalPhone : e164Target,
    smsResult,
    message       : msg,
  };
}

module.exports = {
  routeMessage,
  makeConversationId,
  makeExternalConvId,
  getOrCreateExternalConv,
  findExternalConvByPhone,
  updateExternalConvLastMessage,
};
