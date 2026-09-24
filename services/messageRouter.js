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

    // Si on a le numéro SIM destinataire (infobipNumber = to = numéro du Z Fold2),
    // filtrer par le propriétaire OmniSMS qui possède ce numéro SIM.
    // IMPORTANT: on applique ce filtre TOUJOURS (pas seulement quand docs.length > 1)
    // pour garantir que le bon ownerUid est retourné même s'il n'y a qu'un seul résultat.
    if (infobipNumber) {
      const owner = await resolveUserByPhone(infobipNumber);
      if (owner.found) {
        const owned = snap.docs.find(d => d.data().ownerUid === owner.uid);
        if (owned) {
          logger.info('[MessageRouter] findExternalConvByPhone → filtre SIM owner appliqué', {
            ownerUid : owner.uid,
            convId   : owned.id,
          });
          return { conversationId: owned.id, ...owned.data() };
        }
        // Propriétaire du numéro SIM trouvé mais aucune conversation externe pour ce couple
        // → retourner null pour que l'appelant crée/retrouve la conv via ownerUid
        logger.info('[MessageRouter] findExternalConvByPhone → owner SIM trouvé, pas de conv externe pour ce couple', {
          ownerUid   : owner.uid,
          externalPhone: e164.replace(/\d{4}$/, '****'),
        });
        return null;
      }
    }

    // Pas de numéro SIM fourni ou owner non résolu :
    // retourner la conversation la plus récente (comportement dégradé)
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

  // Si on a un UID (préresolu ou via targetUid) mais pas d'info utilisateur,
  // récupérer les infos pour obtenir le numéro de téléphone (nécessaire pour
  // le fallback SMS si le destinataire est offline).
  if (resolvedUid && !resolvedUserInfo) {
    try {
      const { resolveUserByUid } = require('./userResolver');
      const userInfo = await resolveUserByUid(resolvedUid);
      if (userInfo && userInfo.found) {
        resolvedUserInfo = userInfo;
      }
    } catch (_) { /* userResolver non disponible */ }
  }

  /* ── 2. Route : OmniSMS ──────────────────────────────────── */
  // RÈGLE ABSOLUE : "Compte existant ≠ utilisateur connecté."
  // On ne route vers OmniSMS QUE si l'utilisateur est réellement connecté
  // (session Socket.IO active). Sinon → SMS fallback vers son numéro réel.
  let recipientIsOnline = false;
  if (resolvedUid) {
    try {
      const socketSvc = require('./socketService');

      // 1. Vérification Redis (source de vérité principale)
      recipientIsOnline = await socketSvc.isUserOnline(resolvedUid);

      // 2. Fallback Socket.IO room si Redis vide (connexion récente)
      if (!recipientIsOnline) {
        const io = socketSvc.getIO ? socketSvc.getIO() : null;
        if (io) {
          try {
            const sockets = await io.in(`user:${resolvedUid}`).fetchSockets();
            recipientIsOnline = sockets.length > 0;
            if (recipientIsOnline) {
              logger.info('[ROUTING] Présence confirmée via Socket.IO room (Redis vide)', {
                resolvedUid,
                socketsCount: sockets.length,
              });
            }
          } catch (_) { /* fetchSockets non disponible */ }
        }
      }
    } catch (_) {
      // socketService non disponible → supposer offline (dégradation sécurisée)
      recipientIsOnline = false;
    }

    logger.info('[ROUTING] Vérification présence destinataire', {
      senderUid,
      resolvedUid,
      recipientOnline: recipientIsOnline,
      targetPhone: targetPhone ? targetPhone.replace(/\d{4}$/, '****') : '(uid direct)',
    });
  }

  if (resolvedUid && recipientIsOnline) {
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
        // SESSION 13 (NOTIFICATIONS) : ne pas persister l'id temporaire `msg-…`.
        // L'ID canonique est l'ID du document Firestore : c'est celui du payload
        // Socket.IO, de la réponse POST /send et de GET /conversation
        // ({ id: d.id, ...d.data() } — un champ `id` stocké l'écraserait).
        const { id: _tempId, ...msgToStore } = msg;
        const ref = await db.collection('messages').add(msgToStore);
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
    logger.info('[NOTIFICATION] Message sauvegardé → destinataire en ligne → émission message:receive', {
      senderUid,
      recipientUid  : resolvedUid,
      presence      : 'online',
      messageId     : msg.id,
      persisted     : savedId !== msgId,
      conversationId: convId,
      type,
    });
    try {
      const emitToUser = require('./socketService').emitToUser;
      emitToUser(resolvedUid, 'message:receive', msg);
    } catch (emitErr) {
      logger.warn('[NOTIFICATION] Émission Socket.IO impossible', { recipientUid: resolvedUid, error: emitErr.message });
    }

    logger.info('[ROUTING] Message routed → OMNISMS', {
      senderUid,
      senderPhone   : opts.senderPhone ? opts.senderPhone.replace(/\d{4}$/, '****') : null,
      targetPhone   : targetPhone ? targetPhone.replace(/\d{4}$/, '****') : '(uid direct)',
      resolvedUid,
      recipientOnline: true,
      route          : 'OMNISMS',
      conversationId : convId,
      type,
      messageId      : savedId,
    });

    return {
      route         : 'OMNISMS',
      conversationId: convId,
      messageId     : savedId,
      resolvedUid,
      message       : msg,
    };
  }

  /* ── 3. Route : SMS externe ──────────────────────────────── */
  // Destinataire n'a pas OmniSMS OU possède OmniSMS mais est DÉCONNECTÉ.
  // → SMS via SMS Gateway (Z Fold2) ou Infobip (standby).
  //
  // RÈGLE CRITIQUE pour fallback offline :
  //   Si resolvedUid trouvé mais offline → utiliser resolvedUserInfo.phone comme destination.
  //   JAMAIS le numéro de l'expéditeur (senderUid/senderPhone) comme destination.
  //
  // e164Target = numéro DESTINATAIRE en E.164

  if (resolvedUid) {
    logger.info('[NOTIFICATION] Destinataire OmniSMS hors ligne → aucune émission Socket.IO (Firestore + SMS, comportement existant)', {
      senderUid,
      recipientUid: resolvedUid,
      presence    : 'offline',
      type,
    });
  }

  // Si le destinataire a un compte OmniSMS mais est offline : utiliser son numéro réel
  let e164Target;
  if (resolvedUid && !recipientIsOnline && resolvedUserInfo && resolvedUserInfo.phone) {
    // Compte OmniSMS existant mais déconnecté → SMS vers son numéro de téléphone réel
    e164Target = normalizePhone(resolvedUserInfo.phone) || resolvedUserInfo.phone;
    logger.info('[ROUTING] Destinataire OmniSMS OFFLINE → fallback SMS vers son numéro réel', {
      senderUid,
      resolvedUid,
      recipientPhone: e164Target ? e164Target.replace(/\d{4}$/, '****') : null,
    });
  } else {
    // Destinataire sans compte OmniSMS → utiliser le targetPhone fourni directement
    e164Target = normalizePhone(targetPhone) || (targetPhone || '').replace(/\s/g, '');
  }

  // Déterminer le transport Offline actif
  let smsGateway = null;
  let infobip    = null;
  let transport  = 'none';

  try { smsGateway = require('./smsGateway'); } catch (_) {}
  try { infobip    = require('./infobip');    } catch (_) {}

  // SESSION 13 — destinataire résolu SANS numéro de téléphone (ex : compte
  // créé via Google, username résolu dont le profil n'a pas de phone).
  // On n'appelle JAMAIS le provider SMS avec une destination vide : le
  // message reste en Firestore et sera livré en ligne.
  if (!e164Target) {
    logger.warn('[ROUTING] Destination SMS vide (destinataire sans numéro) — message en Firestore seulement, aucun SMS', {
      senderUid,
      resolvedUid: resolvedUid || null,
      targetPhone: targetPhone ? targetPhone.replace(/\d{4}$/, '****') : null,
      hint: 'Le profil Firestore du destinataire ne contient pas de numéro de téléphone.',
    });
  }

  const useGateway = smsGateway && smsGateway.isSmsGatewayProvider() && smsGateway.isConfigured();
  const useInfobip = infobip    && infobip.isConfigured();

  if (!e164Target) {
    transport = 'none'; // ne jamais appeler un provider sans destination
  } else if (useGateway) {
    transport = 'sms_gateway';
  } else if (useInfobip) {
    transport = 'infobip';
    logger.info('[ROUTING] SMS Gateway non configuré — utilisation Infobip (standby)', {
      senderUid,
      targetPhone: e164Target.replace(/\d{4}$/, '****'),
    });
  } else {
    logger.warn('[ROUTING] Aucun transport SMS configuré — message externe non délivré', {
      senderUid,
      targetPhone: e164Target.replace(/\d{4}$/, '****'),
      hint: 'Configurer INFINIREACH_API_KEY + INFINIREACH_FROM_NUMBER (INfiniReach Z Fold2) ou INFOBIP_API_KEY + INFOBIP_BASE_URL (standby)',
    });
  }

  // Créer/récupérer la conversation externe
  // SESSION 13 : sans numéro de destination, le message attend dans la
  // conversation OmniSMS (IDs déterministes) du couple sender/destinataire —
  // il sera lu quand l'utilisateur reconnectera (channel 'app').
  let convId;
  let msgChannel = 'sms';
  let msgReceiverId = e164Target;
  if (!e164Target && resolvedUid) {
    convId        = makeConversationId(senderUid, resolvedUid);
    msgChannel    = 'app';
    msgReceiverId = resolvedUid;
  } else {
    const extConv = await getOrCreateExternalConv(db, senderUid, e164Target, null);
    convId        = extConv?.conversationId || makeExternalConvId(senderUid, e164Target);
  }

  const msg = {
    id            : msgId,
    senderId      : senderUid,
    receiverId    : msgReceiverId,
    conversationId: convId,
    content       : content ? content.trim() : null,
    type,
    channel       : msgChannel,
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
      // SESSION 13 : ID canonique = ID du document (voir branche OMNISMS)
      const { id: _tempId, ...msgToStore } = msg;
      const ref = await db.collection('messages').add(msgToStore);
      savedId = ref.id;
      msg.id  = savedId;
      // Mettre à jour lastMessage dans la conversation externe
      await updateExternalConvLastMessage(db, convId, content || '[audio]');
    } catch (dbErr) {
      logger.warn('[ROUTING] Firestore save failed (SMS externe)', { error: dbErr.message });
    }
  }

  // Construction du texte SMS (commun aux deux transports)
  const senderDisplay = senderName
    ? `${senderName}${senderPhone ? ` (${senderPhone})` : ''}`
    : (senderPhone || 'Un utilisateur OmniSMS');
  const smsText = `[OmniSMS] ${senderDisplay} : ${content ? content.trim() : ''}`;

  let smsResult = null;

  if (transport !== 'none' && type === 'text' && content) {
    // ── Tentative directe (synchrone) ───────────────────────
    try {
      if (transport === 'sms_gateway') {
        // ── Transport principal : SMS Gateway Z Fold2 ────────
        smsResult = await smsGateway.sendSMS({
          to       : e164Target,
          text     : smsText,
          messageId: savedId !== msgId ? savedId : null,
          ttl      : 3600,
        });

        // Si Gateway échoue ET fallback Infobip activé → tenter Infobip
        // ⚠️  Pendant la phase de test INfiniReach : mettre OFFLINE_SMS_FALLBACK_TO_INFOBIP=false
        //     sur Render pour voir clairement les erreurs INfiniReach sans masquage Infobip.
        if (!smsResult.success && smsGateway.isInfobipFallbackEnabled() && useInfobip) {
          logger.warn('[ROUTING] SMS Gateway failed — tentative Infobip (fallback)', {
            to: e164Target.replace(/\d{4}$/, '****'),
            error: smsResult.error,
          });
          const deliveryUrl = `${process.env.RENDER_EXTERNAL_URL || 'https://omnisms-backend.onrender.com'}/api/webhooks/infobip/inbound`;
          const fallbackResult = await infobip.sendSMS({
            to       : e164Target,
            text     : smsText,
            notifyUrl: deliveryUrl,
          });
          if (fallbackResult.success) {
            smsResult = { ...fallbackResult, provider: 'infobip_fallback' };
            logger.info('[ROUTING] Infobip fallback réussi', {
              to: e164Target.replace(/\d{4}$/, '****'),
            });
          }
        }

      } else if (transport === 'infobip') {
        // ── Transport standby : Infobip ──────────────────────
        const deliveryUrl = `${process.env.RENDER_EXTERNAL_URL || 'https://omnisms-backend.onrender.com'}/api/webhooks/infobip/inbound`;
        smsResult = await infobip.sendSMS({
          to       : e164Target,
          text     : smsText,
          notifyUrl: deliveryUrl,
        });
      }

      // Mettre à jour le statut du message en Firestore
      if (db && savedId && savedId !== msgId) {
        const providerMsgId = smsResult?.messageId || smsResult?.gatewayMessageId || null;
        await db.collection('messages').doc(savedId).update({
          status        : smsResult?.success ? 'sent' : 'pending',
          smsMessageId  : providerMsgId,
          smsProvider   : smsResult?.provider || transport,
          smsStatus     : smsResult?.state || smsResult?.status || null,
          updatedAt     : new Date().toISOString(),
        }).catch(() => {});
        if (smsResult?.success && providerMsgId) {
          await updateExternalConvLastMessage(db, convId, content, providerMsgId).catch(() => {});
        }
      }

      // Si l'envoi direct a échoué → mettre en queue pour retry
      if (smsResult && !smsResult.success) {
        logger.warn('[ROUTING] SMS direct failed — enqueueing for retry', {
          to       : e164Target.replace(/\d{4}$/, '****'),
          messageId: savedId,
          transport,
          error    : smsResult.error,
        });
        try {
          const { enqueueSmsJob } = require('./smsQueueWorker');
          await enqueueSmsJob({
            to            : e164Target,
            text          : smsText,
            messageId     : savedId !== msgId ? savedId : null,
            conversationId: convId,
            ownerUid      : senderUid,
          });
        } catch (qErr) {
          logger.warn('[ROUTING] Could not enqueue SMS retry job', { error: qErr.message });
        }
      }

      logger.info('[ROUTING] Message routed → SMS_EXTERNE', {
        senderUid,
        senderPhone      : opts.senderPhone ? opts.senderPhone.replace(/\d{4}$/, '****') : null,
        targetPhone      : targetPhone ? targetPhone.replace(/\d{4}$/, '****') : null,
        normalizedTarget : e164Target ? e164Target.replace(/\d{4}$/, '****') : null,
        resolvedUid      : resolvedUid || null,
        recipientOnline  : false,
        route            : 'SMS_EXTERNE',
        transport,
        conversationId   : convId,
        messageId        : savedId,
        smsSuccess       : smsResult?.success,
        smsMessageId     : smsResult?.messageId || smsResult?.gatewayMessageId || null,
      });

    } catch (smsErr) {
      logger.error('[ROUTING] SMS send error', {
        transport,
        error: smsErr.message,
      });
      smsResult = { success: false, error: smsErr.message };
      // Enqueue for retry on exception
      try {
        const { enqueueSmsJob } = require('./smsQueueWorker');
        await enqueueSmsJob({
          to            : e164Target,
          text          : smsText,
          messageId     : savedId !== msgId ? savedId : null,
          conversationId: convId,
          ownerUid      : senderUid,
        });
      } catch (qErr) {
        logger.warn('[ROUTING] Could not enqueue SMS retry job after exception', { error: qErr.message });
      }
    }
  } else if (type === 'audio' && audioUrl) {
    // ── Message vocal → destinataire sans OmniSMS ou déconnecté ──────────
    // Règle : NE PAS envoyer le fichier audio par SMS.
    // Utiliser la transcription existante → envoyer le texte en SMS ordinaire.

    logger.info('[ROUTING] Message audio → destinataire SMS externe, transcription nécessaire', {
      senderUid, convId, audioUrl: (audioUrl || '').substring(0, 60),
    });

    let transcribedText = null;
    // SESSION 13 : état de la tentative SYNCHRONE (diagnostic). Un échec ici
    // n'est jamais définitif : la transcription asynchrone (transcriptionWorker)
    // reprend l'envoi SMS via continueAudioSmsAfterTranscription().
    let syncTranscription = 'not_attempted';
    try {
      const transcriptionService = require('./transcriptionService');
      // L'audioUrl peut être une URL https ou un chemin local
      let audioPath = null;

      if (audioUrl && (audioUrl.startsWith('/') || audioUrl.startsWith('./') || audioUrl.startsWith('uploads/'))) {
        // Chemin relatif local → absolu
        const path = require('path');
        audioPath = audioUrl.startsWith('/') ? audioUrl : path.join(__dirname, '..', audioUrl);
      } else if (audioUrl && audioUrl.startsWith('https://')) {
        // URL distante → télécharger dans un fichier temp avant transcription
        const https = require('https');
        const fs    = require('fs');
        const os    = require('os');
        const path  = require('path');
        const ext   = audioUrl.split('.').pop().split('?')[0] || 'mp3';
        audioPath   = path.join(os.tmpdir(), `omnisms-audio-${Date.now()}.${ext}`);
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(audioPath);
          https.get(audioUrl, (res) => {
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
          }).on('error', (err) => {
            fs.unlink(audioPath, () => {});
            reject(err);
          });
        });
      }

      if (audioPath) {
        syncTranscription = 'attempted';
        const result = await transcriptionService.transcribe({ audioPath, language: 'fr' });
        if (result && result.text && result.text.trim()) {
          transcribedText = result.text.trim();
          syncTranscription = 'done';
          logger.info('[ROUTING] Transcription réussie', {
            senderUid, chars: transcribedText.length, method: result.method,
          });
        } else {
          syncTranscription = 'empty';
        }
      }
    } catch (transcribeErr) {
      syncTranscription = 'failed';
      logger.warn('[ROUTING] Transcription échouée — message audio non délivré par SMS', {
        error: transcribeErr.message,
        senderUid,
        // SESSION 13 : échec de la tentative synchrone uniquement
        suite: 'transcription asynchrone (transcriptionWorker) → reprise SMS automatique',
      });
    }

    if (transcribedText && transport !== 'none') {
      // Envoyer le texte transcrit en SMS
      const senderDisplay = senderName
        ? `${senderName}${senderPhone ? ` (${senderPhone})` : ''}`
        : (senderPhone || 'Un utilisateur OmniSMS');
      const smsTextAudio = `[OmniSMS Vocal] ${senderDisplay} : ${transcribedText}`;

      try {
        let audioSmsResult = null;
        if (transport === 'sms_gateway') {
          audioSmsResult = await smsGateway.sendSMS({
            to       : e164Target,
            text     : smsTextAudio,
            messageId: savedId !== msgId ? savedId : null,
            ttl      : 3600,
          });
        } else if (transport === 'infobip') {
          const deliveryUrl = `${process.env.RENDER_EXTERNAL_URL || 'https://omnisms-backend.onrender.com'}/api/webhooks/infobip/inbound`;
          audioSmsResult = await infobip.sendSMS({
            to       : e164Target,
            text     : smsTextAudio,
            notifyUrl: deliveryUrl,
          });
        }

        // Mettre à jour le message Firestore avec la transcription et le statut
        if (db && savedId && savedId !== msgId) {
          await db.collection('messages').doc(savedId).update({
            transcription      : transcribedText,
            transcriptionStatus: 'completed',
            status             : audioSmsResult?.success ? 'sent' : 'pending',
            smsProvider        : transport,
            updatedAt          : new Date().toISOString(),
          }).catch(() => {});
        }

        logger.info('[ROUTING] Message vocal transcrit → SMS envoyé', {
          senderUid,
          targetPhone   : e164Target.replace(/\d{4}$/, '****'),
          transport,
          smsSuccess    : audioSmsResult?.success,
          transcriptLen : transcribedText.length,
        });
      } catch (audioSmsErr) {
        logger.error('[ROUTING] Envoi SMS vocal échoué après transcription', {
          error: audioSmsErr.message, senderUid,
        });
      }
    } else if (!transcribedText) {
      // SESSION 13 — ce n'est PAS un échec définitif : POST /api/messages/send
      // lance la transcription asynchrone ; dès que la transcription est
      // sauvegardée, transcriptionWorker appelle continueAudioSmsAfterTranscription()
      // qui envoie le TEXTE via la file SMS existante. Seul le worker peut
      // conclure à un échec réel (log « [AUDIO_SMS] Transcription réellement échouée »).
      logger.info('[ROUTING] Audio → SMS : transcription en attente (asynchrone) — l\'envoi SMS reprendra automatiquement après la transcription', {
        senderUid,
        convId,
        messageId        : savedId,
        syncTranscription,  // not_attempted (data URI) | attempted | empty | failed
        audioSource      : (audioUrl || '').startsWith('data:') ? 'data-uri' : 'url',
      });
    }
  } else if (type !== 'text') {
    logger.info('[ROUTING] Type non supporté pour SMS externe, message enregistré uniquement', {
      senderUid, type, convId,
    });
  }

  return {
    route         : 'SMS_EXTERNE',
    transport,
    conversationId: convId,
    messageId     : savedId,
    externalPhone : e164Target,
    smsResult,
    message       : msg,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * SESSION 13 — Reprise Audio → SMS après la transcription asynchrone
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Problème corrigé : routeMessage() route un vocal vers SMS (destinataire
 * externe ou OmniSMS hors ligne) AVANT que la transcription asynchrone
 * (transcriptionWorker, Groq) soit disponible. Le worker sauvegardait ensuite
 * la transcription… et le routage SMS n'était jamais repris.
 *
 * continueAudioSmsAfterTranscription() est appelée par le worker APRÈS la
 * sauvegarde de la transcription. Elle envoie le TEXTE transcrit via la file
 * SMS existante (smsQueueWorker → INfiniReach / Infobip, retries BullMQ).
 * Le fichier audio n'est JAMAIS envoyé par SMS.
 *
 * Idempotence (retries du worker, double déclenchement) :
 *   1. réservation atomique Firestore (transaction) : audioSmsStatus = 'queued'
 *      n'est posé qu'une seule fois par message ;
 *   2. jobId BullMQ `sms-{messageId}` (enqueueSmsJob) ;
 *   3. externalId INfiniReach `omnisms-{messageId}` (smsGateway.sendSMS).
 *
 * Champ Firestore ajouté sur messages/{id} : audioSmsStatus
 *   queued | sent | failed | transcription_failed |
 *   skipped_empty_transcription | skipped_no_transport | skipped_gateway_number
 */

const E164_RE                  = /^\+[1-9]\d{6,14}$/;
const AUDIO_SMS_SENT_STATUSES  = ['sent', 'delivered', 'read', 'seen'];
const AUDIO_SMS_LOCKED_MARKERS = ['queued', 'sent'];

function getContinuationDb(dbParam) {
  if (dbParam) return dbParam;
  try {
    const d = require('../config/firebase');
    return d && !d._stub ? d : null;
  } catch (_) { return null; }
}

function maskPhoneS13(p) {
  return p ? String(p).replace(/\d{4}$/, '****') : null;
}

/**
 * Un message Firestore est-il un vocal routé vers SMS, pas encore envoyé ?
 * @returns {{ eligible: boolean, reason?: string, to?: string }}
 */
function evaluateAudioSmsEligibility(msg) {
  if (!msg)                           return { eligible: false, reason: 'message_not_found' };
  if (msg.type !== 'audio')           return { eligible: false, reason: 'not_audio' };
  // channel 'app' = destinataire OmniSMS EN LIGNE, déjà livré par Socket.IO (A7)
  if (msg.channel !== 'sms')          return { eligible: false, reason: 'not_sms_route' };
  if (msg.direction === 'inbound')    return { eligible: false, reason: 'inbound_message' };
  const to = typeof msg.receiverId === 'string' ? msg.receiverId.trim() : '';
  if (!E164_RE.test(to))              return { eligible: false, reason: 'no_valid_recipient_phone' };
  if (AUDIO_SMS_SENT_STATUSES.includes(msg.status) || msg.smsMessageId) {
    return { eligible: false, reason: 'already_sent' };
  }
  if (AUDIO_SMS_LOCKED_MARKERS.includes(msg.audioSmsStatus)) {
    return { eligible: false, reason: 'already_queued' };
  }
  return { eligible: true, to };
}

/**
 * Réservation atomique : un seul appelant peut passer audioSmsStatus à 'queued'.
 */
async function claimAudioSms(db, ref) {
  const now    = new Date().toISOString();
  const fields = { audioSmsStatus: 'queued', audioSmsQueuedAt: now, updatedAt: now };

  if (typeof db.runTransaction === 'function') {
    return db.runTransaction(async (tx) => {
      const snap  = await tx.get(ref);
      const check = evaluateAudioSmsEligibility(snap && snap.exists ? snap.data() : null);
      if (!check.eligible) return { claimed: false, reason: check.reason };
      tx.update(ref, fields);
      return { claimed: true, to: check.to };
    });
  }

  // Repli (Firestore sans transactions — ex. stubs) : lecture puis écriture
  const snap  = await ref.get();
  const check = evaluateAudioSmsEligibility(snap && snap.exists ? snap.data() : null);
  if (!check.eligible) return { claimed: false, reason: check.reason };
  await ref.update(fields);
  return { claimed: true, to: check.to };
}

/** Même format d'expéditeur que la branche audio synchrone de routeMessage(). */
async function buildAudioSmsSenderDisplay(senderUid) {
  let senderName  = null;
  let senderPhone = null;
  if (senderUid) {
    try {
      const { resolveUserByUid } = require('./userResolver');
      const u = await resolveUserByUid(senderUid);
      if (u && u.found) {
        senderName  = u.name || u.username || null;
        senderPhone = u.phone || null;
      }
    } catch (_) { /* userResolver indisponible → affichage générique */ }
  }
  return senderName
    ? `${senderName}${senderPhone ? ` (${senderPhone})` : ''}`
    : (senderPhone || 'Un utilisateur OmniSMS');
}

/**
 * Reprend le routage SMS d'un message vocal une fois sa transcription sauvegardée.
 * Ne lève JAMAIS d'exception (le job de transcription reste « completed »).
 *
 * @param {object} opts
 * @param {string}  opts.messageId            ID du document messages/{id}
 * @param {string}  opts.transcription        texte transcrit (Groq / Whisper)
 * @param {string} [opts.collection='messages'] collection mise à jour par le worker
 * @param {object} [opts.db]                  instance Firestore (tests)
 * @param {string} [opts.jobId]               ID du job de transcription (logs)
 * @returns {Promise<{ action: 'queued'|'sent'|'skipped'|'failed', reason?: string, jobId?: string }>}
 */
async function continueAudioSmsAfterTranscription(opts = {}) {
  const {
    messageId,
    transcription,
    collection = 'messages',
    db: dbParam = null,
    jobId = null,
  } = opts;

  try {
    if (!messageId) return { action: 'skipped', reason: 'no_message_id' };
    if (collection !== 'messages') {
      // audio_messages (POST /api/audio/transcribe/:id) : transcription seule, aucun routage
      return { action: 'skipped', reason: 'collection_not_routed' };
    }

    const db = getContinuationDb(dbParam);
    if (!db) {
      logger.warn('[AUDIO_SMS] Firestore indisponible — reprise Audio → SMS impossible', { messageId });
      return { action: 'skipped', reason: 'db_unavailable' };
    }

    const ref   = db.collection('messages').doc(messageId);
    const snap  = await ref.get();
    const msg   = snap && snap.exists ? snap.data() : null;
    const check = evaluateAudioSmsEligibility(msg);
    if (!check.eligible) {
      logger.info('[AUDIO_SMS] Aucune reprise SMS nécessaire', { messageId, reason: check.reason, jobId });
      return { action: 'skipped', reason: check.reason };
    }

    const text = typeof transcription === 'string' ? transcription.trim() : '';
    const now  = new Date().toISOString();

    // ── Transcription vide : aucun SMS vide, message conservé ──────────
    if (!text) {
      await ref.update({
        audioSmsStatus: 'skipped_empty_transcription',
        audioSmsError : 'Transcription vide — aucun SMS envoyé.',
        updatedAt     : now,
      }).catch(() => {});
      logger.warn('[AUDIO_SMS] Transcription vide → aucun SMS envoyé (message conservé)', {
        messageId, to: maskPhoneS13(check.to), jobId,
      });
      return { action: 'skipped', reason: 'empty_transcription' };
    }

    // ── Anti-boucle : jamais de SMS vers la SIM passerelle elle-même ────
    const gw     = (process.env.INFINIREACH_FROM_NUMBER || '').trim();
    const gwNorm = gw ? (normalizePhone(gw) || gw) : '';
    if (gwNorm && check.to === gwNorm) {
      await ref.update({ audioSmsStatus: 'skipped_gateway_number', updatedAt: now }).catch(() => {});
      logger.warn('[AUDIO_SMS] Destinataire = numéro passerelle → SMS annulé (anti-boucle)', {
        messageId, to: maskPhoneS13(check.to),
      });
      return { action: 'skipped', reason: 'gateway_number' };
    }

    // ── Réservation atomique (idempotence) ─────────────────────────────
    const claim = await claimAudioSms(db, ref);
    if (!claim.claimed) {
      logger.info('[AUDIO_SMS] Déjà pris en charge — aucun doublon', { messageId, reason: claim.reason, jobId });
      return { action: 'skipped', reason: claim.reason || 'already_claimed' };
    }

    const senderDisplay = await buildAudioSmsSenderDisplay(msg.senderId);
    const smsText       = `[OmniSMS Vocal] ${senderDisplay} : ${text}`;

    logger.info('[AUDIO_SMS] Transcription disponible → envoi du texte via la file SMS existante', {
      messageId,
      to            : maskPhoneS13(claim.to),
      transcriptLen : text.length,
      conversationId: msg.conversationId || null,
      jobId,
    });

    const { enqueueSmsJob } = require('./smsQueueWorker');
    let queued;
    try {
      queued = await enqueueSmsJob({
        to            : claim.to,
        text          : smsText,
        messageId,                              // → jobId sms-{messageId} + externalId omnisms-{messageId}
        conversationId: msg.conversationId || null,
        ownerUid      : msg.senderId || null,
      });
    } catch (sendErr) {
      // Mode inline (sans Redis) : l'envoi a été tenté immédiatement et a échoué.
      await ref.update({
        audioSmsStatus: 'failed',
        audioSmsError : String(sendErr.message || 'Envoi SMS échoué').slice(0, 300),
        updatedAt     : new Date().toISOString(),
      }).catch(() => {});
      logger.error('[AUDIO_SMS] Envoi SMS du texte transcrit échoué', {
        messageId, to: maskPhoneS13(claim.to), error: sendErr.message,
      });
      return { action: 'failed', reason: 'sms_send_failed', error: sendErr.message };
    }

    if (!queued || (!queued.jobId && !queued.queued)) {
      await ref.update({
        audioSmsStatus: 'failed',
        audioSmsError : 'File SMS indisponible — job non créé.',
        updatedAt     : new Date().toISOString(),
      }).catch(() => {});
      logger.error('[AUDIO_SMS] File SMS indisponible — SMS non envoyé', { messageId });
      return { action: 'failed', reason: 'queue_unavailable' };
    }

    if (queued.result && queued.result.skipped) {
      await ref.update({ audioSmsStatus: 'skipped_no_transport', updatedAt: new Date().toISOString() }).catch(() => {});
      logger.warn('[AUDIO_SMS] Aucun transport SMS configuré — SMS non envoyé (message conservé)', { messageId });
      return { action: 'skipped', reason: 'no_transport_configured' };
    }

    if (queued.result && queued.result.success) {
      await ref.update({
        audioSmsStatus: 'sent',
        audioSmsSentAt: new Date().toISOString(),
        updatedAt     : new Date().toISOString(),
      }).catch(() => {});
      logger.info('[AUDIO_SMS] SMS du texte transcrit envoyé', {
        messageId,
        to          : maskPhoneS13(claim.to),
        provider    : queued.result.provider || null,
        smsMessageId: queued.result.smsMessageId || null,
      });
      return { action: 'sent', jobId: queued.jobId, smsMessageId: queued.result.smsMessageId || null };
    }

    logger.info('[AUDIO_SMS] SMS mis en file (BullMQ) — envoi et retries par smsQueueWorker', {
      messageId, smsJobId: queued.jobId, to: maskPhoneS13(claim.to),
    });
    return { action: 'queued', jobId: queued.jobId };

  } catch (err) {
    logger.error('[AUDIO_SMS] Reprise Audio → SMS impossible', { messageId, error: err.message, jobId });
    return { action: 'failed', reason: 'exception', error: err.message };
  }
}

/**
 * Enregistre un statut d'erreur propre quand la transcription d'un vocal routé
 * vers SMS échoue. Aucun SMS n'est envoyé, le message est conservé.
 * Le marqueur 'transcription_failed' n'est PAS bloquant : si une nouvelle
 * tentative du worker réussit, l'envoi SMS reprend normalement.
 * Ne lève jamais d'exception.
 */
async function markAudioSmsTranscriptionFailed(opts = {}) {
  const {
    messageId,
    collection   = 'messages',
    error        = null,
    finalAttempt = true,
    db: dbParam  = null,
    jobId        = null,
  } = opts;

  try {
    if (!messageId || collection !== 'messages') return { action: 'skipped', reason: 'collection_not_routed' };
    const db = getContinuationDb(dbParam);
    if (!db) return { action: 'skipped', reason: 'db_unavailable' };

    const ref   = db.collection('messages').doc(messageId);
    const snap  = await ref.get();
    const check = evaluateAudioSmsEligibility(snap && snap.exists ? snap.data() : null);
    if (!check.eligible) return { action: 'skipped', reason: check.reason };

    await ref.update({
      audioSmsStatus: 'transcription_failed',
      audioSmsError : String(error || 'Transcription échouée').slice(0, 300),
      updatedAt     : new Date().toISOString(),
    });

    if (finalAttempt) {
      logger.warn('[AUDIO_SMS] Transcription réellement échouée → aucun SMS envoyé (message conservé, statut d\'erreur enregistré)', {
        messageId, to: maskPhoneS13(check.to), error, jobId,
      });
    } else {
      logger.warn('[AUDIO_SMS] Transcription échouée (tentative intermédiaire) — nouvelle tentative prévue, aucun SMS pour l\'instant', {
        messageId, error, jobId,
      });
    }
    return { action: 'marked', reason: 'transcription_failed' };
  } catch (err) {
    logger.warn('[AUDIO_SMS] Enregistrement du statut d\'échec impossible', { messageId, error: err.message });
    return { action: 'failed', reason: 'exception', error: err.message };
  }
}

module.exports = {
  routeMessage,
  makeConversationId,
  makeExternalConvId,
  getOrCreateExternalConv,
  findExternalConvByPhone,
  updateExternalConvLastMessage,
  // SESSION 13 — reprise Audio → SMS après transcription asynchrone
  continueAudioSmsAfterTranscription,
  markAudioSmsTranscriptionFailed,
  evaluateAudioSmsEligibility,
};
