'use strict';
/**
 * OmniSMS — Service Redis (ioredis)
 *
 * Graceful degradation : si REDIS_URL absent ou Redis inaccessible (ENOTFOUND,
 * ECONNREFUSED, etc.), on exporte immédiatement un MemoryStore sans boucle
 * de reconnexion et sans spam de logs.
 *
 * Règle : un seul avertissement au démarrage, puis silence complet.
 */

const Redis  = require('ioredis');
const { logger } = require('../middleware/logger');

const REDIS_URL = process.env.REDIS_URL || null;

/* ── Stub in-memory ultra-léger (si Redis absent/inaccessible) ─── */
class MemoryStore {
  constructor(reason) {
    this._store  = new Map();
    this._expiry = new Map();
    logger.warn(`[Redis] Using in-memory fallback (${reason}). Non persistent.`);
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
    return this._store.get(key) ?? null;
  }

  async set(key, value, ...args) {
    this._store.set(key, value);
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

  async del(key)            { this._store.delete(key); this._expiry.delete(key); return 1; }
  async exists(key)         { return (!this._isExpired(key) && this._store.has(key)) ? 1 : 0; }
  async incr(key)           { const v = parseInt((await this.get(key)) || '0', 10) + 1; await this.set(key, String(v)); return v; }
  async expire(key, secs)   { this._expiry.set(key, Date.now() + secs * 1000); return 1; }
  async ttl(key)            { const e = this._expiry.get(key); return e ? Math.ceil((e - Date.now()) / 1000) : -1; }
  async keys(pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return [...this._store.keys()].filter(k => regex.test(k));
  }
  async hset(key, field, value) { const h = this._store.get(key) || {}; h[field] = value; this._store.set(key, h); return 1; }
  async hget(key, field)        { const h = this._store.get(key) || {}; return h[field] ?? null; }
  async hgetall(key)            { return this._store.get(key) ?? null; }
  async hdel(key, field)        { const h = this._store.get(key) || {}; delete h[field]; this._store.set(key, h); return 1; }
  async sadd(key, ...members)   { const s = this._store.get(key) || new Set(); members.forEach(m => s.add(m)); this._store.set(key, s); return members.length; }
  async smembers(key)           { return [...(this._store.get(key) || new Set())]; }
  async srem(key, member)       { const s = this._store.get(key) || new Set(); s.delete(member); this._store.set(key, s); return 1; }
  async llen(key)               { return (this._store.get(key) || []).length; }
  async lpush(key, ...vals)     { const a = this._store.get(key) || []; vals.forEach(v => a.unshift(v)); this._store.set(key, a); return a.length; }
  async rpush(key, ...vals)     { const a = this._store.get(key) || []; vals.forEach(v => a.push(v)); this._store.set(key, a); return a.length; }
  async lrange(key, s, e)       { const a = this._store.get(key) || []; return a.slice(s, e === -1 ? undefined : e + 1); }

  // Compatibilité ioredis events (no-op)
  on()    { return this; }
  once()  { return this; }
  off()   { return this; }
  quit()  { return Promise.resolve(); }
  disconnect() {}

  get status() { return 'ready'; }
  connected = false;
  isMemoryFallback = true;
}

/* ── Créer le client Redis avec fallback immédiat sur ENOTFOUND ── */
let redisClient;

function createMemoryFallback(reason) {
  return new MemoryStore(reason);
}

if (!REDIS_URL) {
  redisClient = createMemoryFallback('no REDIS_URL configured');
} else {
  // Vérifier si c'est une URL Upstash TLS (tls:// ou rediss://)
  // Upstash nécessite une connexion TLS
  let connectOptions = {
    // Pas de retry infini : 3 tentatives max puis abandon propre → MemoryStore
    maxRetriesPerRequest: null,         // requis par BullMQ
    enableReadyCheck    : false,        // évite timeout supplémentaire
    lazyConnect         : false,
    retryStrategy(times) {
      if (times >= 3) return null;      // stoppe les retries après 3 essais
      return Math.min(times * 500, 2000);
    },
    reconnectOnError() { return false; }, // pas de reconnexion sur erreur DNS
  };

  // Ajouter TLS si URL Upstash (rediss:// ou contient upstash)
  if (REDIS_URL.startsWith('rediss://') || REDIS_URL.includes('upstash')) {
    connectOptions.tls = {};
  }

  let _client;
  let _fallback = false;

  try {
    _client = new Redis(REDIS_URL, connectOptions);

    // Sur erreur DNS/réseau → switcher immédiatement vers MemoryStore
    _client.on('error', (err) => {
      if (_fallback) return;  // déjà en fallback, silence total
      const isFatal = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' ||
                      err.code === 'EAI_AGAIN'  || err.message?.includes('ENOTFOUND');
      if (isFatal) {
        _fallback = true;
        logger.warn(`[Redis] DNS/network error (${err.code || err.message}) — switching to MemoryStore.`);
        // Remplacer le module export par le MemoryStore
        const mem = createMemoryFallback(`${err.code || 'NETWORK_ERROR'}`);
        Object.assign(module.exports, mem);
        Object.setPrototypeOf(module.exports, Object.getPrototypeOf(mem));
        // Copier toutes les méthodes
        for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(mem))) {
          if (k !== 'constructor') module.exports[k] = mem[k].bind(mem);
        }
        module.exports._store        = mem._store;
        module.exports._expiry       = mem._expiry;
        module.exports.isMemoryFallback = true;
        module.exports.connected     = false;
        try { _client.disconnect(); } catch (_) {}
      } else {
        logger.error(`[Redis] Error: ${err.message}`);
      }
    });

    _client.on('connect',     () => logger.info('[Redis] Connected.'));
    _client.on('ready',       () => logger.info('[Redis] Ready.'));
    _client.on('close',       () => { if (!_fallback) logger.warn('[Redis] Connection closed.'); });
    _client.on('reconnecting',() => { if (!_fallback) logger.info('[Redis] Reconnecting…'); });

    logger.info('[Redis] Client initialized with REDIS_URL.');
    redisClient = _client;
  } catch (initErr) {
    logger.error(`[Redis] Init failed — using MemoryStore. ${initErr.message}`);
    redisClient = createMemoryFallback('init error');
  }
}

module.exports = redisClient;
