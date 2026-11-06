'use strict';
/* Phases pour test/android-gateway-tests.js — serveur réel + Firestore simulé. */
const path = require('path');
const http = require('http');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');

function makeDb() {
  const store = new Map();
  let auto = 0;
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => {
    const ref = { id, _col: col };
    ref.get = async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), ref }; };
    ref.set = async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); };
    ref.update = async (data) => { if (!colMap(col).has(id)) throw new Error('NOT_FOUND'); Object.assign(colMap(col).get(id), JSON.parse(JSON.stringify(data))); };
    ref.delete = async () => colMap(col).delete(id);
    return ref;
  };
  const makeQuery = (name, filter, n) => ({
    async get() {
      let entries = [...colMap(name).entries()];
      if (filter) entries = entries.filter(([, d]) => d[filter.f] === filter.v);
      const docs = entries.slice(0, n).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: docRef(name, id) }));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id || `auto-${++auto}`),
      where: (f, _op, v) => ({ limit: (n) => makeQuery(name, { f, v }, n) }),
      limit: (n) => makeQuery(name, null, n),
    }),
    async runTransaction(fn) {
      const tx = {
        get: async (q) => q.get(),
        update: (ref, data) => { if (!colMap(ref._col).has(ref.id)) throw new Error('NOT_FOUND'); Object.assign(colMap(ref._col).get(ref.id), JSON.parse(JSON.stringify(data))); },
        set: (ref, data, opts) => { const p = colMap(ref._col).get(ref.id) || {}; colMap(ref._col).set(ref.id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
      };
      return await fn(tx);
    },
  };
}

function req(port, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); } catch (_) { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function boot() {
  stubCoreOnce();
  process.env.PORT = '5078';
  process.env.JWT_SECRET = 'gateway-test-secret';
  process.env.LOG_LEVEL = 'error';
  process.env.AUTH_RATE_LIMIT_MAX = '100000';
  delete process.env.REDIS_URL; // stratégie : SANS Redis
  const db = require(path.join(ROOT, 'config', 'firebase.js'));
  require(path.join(ROOT, 'server.js'));
  await sleep(1500);
  return db;
}
let _stubbed = false;
function stubCoreOnce() {
  if (_stubbed) return;
  _stubbed = true;
  require.cache[require.resolve(path.join(ROOT, 'config', 'firebase.js'))] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: makeDb() };
}

(async () => {
  const phase = process.argv[2];
  const out = {};

  /* ── Administration : register protégé par ADMIN_KEY ── */
  if (phase === 'admin-key') {
    process.env.ADMIN_KEY = 'adm-key-1';
    const db = await boot();
    out.registerNoHeader = (await req('5078', 'POST', '/api/gateway/register', { name: 'x' })).status;
    out.registerBadHeader = (await req('5078', 'POST', '/api/gateway/register', { name: 'x' }, { 'x-admin-key': 'nope' })).status;
    const ok = await req('5078', 'POST', '/api/gateway/register', { name: 'Z Fold2' }, { 'x-admin-key': 'adm-key-1' });
    out.registerOk = ok.status;
    out.hasToken = !!(ok.body && ok.body.token && ok.body.token.length === 64);
    out.hasDeviceId = !!(ok.body && String(ok.body.deviceId || '').startsWith('dev-'));
    const hash = db._store.get('gateway_devices').get(ok.body.deviceId);
    out.tokenHashed = !!(hash && hash.tokenHash && hash.tokenHash !== ok.body.token && hash.tokenHash.length === 64);
    out.tokenNotStoredPlain = !(JSON.stringify(hash) || '').includes(ok.body.token);
    const revoke = await req('5078', 'POST', `/api/gateway/devices/${ok.body.deviceId}/revoke`, {}, { 'x-admin-key': 'adm-key-1' });
    out.revokeOk = revoke.status === 200;
    const list = await req('5078', 'GET', '/api/gateway/devices', null, { 'x-admin-key': 'adm-key-1' });
    const dev = (list.body.devices || [])[0] || {};
    out.listNoHash = !JSON.stringify(list.body).includes('tokenHash');
    out.listStatusRevoked = dev.status === 'revoked';
    const stats = await req('5078', 'GET', '/api/gateway/outbox/stats', null, { 'x-admin-key': 'adm-key-1' });
    out.statsOk = stats.status === 200 && typeof (stats.body.outbox || {}).pending === 'number';
  }

  /* ── Auth appareil + flux complet claim/résultat ── */
  if (phase === 'flow') {
    const db = await boot();
    const mk = async (name) => (await req('5078', 'POST', '/api/gateway/register', { name })).body;
    const A = await mk('A');
    const B = await mk('B');
    out.claimNoAuth = (await req('5078', 'POST', '/api/gateway/claim', { limit: 5 })).status;
    out.claimBadToken = (await req('5078', 'POST', '/api/gateway/claim', { limit: 5 }, { 'x-gateway-device': A.deviceId, 'x-gateway-token': 'f'.repeat(64) })).status;
    // révocation de B (ADMIN_KEY non configurée ici → guard ouvert)
    await req('5078', 'POST', `/api/gateway/devices/${B.deviceId}/revoke`, {});
    const BH = { 'x-gateway-device': B.deviceId, 'x-gateway-token': B.token };
    out.revokedDeviceClaim = (await req('5078', 'POST', '/api/gateway/claim', { limit: 5 }, BH)).status;

    process.env.OFFLINE_SMS_PROVIDER = 'android_gateway';
    const agw = require(path.join(ROOT, 'services', 'androidGateway'));
    process.env.OFFLINE_SMS_PROVIDER = 'android_gateway';
    const s1 = await agw.sendSMS({ to: '+22670004001', text: 'Salut Awa', messageId: 'm-gw-1' });
    const s2 = await agw.sendSMS({ to: '+22670004002', text: 'Bonjour Issa', messageId: 'm-gw-2' });
    out.enqueueOk = s1.success && s2.success && s1.state === 'QUEUED_OUTBOX';
    await agw.sendSMS({ to: '+22670004001', text: 'Salut Awa', messageId: 'm-gw-1' }); // re-enqueue même id
    out.noDupOnReenqueue = db._store.get('sms_outbox').size === 2;

    const AH = { 'x-gateway-device': A.deviceId, 'x-gateway-token': A.token };
    const c1 = await req('5078', 'POST', '/api/gateway/claim', { limit: 10 }, AH);
    out.claimGot2 = c1.status === 200 && (c1.body.tasks || []).length === 2;
    out.taskFields = !!(c1.body.tasks && c1.body.tasks[0] && c1.body.tasks[0].messageId && c1.body.tasks[0].to && c1.body.tasks[0].text);
    const c2 = await req('5078', 'POST', '/api/gateway/claim', { limit: 10 }, AH);
    out.noDoubleClaim = c2.status === 200 && (c2.body.tasks || []).length === 0;

    const C = await mk('C');
    const CH = { 'x-gateway-device': C.deviceId, 'x-gateway-token': C.token };
    out.resultForeignDevice = (await req('5078', 'POST', '/api/gateway/result', { messageId: 'm-gw-1', success: true }, CH)).status;

    await db.collection('messages').doc('m-gw-1').set({ status: 'pending', smsStatus: 'QUEUED_OUTBOX' });
    const r1 = await req('5078', 'POST', '/api/gateway/result', { messageId: 'm-gw-1', success: true }, AH);
    const out1 = db._store.get('sms_outbox').get('m-gw-1');
    const msg1 = db._store.get('messages').get('m-gw-1');
    out.resultSentOk = r1.status === 200 && out1.status === 'sent';
    out.internalMessageSent = msg1.status === 'sent' && msg1.smsStatus === 'SENT' && msg1.smsProvider === 'android_gateway';
    const again = await req('5078', 'POST', '/api/gateway/result', { messageId: 'm-gw-1', success: true }, AH);
    out.resultIdempotent = again.status === 200 && !!again.body.already;
  }

  /* ── Échec → retries bornés → échec définitif ── */
  if (phase === 'retry') {
    const db = await boot();
    const A = (await req('5078', 'POST', '/api/gateway/register', { name: 'A' })).body;
    const AH = { 'x-gateway-device': A.deviceId, 'x-gateway-token': A.token };
    process.env.OFFLINE_SMS_PROVIDER = 'android_gateway';
    const agw = require(path.join(ROOT, 'services', 'androidGateway'));
    await agw.sendSMS({ to: '+22670004003', text: 'test retry', messageId: 'm-gw-3' });
    await db.collection('messages').doc('m-gw-3').set({ status: 'pending' });
    let attempts = 0;
    for (let i = 1; i <= 3; i++) {
      const c = await req('5078', 'POST', '/api/gateway/claim', { limit: 5 }, AH);
      const t = (c.body.tasks || []).find((x) => x.messageId === 'm-gw-3');
      if (!t) break;
      attempts = t.attempts;
      await req('5078', 'POST', '/api/gateway/result', { messageId: 'm-gw-3', success: false, error: 'SIM pleine' }, AH);
    }
    const final = db._store.get('sms_outbox').get('m-gw-3');
    const msg = db._store.get('messages').get('m-gw-3');
    out.attemptsIncremented = attempts === 3;
    out.failedPermanentAfter3 = final.status === 'failed';
    out.internalFailed = msg.status === 'failed' && msg.smsStatus === 'FAILED';
    const c = await req('5078', 'POST', '/api/gateway/claim', { limit: 5 }, AH);
    out.notReclaimedAfterFinal = !(c.body.tasks || []).some((x) => x.messageId === 'm-gw-3');
  }

  /* ── Tâche abandonnée (stale) → reprise automatique ── */
  if (phase === 'stale') {
    const db = await boot();
    const A = (await req('5078', 'POST', '/api/gateway/register', { name: 'A' })).body;
    const AH = { 'x-gateway-device': A.deviceId, 'x-gateway-token': A.token };
    process.env.OFFLINE_SMS_PROVIDER = 'android_gateway';
    const agw = require(path.join(ROOT, 'services', 'androidGateway'));
    await agw.sendSMS({ to: '+22670004004', text: 'stale', messageId: 'm-gw-4' });
    await req('5078', 'POST', '/api/gateway/claim', { limit: 5 }, AH);
    const doc = db._store.get('sms_outbox').get('m-gw-4');
    doc.claimedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // crashé il y a 30 min
    const c2 = await req('5078', 'POST', '/api/gateway/claim', { limit: 5 }, AH);
    const t = (c2.body.tasks || []).find((x) => x.messageId === 'm-gw-4');
    out.staleReclaimed = !!t;
    out.attemptsIncremented = !!t && t.attempts === 2;
  }

  /* ── Intégration transport : selectTransport + inline SANS Redis ── */
  if (phase === 'transport') {
    const db = await boot();
    const A = (await req('5078', 'POST', '/api/gateway/register', { name: 'A' })).body;
    fs.writeFileSync('/tmp/omnisms-gw-device.json', JSON.stringify({ headers: { 'x-gateway-device': A.deviceId, 'x-gateway-token': A.token } }));
    process.env.OFFLINE_SMS_PROVIDER = 'android_gateway';
    const { selectTransport, enqueueSmsJob } = require(path.join(ROOT, 'services', 'smsQueueWorker'));
    const t = selectTransport();
    out.transportSelected = !!t && t.provider === 'android_gateway';
    await db.collection('messages').doc('m-gw-6').set({ status: 'pending', channel: 'sms' });
    const r = await enqueueSmsJob({ to: '+22670004006', text: 'via inline', messageId: 'm-gw-6' });
    out.inlineEnqueueOk = !!r.jobId;
    await sleep(150);
    const doc = db._store.get('sms_outbox').get('m-gw-6');
    const msg = db._store.get('messages').get('m-gw-6');
    out.outboxWritten = !!(doc && doc.status === 'pending');
    out.messageHonestPending = !!(msg && msg.status === 'pending' && msg.smsStatus === 'QUEUED_OUTBOX');
    const dump = {};
    for (const [col, docs] of db._store) dump[col] = Object.fromEntries(docs);
    fs.writeFileSync('/tmp/omnisms-outbox-dump.json', JSON.stringify(dump));
  }

  /* ── Redémarrage : les tâches en attente survivent (nouveau process) ── */
  if (phase === 'restart') {
    const db = await boot();
    const A = JSON.parse(fs.readFileSync('/tmp/omnisms-gw-device.json', 'utf8'));
    const dump = JSON.parse(fs.readFileSync('/tmp/omnisms-outbox-dump.json', 'utf8'));
    for (const [col, docs] of Object.entries(dump)) {
      if (!db._store.has(col)) db._store.set(col, new Map());
      for (const [id, d] of Object.entries(docs)) db._store.get(col).set(id, d);
    }
    const c = await req('5078', 'POST', '/api/gateway/claim', { limit: 5 }, A.headers);
    out.taskSurvivedRestart = (c.body.tasks || []).some((x) => x.messageId === 'm-gw-6');
    out.resultAfterRestart = (await req('5078', 'POST', '/api/gateway/result', { messageId: 'm-gw-6', success: true }, A.headers)).status === 200;
  }

  console.log('RESULT ' + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error('PHASE ERROR', e.message); process.exit(1); });
