'use strict';
/**
 * OmniSMS — Service Redis (ioredis)
 *
 * Graceful degradation : si REDIS_URL absent ou Redis inaccessible
 * (ENOTFOUND, ECONNREFUSED, EAI_AGAIN…), bascule immédiatement sur
 * un MemoryStore en mémoire — sans boucle infinie, sans crash, sans
 * redémarrage Render.
 *
 * Règle : UN seul avertissement au démarrage, puis silence total.
 */

const { logger } = require('../middleware/logger');

const REDIS_URL = process.env.REDIS_URL || null;

/* ═══════════════════════════════════════════════════════════════
   MemoryStore — drop-in replacement pour ioredis
   Implémente toutes les méthodes utilisées dans l'application.
   Aucune dépendance externe.
══════════════════════════════════════════════════════════════════ */
class MemoryStore {
  constructor(reason) {
    this._store  = new Map();
    this._expiry = new Map();
    this.status  = 'ready';
    this.connected      = false;
    this.isMemoryFallback = true;
    logger.warn(`[Redis] MemoryStore activé (${reason}). Données non persistantes.`);
  }

  /* ── Expiry helper ─────────────────────────────────────────── */
  _isExpired(key) {
    const exp = this._expiry.get(key);
    if (exp && Date.now() > exp) {
      this._store.delete(key);
      this._expiry.delete(key);
      return true;
    }
    return false;
  }

  /* ── Strings ───────────────────────────────────────────────── */
  async get(key) {
    if (this._isExpired(key)) return null;
    const v = this._store.get(key);
    return v === undefined ? null : v;
  }

  async set(key, value, ...args) {
    this._store.set(key, value);
    // Parse EX / PX options
    for (let i = 0; i < args.length; i++) {
      const a = typeof args[i] === 'string' ? args[i].toUpperCase() : '';
      if (a === 'EX'  && args[i + 1]) { this._expiry.set(key, Date.now() + parseInt(args[i + 1], 10) * 1000); i++; }
      if (a === 'PX'  && args[i + 1]) { this._expiry.set(key, Date.now() + parseInt(args[i + 1], 10)); i++; }
      if (a === 'KEEPTTL')             { /* keep existing */ }
    }
    return 'OK';
  }

  async del(key)          { this._store.delete(key); this._expiry.delete(key); return 1; }
  async exists(key)       { return (!this._isExpired(key) && this._store.has(key)) ? 1 : 0; }
  async incr(key)         { const v = parseInt((await this.get(key)) || '0', 10) + 1; await this.set(key, String(v)); return v; }
  async incrby(key, n)    { const v = parseInt((await this.get(key)) || '0', 10) + n; await this.set(key, String(v)); return v; }
  async decr(key)         { const v = parseInt((await this.get(key)) || '0', 10) - 1; await this.set(key, String(v)); return v; }
  async decrby(key, n)    { const v = parseInt((await this.get(key)) || '0', 10) - n; await this.set(key, String(v)); return v; }
  async getset(key, val)  { const old = await this.get(key); await this.set(key, val); return old; }
  async setnx(key, val)   { if (this._store.has(key) && !this._isExpired(key)) return 0; await this.set(key, val); return 1; }
  async setex(key, secs, val) { await this.set(key, val, 'EX', secs); return 'OK'; }
  async psetex(key, ms, val)  { await this.set(key, val, 'PX', ms);   return 'OK'; }

  /* ── Expiry ────────────────────────────────────────────────── */
  async expire(key, secs) { this._expiry.set(key, Date.now() + secs * 1000); return 1; }
  async pexpire(key, ms)  { this._expiry.set(key, Date.now() + ms); return 1; }
  async ttl(key)   { const e = this._expiry.get(key); return e ? Math.max(0, Math.ceil((e - Date.now()) / 1000)) : -1; }
  async pttl(key)  { const e = this._expiry.get(key); return e ? Math.max(0, e - Date.now()) : -1; }
  async persist(key) { this._expiry.delete(key); return 1; }

  /* ── Keys ──────────────────────────────────────────────────── */
  async keys(pattern) {
    const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return [...this._store.keys()].filter(k => !this._isExpired(k) && regex.test(k));
  }
  async scan(cursor, ...args) { return ['0', []]; }

  /* ── Hashes ────────────────────────────────────────────────── */
  async hset(key, ...args) {
    const h = this._store.get(key) || {};
    if (args.length === 2) { h[args[0]] = args[1]; }
    else { for (let i = 0; i < args.length; i += 2) h[args[i]] = args[i + 1]; }
    this._store.set(key, h); return 1;
  }
  async hget(key, field)    { const h = this._store.get(key) || {}; return h[field] ?? null; }
  async hmget(key, ...flds) { const h = this._store.get(key) || {}; return flds.map(f => h[f] ?? null); }
  async hmset(key, obj)     { const h = this._store.get(key) || {}; Object.assign(h, obj); this._store.set(key, h); return 'OK'; }
  async hgetall(key)        { return this._store.get(key) ?? null; }
  async hdel(key, ...flds)  { const h = this._store.get(key) || {}; flds.forEach(f => delete h[f]); this._store.set(key, h); return flds.length; }
  async hexists(key, field) { const h = this._store.get(key) || {}; return field in h ? 1 : 0; }
  async hkeys(key)          { return Object.keys(this._store.get(key) || {}); }
  async hvals(key)          { return Object.values(this._store.get(key) || {}); }
  async hlen(key)           { return Object.keys(this._store.get(key) || {}).length; }
  async hincrby(key, f, n)  { const h = this._store.get(key) || {}; h[f] = (parseInt(h[f] || '0', 10) + n); this._store.set(key, h); return h[f]; }

  /* ── Sets ──────────────────────────────────────────────────── */
  async sadd(key, ...members)  { const s = this._store.get(key) || new Set(); members.forEach(m => s.add(m)); this._store.set(key, s); return members.length; }
  async smembers(key)          { return [...(this._store.get(key) || new Set())]; }
  async srem(key, ...members)  { const s = this._store.get(key) || new Set(); members.forEach(m => s.delete(m)); this._store.set(key, s); return members.length; }
  async sismember(key, member) { return (this._store.get(key) || new Set()).has(member) ? 1 : 0; }
  async scard(key)             { return (this._store.get(key) || new Set()).size; }
  async spop(key)              { const s = this._store.get(key) || new Set(); const v = s.values().next().value; if (v !== undefined) s.delete(v); return v ?? null; }

  /* ── Lists ─────────────────────────────────────────────────── */
  async lpush(key, ...vals)  { const a = this._store.get(key) || []; vals.reverse().forEach(v => a.unshift(v)); this._store.set(key, a); return a.length; }
  async rpush(key, ...vals)  { const a = this._store.get(key) || []; vals.forEach(v => a.push(v)); this._store.set(key, a); return a.length; }
  async lpop(key)            { const a = this._store.get(key) || []; return a.shift() ?? null; }
  async rpop(key)            { const a = this._store.get(key) || []; return a.pop() ?? null; }
  async llen(key)            { return (this._store.get(key) || []).length; }
  async lrange(key, s, e)    { const a = this._store.get(key) || []; return a.slice(s, e === -1 ? undefined : e + 1); }
  async lindex(key, i)       { return (this._store.get(key) || [])[i] ?? null; }

  /* ── Pub/Sub stubs (no-op) ─────────────────────────────────── */
  async publish()   { return 0; }
  async subscribe() { return this; }

  /* ── ioredis event emitter stubs ──────────────────────────── */
  on()      { return this; }
  once()    { return this; }
  off()     { return this; }
  emit()    { return false; }

  /* ── Connection stubs ─────────────────────────────────────── */
  async quit()       { return 'OK'; }
  async flushall()   { this._store.clear(); this._expiry.clear(); return 'OK'; }
  async flushdb()    { this._store.clear(); this._expiry.clear(); return 'OK'; }
  disconnect()       {}
  async connect()    { return this; }
  async ping()       { return 'PONG'; }
}

/* ═══════════════════════════════════════════════════════════════
   Factory — crée le client Redis OU le MemoryStore
══════════════════════════════════════════════════════════════════ */

let _client = null;

if (!REDIS_URL) {
  /* ── Pas de REDIS_URL configuré ──────────────────────────── */
  _client = new MemoryStore('REDIS_URL non configuré');
} else {
  /* ── Tenter une connexion Redis ──────────────────────────── */
  let _switchedToMemory = false;

  function switchToMemory(reason) {
    if (_switchedToMemory) return;
    _switchedToMemory = true;

    const mem = new MemoryStore(reason);

    // Remplacer les exports par le MemoryStore
    // On copie les méthodes manuellement pour éviter
    // l'erreur "mem[k].bind is not a function" liée à
    // Object.getOwnPropertyNames() qui peut retourner des
    // propriétés non-fonctions (getters, _store, _expiry…)
    const METHODS = [
      'get', 'set', 'del', 'exists', 'incr', 'incrby', 'decr', 'decrby',
      'getset', 'setnx', 'setex', 'psetex',
      'expire', 'pexpire', 'ttl', 'pttl', 'persist',
      'keys', 'scan',
      'hset', 'hget', 'hmget', 'hmset', 'hgetall', 'hdel',
      'hexists', 'hkeys', 'hvals', 'hlen', 'hincrby',
      'sadd', 'smembers', 'srem', 'sismember', 'scard', 'spop',
      'lpush', 'rpush', 'lpop', 'rpop', 'llen', 'lrange', 'lindex',
      'publish', 'subscribe',
      'on', 'once', 'off', 'emit',
      'quit', 'flushall', 'flushdb', 'disconnect', 'connect', 'ping',
    ];

    METHODS.forEach(name => {
      if (typeof mem[name] === 'function') {
        module.exports[name] = mem[name].bind(mem);
      }
    });

    module.exports._store          = mem._store;
    module.exports._expiry         = mem._expiry;
    module.exports.status          = 'ready';
    module.exports.connected       = false;
    module.exports.isMemoryFallback = true;

    // Déconnecter ioredis silencieusement
    try {
      if (_client && typeof _client.disconnect === 'function') {
        _client.disconnect();
      }
    } catch (_) {}

    _client = mem;
  }

  try {
    const Redis = require('ioredis');

    const options = {
      maxRetriesPerRequest: null,
      enableReadyCheck    : false,
      lazyConnect         : false,
      connectTimeout      : 10000,
      commandTimeout      : 5000,
      retryStrategy(times) {
        if (times >= 3) return null;  // stoppe après 3 tentatives
        return Math.min(times * 500, 2000);
      },
      reconnectOnError() {
        return false;  // pas de reconnexion auto sur erreur
      },
    };

    // TLS requis pour Upstash (rediss:// ou URL contient "upstash")
    if (REDIS_URL.startsWith('rediss://') || REDIS_URL.includes('upstash')) {
      options.tls = {};
    }

    const ioClient = new Redis(REDIS_URL, options);

    /* ── Gestion des erreurs ─────────────────────────────── */
    ioClient.on('error', (err) => {
      if (_switchedToMemory) return;  // déjà en fallback — silence total

      const isFatal =
        err.code === 'ENOTFOUND'     ||
        err.code === 'ECONNREFUSED'  ||
        err.code === 'EAI_AGAIN'     ||
        err.code === 'ETIMEDOUT'     ||
        err.code === 'ECONNRESET'    ||
        (err.message && (
          err.message.includes('ENOTFOUND') ||
          err.message.includes('getaddrinfo')
        ));

      if (isFatal) {
        logger.warn(`[Redis] Erreur réseau fatale (${err.code || err.message}) — MemoryStore activé.`);
        switchToMemory(`${err.code || 'NETWORK_ERROR'}`);
      } else {
        logger.error(`[Redis] Erreur non fatale : ${err.message}`);
      }
    });

    ioClient.on('connect',      () => { if (!_switchedToMemory) logger.info('[Redis] Connecté.'); });
    ioClient.on('ready',        () => { if (!_switchedToMemory) logger.info('[Redis] Prêt.'); });
    ioClient.on('close',        () => { if (!_switchedToMemory) logger.warn('[Redis] Connexion fermée.'); });
    ioClient.on('reconnecting', () => { if (!_switchedToMemory) logger.info('[Redis] Reconnexion…'); });
    ioClient.on('end',          () => {
      if (!_switchedToMemory) {
        logger.warn('[Redis] Connexion terminée — MemoryStore activé.');
        switchToMemory('connexion terminée');
      }
    });

    logger.info('[Redis] Client ioredis initialisé.');
    _client = ioClient;

  } catch (initErr) {
    logger.error(`[Redis] Initialisation échouée — ${initErr.message}. MemoryStore activé.`);
    _client = new MemoryStore(`init error: ${initErr.message}`);
  }
}

module.exports = _client;
