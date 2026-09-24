'use strict';
/**
 * OmniSMS — Service Socket.IO (Temps Réel)
 *
 * Fonctionnalités :
 *  - Authentification socket (Firebase token ou JWT)
 *  - Messages en temps réel (send, receive)
 *  - Typing status (user:typing, user:stop-typing)
 *  - Online/Offline status
 *  - Seen status (message:read)
 *  - Reconnexion automatique avec état persistant Redis
 *  - Rooms par utilisateur (user:{uid})
 *  - Rooms par conversation (conv:{uid1}-{uid2})
 *
 * Usage dans server.js :
 *   const { initSocketIO } = require('./services/socketService');
 *   initSocketIO(httpServer);
 */

const { Server }  = require('socket.io');
const jwt         = require('jsonwebtoken');
const { logger }  = require('../middleware/logger');
const redis       = require('./redis');
const { normalizePhone } = require('./phoneNormalizer');
const { resolveUserByPhone } = require('./userResolver');
// SESSION 13 — résolution #username (même service que POST /api/messages/send)
const { resolveRecipientUsername } = require('./userResolver');

// SESSION 13 — événements « nouveau message » tracés avec le tag [NOTIFICATION]
const NOTIFICATION_EVENTS = new Set(['message:receive', 'new_message']);

/** Nombre de sockets connectés dans la room user:{uid} (instance locale). */
function countSocketsInUserRoom(uid) {
  try {
    const room = _io && _io.sockets && _io.sockets.adapter && _io.sockets.adapter.rooms
      ? _io.sockets.adapter.rooms.get(`user:${uid}`)
      : null;
    return room ? room.size : 0;
  } catch (_) {
    return null;
  }
}

/** Résumé du payload pour les logs — JAMAIS le contenu du message. */
function summarizeMessagePayload(data) {
  const d = data || {};
  return {
    messageId     : d.id || d.messageId || null,
    senderId      : d.senderId || null,
    receiverId    : d.receiverId || null,
    conversationId: d.conversationId || null,
    type          : d.type || null,
    channel       : d.channel || null,
    contentLength : typeof d.content === 'string' ? d.content.length : 0,
    createdAt     : d.createdAt || d.timestamp || null,
  };
}

const ONLINE_TTL = 5 * 60; // 5 minutes (renouvelé par heartbeat)

let _io = null;

/* ── Auth Socket ──────────────────────────────────────────── */

async function authenticateSocket(socket) {
  const token = socket.handshake.auth?.token
    || socket.handshake.headers?.authorization?.replace('Bearer ', '')
    || null;

  if (!token) {
    throw new Error('Token manquant. Connectez-vous d\'abord.');
  }

  // 1. Essayer Firebase
  try {
    const admin = require('../firebase-admin/index');
    if (!admin._stub) {
      const decoded = await admin.auth().verifyIdToken(token, true);
      return {
        uid     : decoded.uid,
        email   : decoded.email   || null,
        phone   : decoded.phone_number || null,
        authType: 'firebase',
      };
    }
  } catch (fbErr) {
    // Firebase indisponible ou token non-Firebase → essayer JWT
    if (fbErr.code === 'auth/id-token-expired') {
      throw new Error('Token expiré. Reconnectez-vous.');
    }
  }

  // 2. Fallback JWT
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Service auth non configuré.');

  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    return {
      uid     : decoded.uid || decoded.userId || decoded.sub || decoded.id,
      email   : decoded.email || null,
      phone   : decoded.phone || null,
      authType: 'jwt',
    };
  } catch (jwtErr) {
    if (jwtErr.name === 'TokenExpiredError') throw new Error('Session expirée.');
    throw new Error('Token invalide.');
  }
}

/* ── Gestion online status ────────────────────────────────── */

async function setUserOnline(uid) {
  try {
    // Stocker l'état online de l'utilisateur dans un hash global
    await redis.hset('online_users', uid, JSON.stringify({
      uid,
      onlineSince: new Date().toISOString(),
      lastSeen   : new Date().toISOString(),
    }));
    // FIX Session10 : l'ancien code appliquait expire() sur le hash ENTIER
    // ce qui réinitialisait le TTL de TOUS les utilisateurs à chaque connexion.
    // Correction : on utilise une clé par utilisateur pour gérer son TTL
    // individuellement, ET on maintient le hash global avec une expiration longue.
    await redis.set(`online_ttl:${uid}`, '1', 'EX', ONLINE_TTL);
    // Le hash global expire dans 50 min (filet de sécurité mémoire Redis)
    await redis.expire('online_users', ONLINE_TTL * 10);
  } catch (_) {}
}

async function setUserOffline(uid) {
  try {
    await redis.hdel('online_users', uid);
    // FIX Session10 : supprimer aussi la clé TTL individuelle
    await redis.del(`online_ttl:${uid}`);
    // Sauvegarder la dernière connexion
    await redis.set(`last_seen:${uid}`, new Date().toISOString(), 'EX', 30 * 24 * 3600);
  } catch (_) {}
}

async function isUserOnline(uid) {
  try {
    // FIX Session10 : double vérification
    //  1. La clé TTL individuelle (expire au bout de ONLINE_TTL si pas de heartbeat)
    //  2. Le hash global (fallback si la clé TTL a disparu mais le hash reste)
    const ttlKey = await redis.get(`online_ttl:${uid}`);
    if (!ttlKey) {
      // La clé TTL individuelle a expiré → l'utilisateur est offline
      // Nettoyer aussi le hash global pour cohérence
      await redis.hdel('online_users', uid).catch(() => {});
      return false;
    }
    const data = await redis.hget('online_users', uid);
    return !!data;
  } catch (_) {
    return false;
  }
}

async function getLastSeen(uid) {
  try {
    return await redis.get(`last_seen:${uid}`);
  } catch (_) {
    return null;
  }
}

/* ── Initialisation Socket.IO ─────────────────────────────── */

function initSocketIO(httpServer) {
  if (_io) return _io;

  const corsOrigins = [
    'https://omnisms.netlify.app',
    'https://omnisms.web.app',
    // Vercel — URL principale et déploiements connus
    'https://omnisms-frontend.vercel.app',
    'https://omnisms-frontend-drab.vercel.app',              // FIX Session10 : déploiement actif
    'https://omnisms-frontend-qx1u5k6h9-emmanuel-lezin.vercel.app',
    // Dev local
    'http://localhost:3000',
    'http://localhost:5000',
    'http://localhost:8080',
    ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : []),
  ];

  // Regex pour autoriser tous les déploiements vercel.app du projet omnisms-frontend
  // FIX Session10 : l'ancien pattern exigeait -emmanuel-lezin → bloquait
  //   omnisms-frontend-drab.vercel.app (Socket.IO rejeté, même CORS root cause).
  const vercelPattern = /^https:\/\/omnisms-frontend(-[a-z0-9]+)*\.vercel\.app$/;

  _io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        // Autoriser sans origin (ex: mobile apps, curl)
        if (!origin) return callback(null, true);
        if (corsOrigins.includes(origin) || vercelPattern.test(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS: origine non autorisée: ${origin}`));
      },
      methods    : ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout       : 60000,
    pingInterval      : 25000,
    transports        : ['websocket', 'polling'],
    allowEIO3         : true,  // compatibilité Socket.IO v3
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,  // 2 minutes
      skipMiddlewares         : true,
    },
  });

  /* ── Middleware auth ─────────────────────────────────────── */
  _io.use(async (socket, next) => {
    try {
      const user = await authenticateSocket(socket);
      socket.user = user;
      next();
    } catch (err) {
      logger.warn('[Socket] Auth failed', { error: err.message, id: socket.id });
      next(new Error(err.message));
    }
  });

  /* ── Connexion ───────────────────────────────────────────── */
  _io.on('connection', async (socket) => {
    const { uid } = socket.user;

    logger.info('[Socket] Client connected', { uid, socketId: socket.id });

    // Joindre la room personnelle
    socket.join(`user:${uid}`);

    // Marquer en ligne
    await setUserOnline(uid);

    // Notifier les autres de la connexion
    socket.broadcast.emit('user:online', {
      uid,
      timestamp: new Date().toISOString(),
    });

    /* ── Événements messages ──────────────────────────────── */

    /**
     * Envoyer un message en temps réel
     * Client → { receiverId, content, type, conversationId, tempId }
     */
    socket.on('message:send', async (data, ack) => {
      try {
        const { receiverId, content, type = 'text', conversationId, tempId, audioUrl, duration } = data;

        if (!receiverId || (!content && type === 'text')) {
          if (typeof ack === 'function') {
            ack({ error: 'receiverId et content sont requis.' });
          }
          return;
        }

        const now = new Date().toISOString();

        // ── Résolution OmniSMS via userResolver (multi-variantes, source de vérité)
        //    Garantit un conversationId basé sur UIDs réels, jamais sur numéros.
        let effectiveReceiverId = receiverId;
        let phoneCandidate      = receiverId;
        let usernameResolved    = false;

        // SESSION 13 — "#username" / "@username" explicite → UID réel.
        // Username inconnu → erreur propre (ack), aucun message fantôme.
        if (typeof resolveRecipientUsername === 'function' && typeof receiverId === 'string' && /^\s*[#@＃＠]/.test(receiverId)) {
          const lookup = await resolveRecipientUsername(receiverId, {
            allowBare: false, source: 'Socket.IO message:send', senderUid: uid,
          });
          if (lookup.status === 'not_found') {
            if (typeof ack === 'function') {
              ack({
                error   : `Utilisateur introuvable : aucun compte OmniSMS pour « #${lookup.username || ''} ».`,
                code    : 'USER_NOT_FOUND',
                username: lookup.username || null,
                tempId  : tempId || null,
              });
            }
            return;
          }
          if (lookup.status === 'resolved') {
            effectiveReceiverId = lookup.uid;
            usernameResolved    = true;
          }
          if (lookup.status === 'phone') {
            // "#+226…" → numéro explicite : même traitement qu'un numéro saisi sans #
            phoneCandidate      = lookup.phoneValue;
            effectiveReceiverId = lookup.phoneValue;
          }
        }

        const looksLikePhone = !usernameResolved
          && /^\+?[0-9\s\-()+]{7,20}$/.test(phoneCandidate) && !phoneCandidate.includes('-');
        if (looksLikePhone) {
          try {
            const resolved = await resolveUserByPhone(phoneCandidate, { includeDeleted: false });
            if (resolved.found) {
              effectiveReceiverId = resolved.uid;
              logger.info('[Socket] Phone resolved → OmniSMS UID', {
                phone: phoneCandidate.replace(/\d{4}$/, '****'),
                resolvedUid: resolved.uid,
              });
            }
          } catch (_) {}
        }

        const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        // Toujours construire le conversationId depuis les UIDs réels (déterministe)
        const cId = [uid, effectiveReceiverId].sort().join('-');

        const msg = {
          id            : messageId,
          tempId        : tempId || null,
          senderId      : uid,
          receiverId    : effectiveReceiverId,
          content       : content || null,
          type,
          audioUrl      : audioUrl || null,
          duration      : duration || null,
          status        : 'sent',
          reactions     : [],
          createdAt     : now,
          updatedAt     : now,
          conversationId: cId,
        };

        // Persister en Firestore (async, non bloquant)
        persistMessage(msg).catch(err =>
          logger.error('[Socket] Message persist failed', { error: err.message })
        );

        // Envoyer au destinataire via son UID OmniSMS résolu (room user:{uid})
        _io.to(`user:${effectiveReceiverId}`).emit('message:receive', msg);
        logger.info('[NOTIFICATION] Socket.IO message:send → message:receive émis', {
          event        : 'message:receive',
          recipientUid : effectiveReceiverId,
          room         : `user:${effectiveReceiverId}`,
          socketsInRoom: countSocketsInUserRoom(effectiveReceiverId),
          ...summarizeMessagePayload(msg),
        });

        // Confirmer à l'expéditeur
        if (typeof ack === 'function') {
          ack({ success: true, messageId, tempId, conversationId: cId });
        }

        logger.info('[Socket] Message sent', { from: uid, to: effectiveReceiverId, original: receiverId, type });

      } catch (err) {
        logger.error('[Socket] message:send error', { error: err.message });
        if (typeof ack === 'function') ack({ error: err.message });
      }
    });

    /**
     * Message lu / vu
     * Client → { messageId, senderId }
     */
    socket.on('message:read', async ({ messageId, senderId }) => {
      if (!messageId || !senderId) return;

      // Notifier l'expéditeur
      _io.to(`user:${senderId}`).emit('message:seen', {
        messageId,
        seenBy   : uid,
        seenAt   : new Date().toISOString(),
      });

      // Mettre à jour Firestore
      updateMessageSeenStatus(messageId, uid).catch(() => {});
    });

    /**
     * Accusé de réception (livraison)
     * Client → { messageId, senderId }
     */
    socket.on('message:delivered', ({ messageId, senderId }) => {
      if (!messageId || !senderId) return;
      _io.to(`user:${senderId}`).emit('message:delivered', {
        messageId,
        deliveredTo : uid,
        deliveredAt : new Date().toISOString(),
      });
    });

    /* ── Typing status ───────────────────────────────────── */

    socket.on('typing:start', ({ receiverId }) => {
      if (!receiverId) return;
      _io.to(`user:${receiverId}`).emit('user:typing', {
        uid,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('typing:stop', ({ receiverId }) => {
      if (!receiverId) return;
      _io.to(`user:${receiverId}`).emit('user:stop-typing', {
        uid,
        timestamp: new Date().toISOString(),
      });
    });

    /* ── Statut en ligne ─────────────────────────────────── */

    socket.on('user:check-online', async ({ targetUid }, ack) => {
      if (!targetUid || typeof ack !== 'function') return;
      const online   = await isUserOnline(targetUid);
      const lastSeen = await getLastSeen(targetUid);
      ack({ uid: targetUid, online, lastSeen });
    });

    /* ── Rejoindre une conversation ──────────────────────── */

    socket.on('conversation:join', ({ conversationId }) => {
      if (!conversationId) return;
      socket.join(`conv:${conversationId}`);
    });

    socket.on('conversation:leave', ({ conversationId }) => {
      if (!conversationId) return;
      socket.leave(`conv:${conversationId}`);
    });

    /* ── Heartbeat (maintenir online status) ─────────────── */

    socket.on('heartbeat', async () => {
      await setUserOnline(uid);
      socket.emit('heartbeat:ack', { timestamp: new Date().toISOString() });
    });

    /* ── Déconnexion ─────────────────────────────────────── */

    socket.on('disconnect', async (reason) => {
      logger.info('[Socket] Client disconnected', { uid, socketId: socket.id, reason });

      // Attendre un peu avant de marquer offline (reconnexion rapide possible)
      setTimeout(async () => {
        const rooms = await _io.in(`user:${uid}`).fetchSockets();
        if (rooms.length === 0) {
          // Plus aucun socket actif pour cet utilisateur → offline
          await setUserOffline(uid);
          _io.emit('user:offline', {
            uid,
            lastSeen : new Date().toISOString(),
          });
          logger.info('[Socket] User marked offline', { uid });
        }
      }, 3000);
    });

    socket.on('error', (err) => {
      logger.error('[Socket] Socket error', { uid, error: err.message });
    });
  });

  logger.info('[Socket.IO] Server initialized.');
  return _io;
}

/* ── Helpers Firestore ────────────────────────────────────── */

async function persistMessage(msg) {
  try {
    const db = require('../config/firebase');
    if (db._stub) return;
    await db.collection('messages').doc(msg.id).set(msg);
  } catch (err) {
    logger.warn('[Socket] persistMessage failed', { error: err.message });
  }
}

async function updateMessageSeenStatus(messageId, seenBy) {
  try {
    const db = require('../config/firebase');
    if (db._stub) return;
    await db.collection('messages').doc(messageId).update({
      status   : 'seen',
      seenBy,
      seenAt   : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('[Socket] updateMessageSeenStatus failed', { error: err.message });
  }
}

/* ── Exports ──────────────────────────────────────────────── */

function getIO() {
  if (!_io) throw new Error('Socket.IO non initialisé. Appeler initSocketIO() d\'abord.');
  return _io;
}

/**
 * Envoyer un message à un utilisateur spécifique.
 * Peut être appelé depuis n'importe quel service.
 */
function emitToUser(uid, event, data) {
  if (!_io) {
    if (NOTIFICATION_EVENTS.has(event)) {
      logger.warn('[NOTIFICATION] Socket.IO non initialisé — événement non émis', { event, recipientUid: uid });
    }
    return;
  }
  _io.to(`user:${uid}`).emit(event, data);
  // SESSION 13 — trace de l'émission réelle : room ciblée + sockets connectés.
  // socketsInRoom = 0 → le destinataire n'a aucune session Socket.IO ouverte.
  if (NOTIFICATION_EVENTS.has(event)) {
    logger.info(`[NOTIFICATION] Événement ${event} émis`, {
      event,
      recipientUid : uid,
      room         : `user:${uid}`,
      socketsInRoom: countSocketsInUserRoom(uid),
      ...summarizeMessagePayload(data),
    });
  }
}

/**
 * Envoyer à tous les sockets.
 */
function broadcast(event, data) {
  if (!_io) return;
  _io.emit(event, data);
}

module.exports = {
  initSocketIO,
  getIO,
  emitToUser,
  broadcast,
  setUserOnline,
  setUserOffline,
  isUserOnline,
  getLastSeen,
};
