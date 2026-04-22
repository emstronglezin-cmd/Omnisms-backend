'use strict';
/**
 * OmniSMS — Routes Admin
 *
 * Protégées par header : x-admin-key
 * Utilise Firestore comme source de vérité (pas de données en mémoire).
 *
 * Endpoints :
 *  GET  /admin/stats                        → Statistiques globales
 *  GET  /admin/health                       → Santé détaillée du serveur
 *  GET  /admin/users                        → Liste utilisateurs (paginée)
 *  GET  /admin/user/:userId                 → Détails d'un utilisateur
 *  POST /admin/user/:userId/activate        → Activer abonnement manuellement
 *  POST /admin/user/:userId/deactivate      → Désactiver abonnement
 *  GET  /admin/payments                     → Historique paiements Fusion Pay
 *  GET  /admin/subscriptions                → Tous les abonnements
 */

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const router     = express.Router();

// Firestore production
const db = require('../config/firebase');

// Logger
const { logger } = require('../middleware/logger');

/* ============================================================
   MIDDLEWARE ADMIN — Protection par clé secrète
   + Rate limit strict pour éviter le brute-force de la clé
============================================================ */
const adminRateLimiter = rateLimit({
  windowMs       : 5 * 60 * 1000,   // 5 min
  max            : 30,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { error: 'Trop de requêtes admin.', code: 'ADMIN_RATE_LIMIT' },
});

function requireAdminKey(req, res, next) {
  const key         = req.headers['x-admin-key'];
  const expectedKey = process.env.ADMIN_KEY;

  if (!expectedKey) {
    // En développement sans ADMIN_KEY, autoriser avec avertissement
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('ADMIN_KEY absent — accès admin non protégé (dev uniquement)');
      return next();
    }
    return res.status(503).json({ error: 'Admin non configuré.', code: 'ADMIN_NOT_CONFIGURED' });
  }

  if (!key) {
    return res.status(401).json({ error: 'Clé admin manquante.', code: 'NO_ADMIN_KEY' });
  }

  // Comparaison en temps constant (évite timing attacks)
  const crypto = require('crypto');
  const expected = Buffer.from(expectedKey);
  const provided = Buffer.from(key.padEnd(expectedKey.length, '\0').slice(0, expectedKey.length));

  if (expected.length !== provided.length ||
      !crypto.timingSafeEqual(expected, provided)) {
    logger.warn('Tentative d\'accès admin avec clé invalide', { ip: req.ip, path: req.path });
    return res.status(403).json({ error: 'Clé admin invalide.', code: 'INVALID_ADMIN_KEY' });
  }

  next();
}

// Appliquer les deux protections sur toutes les routes admin
router.use(adminRateLimiter, requireAdminKey);

/* ============================================================
   GET /admin/health
   → Santé détaillée (Firebase, mémoire, uptime)
============================================================ */
router.get('/health', async (req, res) => {
  const mem = process.memoryUsage();

  let firestoreOk = false;
  let firestoreLatency = null;
  try {
    const t0  = Date.now();
    await db.collection('_health').doc('ping').set({ ts: new Date().toISOString() });
    firestoreLatency = `${Date.now() - t0}ms`;
    firestoreOk = true;
  } catch (e) {
    logger.warn('Firestore health check échoué', { error: e.message });
  }

  res.json({
    status   : 'ok',
    service  : 'OmniSMS Backend v2.2',
    uptime   : `${Math.floor(process.uptime())}s`,
    node     : process.version,
    memory   : {
      heapUsed : `${Math.round(mem.heapUsed  / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      rss      : `${Math.round(mem.rss       / 1024 / 1024)}MB`,
    },
    firestore: { ok: firestoreOk, latency: firestoreLatency },
    env      : process.env.NODE_ENV || 'development',
    time     : new Date().toISOString(),
  });
});

/* ============================================================
   GET /admin/stats
   → Statistiques globales depuis Firestore
============================================================ */
router.get('/stats', async (req, res) => {
  try {
    const [usersSnap, paymentsSnap, subsSnap] = await Promise.all([
      db.collection('users').count().get(),
      db.collection('payments_fusionpay').count().get(),
      db.collection('subscriptions').count().get(),
    ]);

    // Abonnés actifs
    const subsActiveSnap = await db.collection('users')
      .where('isSubscribed', '==', true)
      .count().get();

    // Paiements réussis
    const paidSnap = await db.collection('payments_fusionpay')
      .where('status', '==', 'paid')
      .count().get();

    res.json({
      stats: {
        totalUsers        : usersSnap.data().count,
        subscribedUsers   : subsActiveSnap.data().count,
        totalPayments     : paymentsSnap.data().count,
        successfulPayments: paidSnap.data().count,
        subscriptions     : subsSnap.data().count,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Admin stats error', { error: err.message });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   GET /admin/users?limit=50&after=<docId>
   → Liste des utilisateurs (pagination par curseur Firestore)
============================================================ */
router.get('/users', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
  const after  = req.query.after || null;
  const filter = req.query.subscribed; // 'true' | 'false' | undefined

  try {
    let query = db.collection('users').orderBy('updatedAt', 'desc').limit(limit);

    if (filter === 'true')  query = query.where('isSubscribed', '==', true);
    if (filter === 'false') query = query.where('isSubscribed', '==', false);

    if (after) {
      const afterDoc = await db.collection('users').doc(after).get();
      if (afterDoc.exists) query = query.startAfter(afterDoc);
    }

    const snap = await query.get();
    const users = snap.docs.map(d => {
      const data = d.data();
      return {
        userId      : d.id,
        isSubscribed: data.isSubscribed || false,
        subscribedAt: data.subscribedAt || null,
        moyen       : data.moyen        || null,
        amount      : data.amount       || null,
        updatedAt   : data.updatedAt    || null,
        createdAt   : data.createdAt    || null,
      };
    });

    res.json({
      count    : users.length,
      hasMore  : users.length === limit,
      nextAfter: users.length === limit ? snap.docs[snap.docs.length - 1].id : null,
      users,
    });
  } catch (err) {
    logger.error('Admin users error', { error: err.message });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   GET /admin/user/:userId
   → Détails complets d'un utilisateur
============================================================ */
router.get('/user/:userId', async (req, res) => {
  const userId = req.params.userId?.trim();
  if (!userId || userId.length < 3) {
    return res.status(400).json({ error: 'userId invalide.', code: 'INVALID_USER_ID' });
  }

  try {
    const [userDoc, subsSnap, paymentsSnap] = await Promise.all([
      db.collection('users').doc(userId).get(),
      db.collection('subscriptions').where('userId', '==', userId).orderBy('createdAt', 'desc').limit(5).get(),
      db.collection('payments_fusionpay').where('userId', '==', userId).orderBy('updatedAt', 'desc').limit(10).get(),
    ]);

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'USER_NOT_FOUND', userId });
    }

    res.json({
      user        : { userId, ...userDoc.data() },
      subscriptions: subsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      payments    : paymentsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  } catch (err) {
    logger.error('Admin user detail error', { error: err.message, userId });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   POST /admin/user/:userId/activate
   → Activer l'abonnement manuellement (support client)
============================================================ */
router.post('/user/:userId/activate', async (req, res) => {
  const userId = req.params.userId?.trim();
  const { reason = 'manual_admin', amount = 2000 } = req.body || {};

  if (!userId || userId.length < 3) {
    return res.status(400).json({ error: 'userId invalide.', code: 'INVALID_USER_ID' });
  }

  const now = new Date().toISOString();

  try {
    // Vérifier si déjà abonné
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.exists && userDoc.data()?.isSubscribed === true) {
      return res.status(409).json({
        error : 'Utilisateur déjà abonné.',
        code  : 'ALREADY_SUBSCRIBED',
        userId,
        subscribedAt: userDoc.data()?.subscribedAt,
      });
    }

    const updateData = {
      isSubscribed  : true,
      subscribedAt  : now,
      paymentMethod : 'manual_admin',
      amount,
      moyen         : reason,
      activatedBy   : req.ip,
      updatedAt     : now,
    };

    // Écriture atomique
    const batch = db.batch();
    batch.set(db.collection('users').doc(userId), updateData, { merge: true });
    batch.set(db.collection('subscriptions').doc(), {
      userId,
      ...updateData,
      createdAt: now,
      app: 'OmniSMS',
    });
    await batch.commit();

    logger.info('Admin: abonnement activé manuellement', { userId, ip: req.ip, reason });

    res.json({
      success     : true,
      message     : `Abonnement activé pour ${userId}`,
      userId,
      activatedAt : now,
    });
  } catch (err) {
    logger.error('Admin activate error', { error: err.message, userId });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   POST /admin/user/:userId/deactivate
   → Désactiver l'abonnement (remboursement, fraude, etc.)
   → INTERDIT en production sans raison explicite
============================================================ */
router.post('/user/:userId/deactivate', async (req, res) => {
  const userId = req.params.userId?.trim();
  const { reason } = req.body || {};

  if (!userId || userId.length < 3) {
    return res.status(400).json({ error: 'userId invalide.', code: 'INVALID_USER_ID' });
  }

  if (!reason || reason.trim().length < 5) {
    return res.status(400).json({
      error: 'Une raison (min 5 caractères) est requise pour désactiver un abonnement.',
      code : 'REASON_REQUIRED',
    });
  }

  const now = new Date().toISOString();

  try {
    await db.collection('users').doc(userId).set({
      isSubscribed     : false,
      deactivatedAt    : now,
      deactivatedReason: reason,
      deactivatedBy    : req.ip,
      updatedAt        : now,
    }, { merge: true });

    logger.warn('Admin: abonnement désactivé', { userId, reason, ip: req.ip });

    res.json({ success: true, message: `Abonnement désactivé pour ${userId}`, userId });
  } catch (err) {
    logger.error('Admin deactivate error', { error: err.message, userId });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   GET /admin/payments?limit=50&status=paid
   → Historique des paiements Fusion Pay
============================================================ */
router.get('/payments', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const status = req.query.status;
  const after  = req.query.after || null;

  try {
    let query = db.collection('payments_fusionpay').orderBy('updatedAt', 'desc').limit(limit);

    if (status && ['paid', 'pending', 'failed', 'processing'].includes(status)) {
      query = query.where('status', '==', status);
    }

    if (after) {
      const afterDoc = await db.collection('payments_fusionpay').doc(after).get();
      if (afterDoc.exists) query = query.startAfter(afterDoc);
    }

    const snap = await query.get();
    const payments = snap.docs.map(d => ({ tokenPay: d.id, ...d.data() }));

    res.json({
      count    : payments.length,
      hasMore  : payments.length === limit,
      nextAfter: payments.length === limit ? snap.docs[snap.docs.length - 1].id : null,
      payments,
    });
  } catch (err) {
    logger.error('Admin payments error', { error: err.message });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   GET /admin/subscriptions?limit=50
   → Tous les abonnements (depuis collection subscriptions)
============================================================ */
router.get('/subscriptions', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  try {
    const snap = await db.collection('subscriptions')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const subs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json({ count: subs.length, subscriptions: subs });
  } catch (err) {
    logger.error('Admin subscriptions error', { error: err.message });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

module.exports = router;
