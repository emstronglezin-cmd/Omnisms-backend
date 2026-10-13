'use strict';
/**
 * OmniSMS — Pool de passerelles Android (≥ 2 téléphones/SIM).
 *
 * Registre : collection Firestore `gateway_devices`
 *   { deviceId, operator, fromNumber, dailyCapacity, minIntervalMs,
 *     status:'online'|'offline', lastHeartbeatAt, messagesSentToday, dayKey,
 *     consecutiveFailures, breaker:'closed'|'open'|'half_open', breakerUntil }
 *
 * Routage : appareil EN LIGNE, breaker fermé, sous la capacité quotidienne et
 * hors cooldown de cadence → **le moins chargé d'abord** (ratio jour/capacité).
 * Failover automatique sur le suivant en cas d'échec ; circuit breaker
 * (3 échecs consécutifs → ouvert 5 min, configurable) ; cadence par appareil
 * via le store de taux partagé (anti-blocage SIM) ; alerte immédiate (log +
 * métrique) à chaque défaillance/ouverture.
 *
 * Modèle de capacité : appareils × (dailyCapacity) — voir docs/SCALING.md §3.
 * Actif derrière GATEWAY_POOL_ENABLED=true (défaut : désactivé, comportement
 * mono-appareil historique). Hypothèse fournisseur à confirmer : le payload
 * INfiniReach accepte un `deviceId` optionnel pour cibler l'appareil.
 */

const { logger } = require('../middleware/logger');
const { metricsService } = require('./metrics');

const BREAKER_THRESHOLD = Math.max(1, parseInt(process.env.GW_BREAKER_THRESHOLD, 10) || 3);
const BREAKER_OPEN_MS = Math.max(30 * 1000, parseInt(process.env.GW_BREAKER_OPEN_MS, 10) || 5 * 60 * 1000);
const HEARTBEAT_STALE_MS = Math.max(60 * 1000, parseInt(process.env.GW_HEARTBEAT_STALE_MS, 10) || 10 * 60 * 1000);

function getDb(dbParam) {
  if (dbParam) return dbParam;
  const db = require('../config/firebase');
  return db && !db._stub ? db : null;
}
function dayKey(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10).replace(/-/g, ''); }
function mask(num) { return num ? String(num).replace(/\d{4}$/, '****') : null; }

/* ── Enregistrement / heartbeat ────────────────────────────────── */

/** Upsert d'un appareil (appelé à chaque webhook entrant portant un deviceId). */
async function recordHeartbeat(dbParam, deviceId, { operator = null, fromNumber = null } = {}) {
  const db = getDb(dbParam);
  if (!db || !deviceId) return false;
  const ref = db.collection('gateway_devices').doc(String(deviceId).slice(0, 64));
  try {
    const snap = await ref.get();
    const base = { deviceId: String(deviceId), status: 'online', lastHeartbeatAt: new Date().toISOString() };
    if (operator) base.operator = String(operator).slice(0, 32);
    if (fromNumber) base.fromNumber = String(fromNumber);
    if (snap.exists) await ref.set(base, { merge: true });
    else await ref.set({ ...base, dailyCapacity: parseInt(process.env.GW_DEFAULT_DAILY_CAPACITY, 10) || 500, minIntervalMs: parseInt(process.env.GW_DEFAULT_MIN_INTERVAL_MS, 10) || 30000, messagesSentToday: 0, dayKey: dayKey(), consecutiveFailures: 0, breaker: 'closed', createdAt: new Date().toISOString() }, { merge: true });
    return true;
  } catch (err) {
    logger.warn('[GatewayPool] heartbeat write failed', { deviceId: String(deviceId).slice(0, 32), error: err.message });
    return false;
  }
}

/** Liste normalisée des appareils disponibles maintenant (triés : moins chargé d'abord). */
async function listAvailableDevices(dbParam) {
  const db = getDb(dbParam);
  if (!db) return [];
  const snap = await db.collection('gateway_devices').limit(50).get().catch(() => ({ docs: [] }));
  const now = Date.now();
  const today = dayKey(now);
  return (snap.docs || [])
    .map((d) => ({ id: d.id, ...d.data() }))
    .map((dev) => {
      // Remise à zéro quotidienne (lazy)
      if (dev.dayKey !== today) { dev.messagesSentToday = 0; dev.dayKey = today; }
      return dev;
    })
    .filter((dev) => {
      if (dev.status !== 'online') return false;
      if (dev.lastHeartbeatAt && now - new Date(dev.lastHeartbeatAt).getTime() > HEARTBEAT_STALE_MS) return false; // appareil muet
      if (dev.breaker === 'open' && dev.breakerUntil && new Date(dev.breakerUntil).getTime() > now) return false; // breaker ouvert
      if ((Number(dev.messagesSentToday) || 0) >= (Number(dev.dailyCapacity) || 500)) return false; // capacité jour atteinte
      return true;
    })
    .sort((a, b) => {
      const ra = (Number(a.messagesSentToday) || 0) / (Number(a.dailyCapacity) || 500);
      const rb = (Number(b.messagesSentToday) || 0) / (Number(b.dailyCapacity) || 500);
      return ra - rb;
    });
}

/* ── Sélection + envoi avec failover ───────────────────────────── */

/**
 * Envoie via le pool : essaie les appareils disponibles jusqu'au succès.
 * @param {object} p { db, payload (déjà prêt pour smsGateway.sendSMS), send(device, payload) }
 * @returns {Promise<{ success:boolean, deviceId?:string, result:object, tried:string[] }>}
 */
async function sendViaPool({ db, payload, send }) {
  const devices = await listAvailableDevices(db);
  if (!devices.length) {
    return { success: false, result: { success: false, error: 'GW_POOL_NO_DEVICE_AVAILABLE' }, tried: [] };
  }
  const rateStore = require('./rateStore');
  const tried = [];
  let lastResult = { success: false, error: 'GW_POOL_EXHAUSTED' };

  for (const dev of devices) {
    const minInterval = Math.max(0, Number(dev.minIntervalMs) || 0);
    const cadence = await rateStore.hit(`gwdev:${dev.id}`, Math.max(minInterval, 1000), 1);
    if (!cadence.allowed) {
      logger.info('[GatewayPool] cadence cooldown → appareil sauté', { device: dev.id, minIntervalMs: minInterval });
      continue;
    }
    tried.push(dev.id);
    let result;
    try {
      result = await send(dev, { ...payload, deviceId: dev.id, from: dev.fromNumber || payload.from });
    } catch (err) {
      result = { success: false, error: err.message };
    }
    metricsService.deviceSend(dev.id, !!result.success);
    if (result.success) {
      await _onSuccess(db, dev);
      return { success: true, deviceId: dev.id, result, tried };
    }
    lastResult = result;
    await _onFailure(db, dev, result);
  }
  return { success: false, result: lastResult, tried };
}

async function _onSuccess(dbParam, dev) {
  const db = getDb(dbParam);
  if (!db) return;
  const ref = db.collection('gateway_devices').doc(dev.id);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : { messagesSentToday: 0, dayKey: dayKey() };
      const today = dayKey();
      const count = (data.dayKey === today ? Number(data.messagesSentToday) || 0 : 0) + 1;
      const update = { messagesSentToday: count, dayKey: today, consecutiveFailures: 0, breaker: 'closed', lastSendAt: new Date().toISOString() };
      if (snap.exists) tx.update(ref, update);
      else tx.set(ref, { deviceId: dev.id, ...update }, { merge: true });
    });
  } catch (_) {}
}

async function _onFailure(dbParam, dev, result) {
  const db = getDb(dbParam);
  const failures = (Number(dev.consecutiveFailures) || 0) + 1;
  const open = failures >= BREAKER_THRESHOLD;
  logger.error('[GatewayPool] échec envoi appareil', {
    device: dev.id,
    from: mask(dev.fromNumber),
    consecutiveFailures: failures,
    breaker: open ? 'OPEN' : dev.breaker || 'closed',
    error: String(result.error || '').slice(0, 200),
  });
  metricsService.deviceAlert(dev.id, open ? 'breaker_open' : 'send_failed');
  if (!db) return;
  const ref = db.collection('gateway_devices').doc(dev.id);
  const update = { consecutiveFailures: failures };
  if (open) {
    update.breaker = 'open';
    update.breakerUntil = new Date(Date.now() + BREAKER_OPEN_MS).toISOString();
    update.status = 'offline'; // alerte explicite : appareil considéré défaillant
    logger.error('[GatewayPool] ALERTE : circuit breaker OUVERT — appareil retiré du pool', {
      device: dev.id,
      from: mask(dev.fromNumber),
      reopenInMs: BREAKER_OPEN_MS,
      action: 'Vérifier l app INfiniReach / la SIM / le réseau sur cet appareil.',
    });
  }
  await ref.set(update, { merge: true }).catch(() => {});
}

/* ── État du pool (métriques / SCALING) ────────────────────────── */

async function poolStatus(dbParam) {
  const db = getDb(dbParam);
  if (!db) return { devices: 0, dailyCapacity: 0, available: 0 };
  const snap = await db.collection('gateway_devices').limit(50).get().catch(() => ({ docs: [] }));
  const devices = (snap.docs || []).map((d) => ({ id: d.id, ...d.data() }));
  const available = await listAvailableDevices(db);
  return {
    devices: devices.length,
    dailyCapacity: devices.reduce((sum, d) => sum + (Number(d.dailyCapacity) || 0), 0),
    sentToday: devices.reduce((sum, d) => sum + (Number(d.messagesSentToday) || 0), 0),
    available: available.length,
    breakerOpen: devices.filter((d) => d.breaker === 'open').length,
  };
}

function isEnabled() {
  return (process.env.GATEWAY_POOL_ENABLED || '').trim().toLowerCase() === 'true';
}

module.exports = { recordHeartbeat, listAvailableDevices, sendViaPool, poolStatus, isEnabled };
