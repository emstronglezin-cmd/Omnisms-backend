'use strict';
/**
 * OmniSMS — Store de taux partagé (fenêtre fixe Redis, fallback mémoire).
 *
 * Remplace les compteurs en mémoire éparses (limites de commandes SMS,
 * cooldowns de notifications, anti-fraude) pour qu'ils survivent aux
 * redéploiements et soient cohérents entre instances.
 *
 * Fenêtre FIXE (INCR + EXPIRE) : précision suffisante pour nos garde-fous,
 * coût O(1). Le fallback mémoire reproduit exactement la sémantique
 * (comportement historique) quand Redis est indisponible.
 */

const { logger } = require('../middleware/logger');

/* ── Fallback mémoire ─────────────────────────────────────────── */
const _mem = new Map(); // clé → { count, resetAt }

function _memHit(key, windowMs, max) {
  const now = Date.now();
  let entry = _mem.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    _mem.set(key, entry);
  }
  entry.count += 1;
  // Limitation de taille (anti-fuite)
  if (_mem.size > 20000) {
    for (const [k, v] of _mem) { if (v.resetAt <= now) _mem.delete(k); }
    if (_mem.size > 20000) _mem.clear();
  }
  return { allowed: entry.count <= max, count: entry.count, remaining: Math.max(0, max - entry.count), resetMs: entry.resetAt - now };
}

/* ── Accès Redis (client partagé services/redis) ──────────────── */
function _redis() {
  try {
    const redis = require('./redis');
    if (redis && redis.isMemoryFallback) return null;
    return redis;
  } catch (_) { return null; }
}

/**
 * Enregistre un « hit » et applique la limite.
 * @param {string} key    clé logique (ex: `cmd:${phone}`, `insuff:${uid}`)
 * @param {number} windowMs fenêtre en ms
 * @param {number} max    hits max par fenêtre
 * @returns {{ allowed:boolean, count:number, remaining:number, resetMs:number }}
 */
async function hit(key, windowMs, max) {
  const redis = _redis();
  if (!redis) return _memHit(key, windowMs, max);
  try {
    const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
    const count = await redis.incr(`rate:${key}`);
    if (count === 1) await redis.expire(`rate:${key}`, windowSec);
    const ttl = await redis.ttl(`rate:${key}`);
    return {
      allowed: count <= max,
      count,
      remaining: Math.max(0, max - count),
      resetMs: (ttl > 0 ? ttl : windowSec) * 1000,
    };
  } catch (err) {
    logger.warn('[RateStore] Redis indisponible → fallback mémoire', { error: err.message });
    return _memHit(key, windowMs, max);
  }
}

/** Lecture sans hit (débogage/audit). */
async function peek(key) {
  const redis = _redis();
  if (!redis) {
    const e = _mem.get(key);
    return e ? { count: e.count, resetMs: e.resetAt - Date.now() } : { count: 0, resetMs: 0 };
  }
  try {
    const count = Number(await redis.get(`rate:${key}`)) || 0;
    const ttl = await redis.ttl(`rate:${key}`);
    return { count, resetMs: (ttl > 0 ? ttl : 0) * 1000 };
  } catch (_) { return { count: 0, resetMs: 0 }; }
}

/** Remise à zéro explicite (admin/tests). */
async function reset(key) {
  const redis = _redis();
  _mem.delete(key);
  if (redis) { try { await redis.del(`rate:${key}`); } catch (_) {} }
}

module.exports = { hit, peek, reset };
