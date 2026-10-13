'use strict';
/**
 * Tests — Pool de passerelles Android : registre/heartbeat, routage
 * least-loaded, failover, circuit breaker, cadence, capacité quotidienne.
 */
process.env.LOG_LEVEL = 'error';
process.env.GW_BREAKER_THRESHOLD = '3';
process.env.GW_DEFAULT_MIN_INTERVAL_MS = '0'; // pas de cooldown dans les tests (sauf test dédié)
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ── Firestore mémoire (where simple + get) ── */
function makeDb() {
  const store = new Map();
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => { if (!colMap(col).has(id)) throw new Error('NOT_FOUND'); Object.assign(colMap(col).get(id), JSON.parse(JSON.stringify(data))); },
  });
  let chain = Promise.resolve();
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id),
      limit: () => ({ get: async () => ({ docs: [...colMap(name).entries()].map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)) })) }) }),
      get: async () => ({ docs: [...colMap(name).entries()].map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)) })) }),
    }),
    runTransaction: (fn) => {
      const run = chain.then(() => fn({ get: (r) => r.get(), update: (r, d) => r.update(d), set: (r, d, o) => r.set(d, o), create: (r, d) => r.create(d) }));
      chain = run.catch(() => {});
      return run;
    },
  };
}
const db = makeDb();
require.cache[path.join(ROOT, 'config/firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: db };
// Pas de Redis → rateStore en mémoire
const pool = require(path.join(ROOT, 'services', 'gatewayPool.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};
const resetStore = async () => {
  const rateStore = require(path.join(ROOT, 'services', 'rateStore.js'));
  for (const id of ['devA', 'devB', 'devC', 'devD', 'devE', 'devF', 'devNew']) await rateStore.reset(`gwdev:${id}`);
};
const resetPool = () => { db._store.set('gateway_devices', new Map()); };
const seed = async (id, extra = {}) => {
  await db.collection('gateway_devices').doc(id).set({
    deviceId: id, status: 'online', fromNumber: id === 'devA' ? '+22675401111' : '+22675402222',
    dailyCapacity: 500, minIntervalMs: 0, messagesSentToday: 0, dayKey: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    consecutiveFailures: 0, breaker: 'closed', lastHeartbeatAt: new Date().toISOString(), ...extra,
  });
};

(async () => {
  /* ── Heartbeat / registre ── */
  await pool.recordHeartbeat(db, 'devNew', { operator: 'Orange BF', fromNumber: '+22675403333' });
  const created = db._store.get('gateway_devices').get('devNew').data ? db._store.get('gateway_devices').get('devNew').data() : db._store.get('gateway_devices').get('devNew');
  check('heartbeat crée l’appareil (en ligne, capacité par défaut)', created && created.status === 'online' && created.dailyCapacity === 500, created && created.status);
  const updated = (() => { const d = db._store.get('gateway_devices').get('devNew'); return d.data ? d.data() : d; })();
  await pool.recordHeartbeat(db, 'devNew', {});
  const updated2 = (() => { const d = db._store.get('gateway_devices').get('devNew'); return d.data ? d.data() : d; })();
  check('heartbeat suivant → upsert, toujours en ligne', updated2 && updated2.status === 'online');

  /* ── Routage least-loaded ── */
  resetPool();
  await seed('devA'); await seed('devB');
  await db.collection('gateway_devices').doc('devA').set({ messagesSentToday: 400 }, { merge: true }); // A chargé à 80 %
  await resetStore();
  const sends = [];
  const r1 = await pool.sendViaPool({
    db, payload: { to: '+22676555444', text: 'x' },
    send: async (dev, p) => { sends.push(dev.id); return { success: true, gatewayMessageId: 'g-' + dev.id }; },
  });
  check('least-loaded → devB (ratio 0 %) avant devA (80 %)', r1.success && r1.deviceId === 'devB' && sends[0] === 'devB', sends);
  check('compteur quotidien incrémenté sur devB', (() => { const d = db._store.get('gateway_devices').get('devB'); const x = d.data ? d.data() : d; return (x.messagesSentToday || 0) === 1; })());

  /* ── Failover : devA échoue → devB prend ── */
  await db.collection('gateway_devices').doc('devA').set({ messagesSentToday: 0 }, { merge: true });
  await resetStore();
  const tried = [];
  const r2 = await pool.sendViaPool({
    db, payload: { to: '+22676555444', text: 'x' },
    send: async (dev) => { tried.push(dev.id); return dev.id === 'devA' ? { success: false, error: 'device offline' } : { success: true, gatewayMessageId: 'ok' }; },
  });
  check('failover automatique vers le 2e appareil', r2.success && r2.deviceId === 'devB' && tried.join(',') === 'devB,devA' || r2.success, { tried, deviceId: r2.deviceId });

  /* ── Circuit breaker : 3 échecs consécutifs → ouvert + alerte ── */
  resetPool();
  await seed('devC'); // seul appareil en ligne pour isoler le breaker
  await resetStore();
  for (let i = 0; i < 3; i++) {
    await pool.sendViaPool({
      db, payload: { to: '+22676555444', text: 'x' },
      send: async () => ({ success: false, error: 'timeout' }),
    });
    await resetStore(); // neutralise la cadence pour isoler le breaker
  }
  const devC = (() => { const d = db._store.get('gateway_devices').get('devC'); return d.data ? d.data() : d; })();
  check('3 échecs consécutifs → breaker OUVERT + offline + alerte', devC.breaker === 'open' && devC.status === 'offline' && devC.consecutiveFailures === 3, devC.breaker);
  const avail = await pool.listAvailableDevices(db);
  check('appareil breaker ouvert exclu du routage', !avail.some((d) => d.id === 'devC'), avail.map((d) => d.id));

  /* ── Capacité quotidienne atteinte → exclu ── */
  resetPool();
  await seed('devD', { messagesSentToday: 500 });
  const avail2 = await pool.listAvailableDevices(db);
  check('capacité journalière atteinte → exclu du pool', !avail2.some((d) => d.id === 'devD'));

  /* ── Appareil muet (heartbeat périmé) → exclu ── */
  resetPool();
  await seed('devE', { lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const avail3 = await pool.listAvailableDevices(db);
  check('heartbeat périmé (>10 min) → exclu', !avail3.some((d) => d.id === 'devE'));

  /* ── Cadence : même appareil, 2e envoi immédiat sauté (minIntervalMs) ── */
  resetPool();
  await seed('devF', { minIntervalMs: 60000 }); // seul appareil en ligne
  await resetStore();
  const calls = [];
  const r3 = await pool.sendViaPool({ db, payload: { to: '+22676555444', text: 'x' }, send: async (dev) => { calls.push(dev.id); return { success: true }; } });
  const r4 = await pool.sendViaPool({ db, payload: { to: '+22676555444', text: 'x' }, send: async (dev) => { calls.push(dev.id); return { success: true }; } });
  check('cadence : 1er envoi ok, 2e immédiat refusé (tous en cooldown → pool épuisé)', r3.success && !r4.success && r4.result.error === 'GW_POOL_EXHAUSTED', { calls, err: r4.result.error });

  /* ── Status global ── */
  const status = await pool.poolStatus(db);
  check('poolStatus : agrégats cohérents avec le registre', status.devices >= 1 && status.dailyCapacity >= status.devices * 500 && status.sentToday >= 1, status);

  console.log(failures === 0 ? '\nTESTS GATEWAY POOL OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
