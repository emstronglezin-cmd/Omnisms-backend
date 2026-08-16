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
    await redis.hset('online_users', uid, JSON.stringify({
      uid,
      onlineSince: new Date().toISOString(),
      lastSeen   : new Date().toISOString(),
    }));
    await redis.expire('online_users', ONLINE_TTL * 10);
  } catch (_) {}
}

async function setUserOffline(uid) {
  try {
    await redis.hdel('online_users', uid);
    // Sauvegarder la dernière connexion
    await redis.set(`last_seen:${uid}`, new Date().toISOString(), 'EX', 30 * 24 * 3600);
  } catch (_) {}
}

async function isUserOnline(uid) {
  try {
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
    // Vercel — URL principale et previews dynamiques
    'https://omnisms-frontend.vercel.app',
    'https://omnisms-frontend-qx1u5k6h9-emmanuel-lezin.vercel.app',
    // Dev local
    'http://localhost:3000',
    'http://localhost:5000',
    'http://localhost:8080',
    ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : []),
  ];

  // Regex pour autoriser tous les previews Vercel du projet
  const vercelPattern = /^https:\/\/omnisms-frontend(-[a-z0-9]+-emmanuel-lezin)?\.vercel\.app$/;

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

        // ── Résolution OmniSMS : si receiverId ressemble à un téléphone,
        //    chercher l'UID OmniSMS correspondant avant de créer le message.
        //    Cela garantit un conversationId basé sur UIDs, jamais sur numéros.
        let effectiveReceiverId = receiverId;
        const looksLikePhone = /^\+?[0-9\s\-()+]{7,20}$/.test(receiverId) && !receiverId.includes('-');
        if (looksLikePhone) {
          try {
            const db = require('../config/firebase');
            if (db && !db._stub) {
              const e164 = normalizePhone(receiverId) || receiverId;
              const variants = [...new Set([e164, receiverId, receiverId.replace(/\s/g, '')].filter(Boolean))];
              for (const variant of variants) {
                try {
                  const snap = await db.collection('users').where('phone', '==', variant).where('deleted', '==', false).limit(1).get();
                  if (!snap.empty) { effectiveReceiverId = snap.docs[0].id; break; }
                } catch (_) {
                  const snap = await db.collection('users').where('phone', '==', variant).limit(1).get().catch(() => null);
                  if (snap && !snap.empty && !snap.docs[0].data().deleted) { effectiveReceiverId = snap.docs[0].id; break; }
                }
              }
            }
          } catch (_) {}
        }

        const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const cId = conversationId || [uid, effectiveReceiverId].sort().join('-');

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

        // Envoyer au destinataire résolu (UID OmniSMS ou numéro tel quel)
        _io.to(`user:${effectiveReceiverId}`).emit('message:receive', msg);
        // Si UID résolu ≠ receiverId original, émettre aussi sur l'original pour compatibilité
        if (effectiveReceiverId !== receiverId) {
          _io.to(`user:${receiverId}`).emit('message:receive', msg);
        }

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
  if (!_io) return;
  _io.to(`user:${uid}`).emit(event, data);
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
