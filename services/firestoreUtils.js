'use strict';
/**
 * OmniSMS — Utilitaires Firestore pour l'échelle.
 *
 * - shardCounter   : compteurs shardés (évite les docs chauds > 1 écriture/s)
 * - runBatched     : écritures groupées par lots bornés (≤ 450 par batch)
 * - cursorPaginate : pagination par curseur (startAfter doc), pas d'offset
 * - getWithCache / invalidateCache : cache Redis des lectures chaudes
 *   (numéro → utilisateur) avec TTL court ; fallback mémoire.
 *
 * Aucune migration : ce sont des helpers, adoptés appel par appel.
 */

const SHARDS_DEFAULT = 10;

function getDb(dbParam) {
  if (dbParam) return dbParam;
  const db = require('../config/firebase');
  return db && !db._stub ? db : null;
}

/* ── Compteur shardé ─────────────────────────────────────────────
 * doc racine `counters/{name}` + shards `counters/{name}_shards/{0..N-1}`.
 * totalCounter() somme les shards (reads: N — appelé rarement, ex. admin).
 */
async function shardIncrement(dbParam, name, by = 1, shards = SHARDS_DEFAULT) {
  const db = getDb(dbParam);
  if (!db) throw new Error('firestoreUtils: db requis');
  const shardId = Math.floor(Math.random() * shards);
  const ref = db.collection('counters').doc(`${name}_shard_${shardId}`);
  // Read-modify-write avec 2 retries : les shards éliminent la contention par
  // document (le but est la répartition de charge, pas la précision comptable —
  // pour la comptabilité, utiliser le ledger transactionnel).
  for (let attempt = 0; ; attempt++) {
    try {
      const snap = await ref.get();
      const cur = snap.exists ? Number(snap.data().count) || 0 : 0;
      await ref.set({ count: cur + by, name, shardId }, { merge: true });
      return { name, shardId, by };
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

async function shardTotal(dbParam, name, shards = SHARDS_DEFAULT) {
  const db = getDb(dbParam);
  if (!db) return 0;
  const reads = [];
  for (let i = 0; i < shards; i++) {
    reads.push(db.collection('counters').doc(`${name}_shard_${i}`).get().catch(() => ({ exists: false })));
  }
  const snaps = await Promise.all(reads);
  return snaps.reduce((sum, snap) => sum + (snap && snap.exists ? Number(snap.data().count) || 0 : 0), 0);
}

/* ── Écritures groupées bornées ────────────────────────────────── */
/** Applique fn(batch) par lots de `size` (max 450 — limite Firestore 500 avec marge). */
async function runBatched(db, items, fn, size = 450) {
  const safeSize = Math.min(Math.max(1, size), 450);
  let done = 0;
  for (let i = 0; i < items.length; i += safeSize) {
    const batch = db.batch ? db.batch() : null;
    if (!batch) throw new Error('runBatched: db.batch indisponible (stub ?)');
    const chunk = items.slice(i, i + safeSize);
    await fn(batch, chunk);
    await batch.commit();
    done += chunk.length;
  }
  return done;
}

/* ── Pagination par curseur ────────────────────────────────────── */
/**
 * Page de résultats par curseur.
 * @param {object} p { collection, filters:[[field,op,value]], orderBy, desc, limit, cursor }
 *   cursor = id du dernier document de la page précédente (opaque côté client).
 * @returns {{ items:Array, nextCursor:string|null }}
 */
async function cursorPaginate(dbParam, { collection, filters = [], orderBy = 'createdAt', desc = true, limit = 20, cursor = null }) {
  const db = getDb(dbParam);
  if (!db) return { items: [], nextCursor: null };
  let q = db.collection(collection);
  for (const [f, op, v] of filters) q = q.where(f, op, v);
  q = q.orderBy(orderBy, desc ? 'desc' : 'asc');
  if (cursor) {
    const snapDoc = await db.collection(collection).doc(String(cursor)).get().catch(() => null);
    if (snapDoc && snapDoc.exists) q = q.startAfter(snapDoc);
  }
  const snap = await q.limit(Math.min(limit, 100)).get();
  const docs = snap.docs || [];
  return {
    items: docs.map((d) => ({ id: d.id, ...d.data() })),
    nextCursor: docs.length ? docs[docs.length - 1].id : null,
  };
}

/* ── Cache Redis des lectures chaudes ──────────────────────────── */
const _memCache = new Map(); // clé → { value, exp }

/**
 * Lecture en cache (Redis si dispo, sinon mémoire) avec fallback loader.
 * USER_CACHE_ENABLED=true pour activer (défaut off — aucun changement).
 */
async function getWithCache(key, ttlMs, loader, { enabled = true } = {}) {
  if (!enabled) return loader();
  try {
    const redis = require('./redis');
    const useRedis = redis && !redis.isMemoryFallback;
    if (useRedis) {
      const hit = await redis.get(`cache:${key}`).catch(() => null);
      if (hit) return JSON.parse(hit);
      const value = await loader();
      await redis.set(`cache:${key}`, JSON.stringify(value), 'PX', Math.min(ttlMs, 86400000)).catch(() => {});
      return value;
    }
  } catch (_) { /* fallback mémoire */ }
  const now = Date.now();
  const entry = _memCache.get(key);
  if (entry && entry.exp > now) return entry.value;
  const value = await loader();
  if (_memCache.size > 5000) _memCache.clear();
  _memCache.set(key, { value, exp: now + ttlMs });
  return value;
}

/** Invalidation explicite (ex : profil mis à jour). */
async function invalidateCache(key) {
  _memCache.delete(key);
  try {
    const redis = require('./redis');
    if (redis && !redis.isMemoryFallback) await redis.del(`cache:${key}`).catch(() => {});
  } catch (_) {}
}

function isUserCacheEnabled() {
  return (process.env.USER_CACHE_ENABLED || '').trim().toLowerCase() === 'true';
}

module.exports = { shardIncrement, shardTotal, runBatched, cursorPaginate, getWithCache, invalidateCache, isUserCacheEnabled };
