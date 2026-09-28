'use strict';
/**
 * OmniSMS — Routes Admin
 * ═══════════════════════════════════════════════════════════════
 *
 * Protection : header `x-admin-key` (ADMIN_KEY)
 *   + optionnel : jeton Firebase/JWT d'un UID listé dans ADMIN_UIDS
 *   (les deux protections restent obligatoires pour TOUTE route admin —
 *    aucune route n'est publique, aucune vérification n'est contournée).
 *
 * Source de vérité : Firestore (aucune donnée en mémoire).
 *
 * Endpoints (montés sous /admin et /api/admin) :
 *  GET  /admin/stats                        → Statistiques globales
 *  GET  /admin/health                       → Santé détaillée du serveur
 *  GET  /admin/users                        → Liste utilisateurs (paginée)
 *  GET  /admin/user/:userId                 → Détails d'un utilisateur
 *  POST /admin/user/:userId/activate        → Activer abonnement manuellement
 *  POST /admin/user/:userId/deactivate      → Désactiver abonnement
 *  GET  /admin/payments                     → Historique paiements
 *  GET  /admin/subscriptions                → Tous les abonnements
 *
 * ⚠️ Les requêtes Firestore sont volontairement composées SANS index
 *    composite (`where(égalité)` + `orderBy(autre champ)`), car un tel
 *    index n'existe pas dans ce projet : la combinaison faisait échouer
 *    les routes en production (FAILED_PRECONDITION → HTTP 500 DB_ERROR).
 *    Le tri/filtrage complémentaire est fait en mémoire.
 *
 * ⚠️ Les collections de paiement réellement utilisées sont :
 *      - `leekpay_payments`    → système actuel (SaaSPay)
 *      - `payments_fusionpay`  → historique legacy (conservé, non supprimé)
 *    L'admin interroge LES DEUX et fusionne les résultats.
 */

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const router     = express.Router();
const crypto     = require('crypto');

// Firestore production
const db = require('../config/firebase');

// Logger
const { logger } = require('../middleware/logger');

/* Collections de paiement (actuelle + historique) */
const PAYMENT_COLLECTIONS = [
  { name: 'leekpay_payments',   source: 'saaspay'          },
  { name: 'payments_fusionpay', source: 'legacy_fusionpay' },
];

const MAX_ADMIN_PAGE = 200;
const SCAN_CAP       = 500;   // borne de sécurité pour les tris en mémoire

/* ============================================================
   LOGS ADMIN (masquage : jamais de clé admin en clair)
============================================================ */
function logAdmin(message, meta = {}) {
  logger.info(`[ADMIN] ${message}`, meta);
}
function logAdminAuth(message, level = 'warn', meta = {}) {
  logger[level](`[ADMIN_AUTH] ${message}`, meta);
}
function logAdminError(message, meta = {}) {
  logger.error(`[ADMIN_ERROR] ${message}`, meta);
}

/* ============================================================
   MIDDLEWARE ADMIN — Protections cumulées
   1. Rate limit strict (anti brute-force) — configurable
   2. Clé secrète x-admin-key OU jeton d'un UID listé dans ADMIN_UIDS
============================================================ */
const ADMIN_RATE_MAX = parseInt(process.env.ADMIN_RATE_LIMIT_MAX, 10) || 120;

const adminRateLimiter = rateLimit({
  windowMs       : 5 * 60 * 1000,   // 5 min
  max            : ADMIN_RATE_MAX,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { error: 'Trop de requêtes admin.', code: 'ADMIN_RATE_LIMIT' },
});

/** Comparaison en temps constant (évite les timing attacks) */
function safeCompare(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  // Toujours comparer des buffers de même taille (aucune fuite de longueur exploitable)
  const len = Math.max(a.length, b.length, 1);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  a.copy(padA);
  b.copy(padB);
  const equal = crypto.timingSafeEqual(padA, padB);
  return equal && a.length === b.length;
}

function getAdminUids() {
  return (process.env.ADMIN_UIDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Extrait une valeur d'en-tête sous forme de chaîne (jamais un tableau) */
function headerValue(raw) {
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0].trim() : null;
  if (typeof raw === 'string') return raw.trim();
  return null;
}

/**
 * Autorise l'accès admin si :
 *   - le header `x-admin-key` correspond à ADMIN_KEY (comportement historique), OU
 *   - un jeton Firebase/JWT valide appartient à un UID listé dans ADMIN_UIDS
 *     (uniquement si ADMIN_UIDS est configuré — sinon comportement inchangé).
 */
async function requireAdminAuth(req, res, next) {
  const providedKey = headerValue(req.headers['x-admin-key']);
  const expectedKey = process.env.ADMIN_KEY;
  const adminUids   = getAdminUids();

  /* ── ADMIN_KEY non configurée ─────────────────────────────── */
  if (!expectedKey) {
    if (process.env.NODE_ENV !== 'production') {
      logAdminAuth('ADMIN_KEY absent — accès admin non protégé (développement uniquement)', 'warn', {
        path: req.path, ip: req.ip,
      });
      return next();
    }
    logAdminError('ADMIN_KEY non configurée — accès admin refusé', { path: req.path, ip: req.ip });
    return res.status(503).json({ error: 'Admin non configuré.', code: 'ADMIN_NOT_CONFIGURED' });
  }

  /* ── 1) Clé admin ─────────────────────────────────────────── */
  if (providedKey) {
    if (safeCompare(providedKey, expectedKey)) {
      req.adminAuth = { type: 'key' };
      return next();
    }
    logAdminAuth('Accès admin refusé — clé invalide', 'warn', {
      ip: req.ip, path: req.path, method: req.method,
    });
    return res.status(403).json({ error: 'Clé admin invalide.', code: 'INVALID_ADMIN_KEY' });
  }

  /* ── 2) Jeton d'un administrateur (ADMIN_UIDS) ────────────── */
  if (adminUids.length > 0 && (req.headers['authorization'] || req.headers['Authorization'])) {
    try {
      const { optionalFirebaseAuth } = require('../middleware/firebaseAuth');
      await new Promise(resolve => optionalFirebaseAuth(req, res, resolve));

      if (req.user && req.user.uid && adminUids.includes(req.user.uid)) {
        req.adminAuth = { type: 'uid', uid: req.user.uid, authType: req.user.authType };
        logAdminAuth('Accès admin autorisé via ADMIN_UIDS', 'info', {
          uid: req.user.uid, path: req.path, authType: req.user.authType,
        });
        return next();
      }

      logAdminAuth('Accès admin refusé — UID non administrateur', 'warn', {
        uid: req.user?.uid || null, path: req.path, ip: req.ip,
      });
      return res.status(403).json({ error: 'Accès administrateur requis.', code: 'FORBIDDEN' });
    } catch (err) {
      logAdminError('Erreur vérification du jeton administrateur', { error: err.message, path: req.path });
      return res.status(401).json({ error: 'Jeton invalide.', code: 'INVALID_TOKEN' });
    }
  }

  /* ── 3) Aucun identifiant fourni ──────────────────────────── */
  logAdminAuth('Accès admin refusé — clé manquante', 'warn', {
    ip: req.ip, path: req.path, method: req.method,
  });
  return res.status(401).json({ error: 'Clé admin manquante.', code: 'NO_ADMIN_KEY' });
}

// Appliquer les deux protections sur toutes les routes admin
router.use(adminRateLimiter, requireAdminAuth);

/* ============================================================
   HELPERS FIRESTORE (sans index composite)
============================================================ */

/** Comptage simple (count() natif Firestore, fallback lecture bornée) */
async function countDocs(collectionName, filters = []) {
  let query = db.collection(collectionName);
  for (const f of filters) query = query.where(f.field, '==', f.value);

  if (typeof query.count === 'function') {
    const snap = await query.count().get();
    return snap.data().count;
  }

  const snap = await query.limit(SCAN_CAP).get();
  return snap.size !== undefined ? snap.size : (snap.docs ? snap.docs.length : 0);
}

/** Comptage tolérant : une collection absente ne casse pas la réponse */
async function countDocsSafe(collectionName, filters = []) {
  try {
    return await countDocs(collectionName, filters);
  } catch (err) {
    logAdminError(`Comptage impossible sur ${collectionName}`, { error: err.message });
    return 0;
  }
}

/** Lecture bornée d'une collection (fallback sans index) */
async function fetchLimited(collectionName, filters = [], max = SCAN_CAP) {
  let query = db.collection(collectionName);
  for (const f of filters) query = query.where(f.field, '==', f.value);
  const snap = await query.limit(max).get();
  return (snap.docs || []).map(d => ({ id: d.id, ...(d.data() || {}) }));
}

/** Tri décroissant tolérant (les documents sans date passent en dernier) */
function sortByDateDesc(rows, fields = ['updatedAt', 'createdAt', 'paidAt']) {
  const value = (row) => {
    for (const f of fields) {
      const v = row?.[f];
      if (v) {
        const t = typeof v === 'string' ? Date.parse(v) : (v instanceof Date ? v.getTime() : NaN);
        if (!Number.isNaN(t)) return t;
        if (typeof v === 'object' && typeof v.toDate === 'function') return v.toDate().getTime();
      }
    }
    return -Infinity;
  };
  return [...rows].sort((a, b) => value(b) - value(a));
}

function normalizeStatus(value) {
  return String(value || '').toLowerCase();
}

/** Fusion + filtrage + pagination en mémoire (collections multiples) */
function mergePayments(collectionsData, { status, after, limit }) {
  let rows = [];

  for (const { source, rows: collectionRows } of collectionsData) {
    for (const row of collectionRows) {
      rows.push({ ...row, source: row.source || source });
    }
  }

  // Dédoublonnage par identifiant (un même paiement peut exister sous 2 docs)
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.id}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  rows = [...seen.values()];

  if (status) {
    rows = rows.filter(r => normalizeStatus(r.status) === normalizeStatus(status));
  }

  rows = sortByDateDesc(rows);

  if (after) {
    const index = rows.findIndex(r => String(r.id) === String(after));
    rows = index >= 0 ? rows.slice(index + 1) : rows;
  }

  const hasMore = rows.length > limit;
  const page    = rows.slice(0, limit);

  return {
    count    : page.length,
    hasMore,
    nextAfter: hasMore && page.length ? page[page.length - 1].id : null,
    rows     : page,
  };
}

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
    logAdminError('Health check Firestore échoué', { error: e.message });
  }

  /* Configuration paiement (masquée — jamais de secret en clair) */
  let paymentConfig = null;
  try {
    const { getConfigStatus } = require('../services/saaspay');
    paymentConfig = getConfigStatus();
  } catch (e) {
    logAdminError('Lecture configuration paiement impossible', { error: e.message });
  }

  logAdmin('Health consultée', { firestoreOk, admin: req.adminAuth?.type || 'unknown' });

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
    payment  : paymentConfig,
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
    const totalUsers = await countDocsSafe('users');

    const subscribedUsers = await countDocsSafe('users', [
      { field: 'isSubscribed', value: true },
    ]);

    const subscriptions = await countDocsSafe('subscriptions');

    /* Paiements : système actuel (leekpay_payments) + historique (payments_fusionpay) */
    const paymentsBySource = {};
    let totalPayments      = 0;
    let successfulPayments = 0;

    for (const collection of PAYMENT_COLLECTIONS) {
      const total = await countDocsSafe(collection.name);
      const paid  = await countDocsSafe(collection.name, [{ field: 'status', value: 'paid' }]);

      paymentsBySource[collection.name] = { total, paid };
      totalPayments      += total;
      successfulPayments += paid;
    }

    logAdmin('Statistiques consultées', {
      totalUsers, subscribedUsers, totalPayments, successfulPayments,
    });

    res.json({
      stats: {
        totalUsers,
        subscribedUsers,
        totalPayments,
        successfulPayments,
        subscriptions,
        paymentsBySource,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logAdminError('Erreur statistiques', { error: err.message });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   GET /admin/users?limit=50&after=<docId>&subscribed=true|false
   → Liste des utilisateurs (pagination par curseur Firestore)
   ⚠️ Aucun index composite requis : `where` (égalité) OU `orderBy`,
      jamais les deux sur des champs différents.
============================================================ */
router.get('/users', async (req, res) => {
  const cqAdmin = req.cleanedQuery || {};
  const _qry = (k) => cqAdmin[k] !== undefined ? cqAdmin[k] : (req.query && req.query[k]);
  const limit  = Math.min(parseInt(_qry('limit'))  || 50, MAX_ADMIN_PAGE);
  const after  = _qry('after') || null;
  const filter = _qry('subscribed'); // 'true' | 'false' | undefined

  const toUser = (d) => {
    const data = d.data ? d.data() : d;
    return {
      userId      : d.id,
      isSubscribed: data.isSubscribed || false,
      subscribedAt: data.subscribedAt || null,
      moyen       : data.moyen        || null,
      amount      : data.amount       || null,
      updatedAt   : data.updatedAt    || null,
      createdAt   : data.createdAt    || null,
    };
  };

  try {
    let docs        = [];
    let orderedScan = false;
    const withFilter = filter === 'true' || filter === 'false';

    if (withFilter) {
      /* Filtre abonnement : where(égalité) uniquement → pas d'index composite */
      const filters = [{ field: 'isSubscribed', value: filter === 'true' }];

      if (after) {
        try {
          const afterDoc = await db.collection('users').doc(after).get();
          if (afterDoc.exists) {
            let q = db.collection('users').where('isSubscribed', '==', filter === 'true');
            q = q.startAfter(afterDoc);
            const snap = await q.limit(limit).get();
            docs = snap.docs || [];
          }
        } catch (e) {
          logAdminError('Pagination filtrée impossible — lecture simple', { error: e.message });
        }
      }

      if (!docs.length) {
        const rows = await fetchLimited('users', filters, SCAN_CAP);
        rows.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
        const start = after ? rows.findIndex(r => r.id === after) + 1 : 0;
        docs = rows.slice(start, start + limit).map(r => ({ id: r.id, data: () => r }));
      }
    } else {
      /* Sans filtre : orderBy simple (aucun index composite requis) */
      try {
        let query = db.collection('users').orderBy('updatedAt', 'desc').limit(limit);
        if (after) {
          const afterDoc = await db.collection('users').doc(after).get();
          if (afterDoc.exists) query = query.startAfter(afterDoc);
        }
        const snap = await query.get();
        docs = snap.docs || [];
        orderedScan = true;

        // Les documents sans `updatedAt` sont exclus par orderBy → fallback
        if (!docs.length) {
          const total = await countDocsSafe('users');
          if (total > 0) {
            const rows = await fetchLimited('users', [], limit);
            rows.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
            const start = after ? rows.findIndex(r => r.id === after) + 1 : 0;
            docs = rows.slice(start, start + limit).map(r => ({ id: r.id, data: () => r }));
            orderedScan = false;
          }
        }
      } catch (e) {
        logAdminError('Lecture utilisateurs ordonnée impossible — fallback sans index', { error: e.message });
        const rows = await fetchLimited('users', [], limit);
        rows.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
        const start = after ? rows.findIndex(r => r.id === after) + 1 : 0;
        docs = rows.slice(start, start + limit).map(r => ({ id: r.id, data: () => r }));
      }
    }

    const users = docs.map(toUser);

    logAdmin('Liste utilisateurs consultée', {
      count: users.length, filter: filter || null, orderedScan,
    });

    res.json({
      count    : users.length,
      hasMore  : users.length === limit,
      nextAfter: users.length === limit && docs.length ? docs[docs.length - 1].id : null,
      users,
    });
  } catch (err) {
    logAdminError('Erreur lecture utilisateurs', { error: err.message });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   GET /admin/user/:userId
   → Détails complets d'un utilisateur
   ⚠️ Requêtes par égalité uniquement (tri en mémoire) + allSettled :
      une sous-requête en échec ne fait plus échouer toute la route.
============================================================ */
router.get('/user/:userId', async (req, res) => {
  const userId = req.params.userId?.trim();
  if (!userId || userId.length < 3) {
    return res.status(400).json({ error: 'userId invalide.', code: 'INVALID_USER_ID' });
  }

  try {
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      logAdminAuth('Utilisateur admin introuvable', 'warn', { userId });
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'USER_NOT_FOUND', userId });
    }

    const warnings = [];

    const [subsResult, ...paymentsResults] = await Promise.allSettled([
      fetchLimited('subscriptions', [{ field: 'userId', value: userId }], 5),
      ...PAYMENT_COLLECTIONS.map(c =>
        fetchLimited(c.name, [{ field: 'userId', value: userId }], 10)),
    ]);

    let subscriptions = [];
    if (subsResult.status === 'fulfilled') {
      subscriptions = sortByDateDesc(subsResult.value, ['createdAt', 'updatedAt']).slice(0, 5);
    } else {
      warnings.push(`subscriptions: ${subsResult.reason?.message || 'erreur'}`);
      logAdminError('Erreur lecture abonnements utilisateur', { userId, error: subsResult.reason?.message });
    }

    const payments = [];
    paymentsResults.forEach((result, index) => {
      const collection = PAYMENT_COLLECTIONS[index];
      if (result.status === 'fulfilled') {
        for (const row of result.value) payments.push({ ...row, source: collection.source });
      } else {
        warnings.push(`${collection.name}: ${result.reason?.message || 'erreur'}`);
        logAdminError('Erreur lecture paiements utilisateur', {
          userId, collection: collection.name, error: result.reason?.message,
        });
      }
    });

    logAdmin('Détail utilisateur consulté', { userId, payments: payments.length, subscriptions: subscriptions.length });

    res.json({
      user         : { userId, ...userDoc.data() },
      subscriptions: subscriptions.map(d => (d.id ? d : { id: d.id, ...d })),
      payments     : sortByDateDesc(payments).slice(0, 10).map(p => ({ tokenPay: p.id, ...p })),
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (err) {
    logAdminError('Erreur détail utilisateur', { error: err.message, userId });
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
      logAdminAuth('Activation refusée — utilisateur déjà abonné', 'warn', { userId });
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

    logAdmin('Abonnement activé manuellement', { userId, ip: req.ip, reason, amount });

    res.json({
      success     : true,
      message     : `Abonnement activé pour ${userId}`,
      userId,
      activatedAt : now,
    });
  } catch (err) {
    logAdminError('Erreur activation abonnement', { error: err.message, userId });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   POST /admin/user/:userId/deactivate
   → Désactiver l'abonnement (remboursement, fraude, etc.)
   → Raison explicite obligatoire
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

    logAdmin('Abonnement désactivé', { userId, reason, ip: req.ip });

    res.json({ success: true, message: `Abonnement désactivé pour ${userId}`, userId });
  } catch (err) {
    logAdminError('Erreur désactivation abonnement', { error: err.message, userId });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   GET /admin/payments?limit=50&status=paid&after=<docId>
   → Historique des paiements : leekpay_payments (SaaSPay) + legacy
============================================================ */
router.get('/payments', async (req, res) => {
  const cqAdminP = req.cleanedQuery || {};
  const _qryP = (k) => cqAdminP[k] !== undefined ? cqAdminP[k] : (req.query && req.query[k]);
  const limit  = Math.min(parseInt(_qryP('limit')) || 50, MAX_ADMIN_PAGE);
  const status = _qryP('status');
  const after  = _qryP('after') || null;

  const allowedStatuses = ['paid', 'pending', 'failed', 'processing', 'cancelled', 'expired'];
  const statusFilter    = status && allowedStatuses.includes(normalizeStatus(status))
    ? normalizeStatus(status)
    : (status ? '__invalid__' : null);

  try {
    const results = await Promise.allSettled(PAYMENT_COLLECTIONS.map(async (collection) => {
      /* where(égalité) OU orderBy — jamais les deux (aucun index composite requis) */
      if (statusFilter && statusFilter !== '__invalid__') {
        const rows = await fetchLimited(collection.name, [{ field: 'status', value: statusFilter }], SCAN_CAP);
        return { source: collection.source, rows };
      }

      if (statusFilter === '__invalid__') {
        return { source: collection.source, rows: [] };
      }

      try {
        const snap = await db.collection(collection.name).orderBy('updatedAt', 'desc').limit(SCAN_CAP).get();
        return {
          source: collection.source,
          rows  : (snap.docs || []).map(d => ({ id: d.id, ...(d.data() || {}) })),
        };
      } catch (err) {
        logAdminError(`Lecture ordonnée impossible sur ${collection.name} — fallback`, { error: err.message });
        const rows = await fetchLimited(collection.name, [], SCAN_CAP);
        return { source: collection.source, rows };
      }
    }));

    const collectionsData = [];
    const warnings        = [];

    results.forEach((result, index) => {
      const collection = PAYMENT_COLLECTIONS[index];
      if (result.status === 'fulfilled') {
        collectionsData.push(result.value);
      } else {
        warnings.push(`${collection.name}: ${result.reason?.message || 'erreur'}`);
        logAdminError('Erreur lecture paiements', {
          collection: collection.name, error: result.reason?.message,
        });
      }
    });

    const merged = mergePayments(collectionsData, { status: statusFilter && statusFilter !== '__invalid__' ? statusFilter : null, after, limit });

    logAdmin('Liste paiements consultée', {
      count: merged.count, status: status || null, source: 'multi-collections',
    });

    res.json({
      count    : merged.count,
      hasMore  : merged.hasMore,
      nextAfter: merged.nextAfter,
      payments : merged.rows.map(row => ({ tokenPay: row.id, ...row })),
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (err) {
    logAdminError('Erreur lecture paiements', { error: err.message });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* ============================================================
   GET /admin/subscriptions?limit=50
   → Tous les abonnements (depuis collection subscriptions)
============================================================ */
router.get('/subscriptions', async (req, res) => {
  const cqAdminS = req.cleanedQuery || {};
  const limit = Math.min(parseInt(cqAdminS.limit || (req.query && req.query.limit)) || 50, MAX_ADMIN_PAGE);

  try {
    let subs = [];

    try {
      const snap = await db.collection('subscriptions')
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      subs = (snap.docs || []).map(d => ({ id: d.id, ...(d.data() || {}) }));
    } catch (err) {
      logAdminError('Lecture ordonnée abonnements impossible — fallback', { error: err.message });
    }

    if (!subs.length) {
      /* Fallback : documents sans `createdAt` (exclus par orderBy) */
      const rows = await fetchLimited('subscriptions', [], limit);
      subs = sortByDateDesc(rows, ['createdAt', 'subscribedAt', 'updatedAt']);
    }

    logAdmin('Liste abonnements consultée', { count: subs.length });

    res.json({ count: subs.length, subscriptions: subs });
  } catch (err) {
    logAdminError('Erreur lecture abonnements', { error: err.message });
    res.status(500).json({ error: 'Erreur base de données.', code: 'DB_ERROR' });
  }
});

/* Explicit 404 for unknown admin routes (JSON, jamais de HTML) */
router.use((req, res) => {
  res.status(404).json({
    error: 'Route admin inconnue.',
    code : 'ADMIN_ROUTE_NOT_FOUND',
    path : req.path,
  });
});

module.exports = router;
