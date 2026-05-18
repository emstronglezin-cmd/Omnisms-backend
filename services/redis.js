'use strict';
/**
 * OmniSMS — Service Redis (ioredis)
 *
 * Graceful degradation : si REDIS_URL absent ou Redis inaccessible,
 * on exporte un client factice qui log les erreurs sans crasher.
 *
 * Usage :
 *   const redis = require('./redis');
 *   await redis.set('key', 'value', 'EX', 60);
 *   await redis.get('key');
 */

const Redis  = require('ioredis');
const { logger } = require('../middleware/logger');

const REDIS_URL = process.env.REDIS_URL || null;

/* ── Stub in-memory ultra-léger (si Redis absent) ─────────── */
class MemoryStore {
  constructor() {
    this._store = new Map();
    this._expiry = new Map();
    logger.warn('[Redis] REDIS_URL absent — using in-memory fallback (non persistent, non distribué).');
    logger.warn('[Redis] Add REDIS_URL in Render: Settings → Environment Variables.');
  }

  _isExpired(key) {
    const exp = this._expiry.get(key);
    if (exp && Date.now() > exp) {
      this._store.delete(key);
      this._expiry.delete(key);
      return true;
    }
    return false;
  }

  async get(key) {
    if (this._isExpired(key)) return null;
    return this._store.get(key) || null;
  }

  async set(key, value, ...args) {
    this._store.set(key, value);
    // Gestion EX (secondes) ou PX (millisecondes)
    const idx = args.findIndex(a => typeof a === 'string' && a.toUpperCase() === 'EX');
    if (idx !== -1 && args[idx + 1]) {
      this._expiry.set(key, Date.now() + parseInt(args[idx + 1], 10) * 1000);
    }
    const pxIdx = args.findIndex(a => typeof a === 'string' && a.toUpperCase() === 'PX');
    if (pxIdx !== -1 && args[pxIdx + 1]) {
      this._expiry.set(key, Date.now() + parseInt(args[pxIdx + 1], 10));
    }
    return 'OK';
  }

  async del(key) {
    this._store.delete(key);
    this._expiry.delete(key);
    return 1;
  }

  async exists(key) {
    if (this._isExpired(key)) return 0;
    return this._store.has(key) ? 1 : 0;
  }

  async incr(key) {
    const v = parseInt(await this.get(key) || '0', 10) + 1;
    await this.set(key, String(v));
    return v;
  }

  async expire(key, seconds) {
    this._expiry.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async keys(pattern) {
    // Implémentation basique du glob pattern
    const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
    return [...this._store.keys()].filter(k => regex.test(k));
  }

  async hset(key, field, value) {
    const hash = this._store.get(key) || {};
    hash[field] = value;
    this._store.set(key, hash);
    return 1;
  }

  async hget(key, field) {
    const hash = this._store.get(key) || {};
    return hash[field] || null;
  }

  async hgetall(key) {
    return this._store.get(key) || null;
  }

  async hdel(key, field) {
    const hash = this._store.get(key) || {};
    delete hash[field];
    this._store.set(key, hash);
    return 1;
  }

  async sadd(key, ...members) {
    const set = this._store.get(key) || new Set();
    members.forEach(m => set.add(m));
    this._store.set(key, set);
    return members.length;
  }

  async smembers(key) {
    const set = this._store.get(key) || new Set();
    return [...set];
  }

  async srem(key, member) {
    const set = this._store.get(key) || new Set();
    set.delete(member);
    this._store.set(key, set);
    return 1;
  }

  // Compatibilité ioredis events (no-op)
  on()   { return this; }
  once() { return this; }
  off()  { return this; }

  status = 'ready';
  connected = false; // indique que c'est le fallback
}

/* ── Client Redis réel ───────────────────────────────────── */
let redisClient;

if (REDIS_URL) {
  try {
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest   : 3,
      enableReadyCheck       : true,
      retryStrategy(times) {
        if (times > 5) return null; // stop retrying
        return Math.min(times * 200, 2000);
      },
      reconnectOnError(err) {
        const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT'];
        return targetErrors.some(e => err.message.includes(e));
      },
    });

    redisClient.on('connect',  () => logger.info('[Redis] Connected to Redis.'));
    redisClient.on('ready',    () => logger.info('[Redis] Redis ready.'));
    redisClient.on('error',    (err) => logger.error('[Redis] Error:', { msg: err.message }));
    redisClient.on('close',    () => logger.warn('[Redis] Connection closed.'));
    redisClient.on('reconnecting', () => logger.info('[Redis] Reconnecting…'));

    redisClient.connected = true;
    logger.info('[Redis] Client initialized with REDIS_URL.');
  } catch (err) {
    logger.error('[Redis] Init failed — using memory fallback.', { error: err.message });
    redisClient = new MemoryStore();
  }
} else {
  redisClient = new MemoryStore();
}

module.exports = redisClient;
