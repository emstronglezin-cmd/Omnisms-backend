'use strict';
/**
 * Tests — Notifications push distantes V3 : registre de tokens (endpoints),
 * dispatcher FCM (multicast, invalidation), préférences utilisateur.
 * FCM est SIMULÉ (fake messaging) — aucune notification réelle envoyée.
 */
process.env.LOG_LEVEL = 'error';
process.env.PORT = '5079';
process.env.JWT_SECRET = 'push-test-secret';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
const path = require('path');
const jwt = require('jsonwebtoken');
const http = require('http');
const ROOT = path.join(__dirname, '..');

/* ── Firestore simulé (device_tokens + users) ── */
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
  const q = (name, filter, n) => ({
    async get() {
      let e = [...colMap(name).entries()];
      if (filter) e = e.filter(([, d]) => d[filter.f] === filter.v);
      const docs = e.slice(0, n).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: docRef(name, id) }));
      return { docs, empty: !docs.length, size: docs.length };
    },
  });
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id || `auto-${++auto}`),
      where: (f, _op, v) => ({ limit: (n) => q(name, { f, v }, n) }),
      limit: (n) => q(name, null, n),
    }),
  };
}
const dbStub = makeDb();
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: dbStub };

/* ── FCM simulé (contrôlé par global.__FCM) ── */
global.__FCM = { calls: [], mode: 'ok' }; // mode: ok | invalid
const fakeMessaging = {
  async sendEachForMulticast(msg) {
    global.__FCM.calls.push({ tokens: msg.tokens, android: msg.android, notification: msg.notification, data: msg.data });
    if (global.__FCM.mode === 'invalid') {
      return {
        successCount: 0, failureCount: msg.tokens.length,
        responses: msg.tokens.map(() => ({ success: false, error: new Error('messaging/registration-token-not-registered') })),
      };
    }
    return {
      successCount: msg.tokens.length, failureCount: 0,
      responses: msg.tokens.map(() => ({ success: true, messageId: 'projects/fake/messages/x' })),
    };
  },
};
require.cache[path.join(ROOT, 'firebase-admin', 'index.js')] = { id: 'fba', filename: path.join(ROOT, 'firebase-admin/index.js'), loaded: true, exports: { _stub: false, apps: [{}], messaging: () => fakeMessaging, firestore: () => dbStub } };

require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gw', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => true, isConfigured: () => false, sendSMS: async () => ({ success: false }), logStartupDiagnostic: () => {}, validateWebhookSignature: () => true } };
require.cache[path.join(ROOT, 'services', 'queueService.js')] = { id: 'qs', filename: path.join(ROOT, 'services/queueService.js'), loaded: true, exports: { addJob: async () => ({}), addSmsJob: async () => ({}), addTranscriptionJob: async () => ({}), createWorker: () => null, getQueueStatus: () => ({ mode: 'inline-stub' }), registerInlineHandler: () => {} } };

const app = require(path.join(ROOT, 'server.js'));
void app;

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra).slice(0, 250)}`);
  if (!cond) failures++;
};
function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`http://127.0.0.1:5079${url}`, {
      method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); } catch (_) { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const TOKEN_A = 'fcm-token-appareil-A-0123456789abcdefABCDEF';
const TOKEN_B = 'fcm-token-appareil-B-fedcba9876543210FEDCBA';
const tok = (uid) => jwt.sign({ uid }, 'push-test-secret', { expiresIn: '30m' });
const hA = () => ({ Authorization: `Bearer ${tok('u-awa')}` });
const hB = () => ({ Authorization: `Bearer ${tok('u-issa')}` });

(async () => {
  await new Promise((r) => setTimeout(r, 1600));

  /* ── 1. Sécurité des endpoints ── */
  check('register sans auth → 401', (await req('POST', '/notifications/register', { token: TOKEN_A })).status === 401);
  check('devices sans auth → 401', (await req('GET', '/notifications/devices', null)).status === 401);
  check('register token trop court → 400', (await req('POST', '/notifications/register', { token: 'court' }, hA())).status === 400);
  check('register platform invalide → 400', (await req('POST', '/notifications/register', { token: TOKEN_A, platform: 'symbian' }, hA())).status === 400);

  /* ── 2. Enregistrement / rafraîchissement / ré-assignation ── */
  let r = await req('POST', '/notifications/register', { token: TOKEN_A, platform: 'android', deviceId: 'ZFold2' }, hA());
  check('register Android → 201 created', r.status === 201 && r.body.created === true, r.body);
  const docA = dbStub._store.get('device_tokens').get(require('crypto').createHash('sha256').update(TOKEN_A).digest('hex'));
  check('token stocké lié AU COMPTE authentifié (uid) + deviceId', docA && docA.uid === 'u-awa' && docA.deviceId === 'ZFold2', docA);
  r = await req('POST', '/notifications/register', { token: TOKEN_A, platform: 'android' }, hA());
  check('re-register (rafraîchissement) → created:false (upsert)', r.status === 201 && r.body.created === false, r.body);
  r = await req('POST', '/notifications/register', { token: TOKEN_B, platform: 'ios' }, hB());
  check('register iOS (APNs via FCM) → 201 platform ios', r.status === 201 && r.body.platform === 'ios', r.body);
  await req('POST', '/notifications/register', { token: TOKEN_B, platform: 'ios' }, hA()); // B ré-enregistré par Awa → ré-assignation
  const docB = dbStub._store.get('device_tokens').get(require('crypto').createHash('sha256').update(TOKEN_B).digest('hex'));
  check('token ré-enregistré par un AUTRE compte → ré-assigné (uid = nouveau compte)', docB && docB.uid === 'u-awa', docB && docB.uid);

  /* ── 3. Listing masqué ── */
  r = await req('GET', '/notifications/devices', null, hA());
  const dev = (r.body.devices || [])[0] || {};
  check('devices : liste de MES appareils, token MASQUÉ (jamais en clair)', r.status === 200 && (r.body.devices || []).length === 2 && !JSON.stringify(r.body).includes(TOKEN_A) && (dev.tokenMask || '').includes('…'), r.body);

  /* ── 4. Dispatcher FCM simulé ── */
  const push = require(path.join(ROOT, 'services', 'pushService'));
  let out = await push.sendPushToUser('u-awa', { title: 'OmniSMS', body: 'Salut !', data: { type: 'new_message', messageId: 'm1' } });
  check('push → multicast aux 2 appareils du compte', out.sent === 2 && global.__FCM.calls.length === 1 && global.__FCM.calls[0].tokens.length === 2, out);
  check('payload Android priorité haute', global.__FCM.calls[0].android && global.__FCM.calls[0].android.priority === 'high');
  out = await push.sendPushToUser('u-inconnu', { title: 'x' });
  check('compte sans appareil → skipped no_devices (pas d erreur)', out.skipped === 'no_devices', out);

  /* ── 5. Invalidation des tokens morts ── */
  global.__FCM.mode = 'invalid';
  out = await push.sendPushToUser('u-awa', { title: 'x' });
  global.__FCM.mode = 'ok';
  check('tokens rejetés par FCM → invalidation automatique (2 supprimés)', out.invalidRemoved === 2 && dbStub._store.get('device_tokens').size === 0, out);

  /* ── 6. Préférences (endpoints ORIGINAUX préservés) + respect par le push ── */
  await dbStub.collection('users').doc('u-awa').set({ name: 'Awa', notificationsEnabled: true });
  await req('POST', '/notifications/register', { token: TOKEN_A, platform: 'android' }, hA());
  r = await req('PUT', '/notifications/toggle', { notificationsEnabled: false }, hA());
  check('PUT /notifications/toggle (endpoint original) → 200', r.status === 200, r.status);
  out = await push.sendPushToUser('u-awa', { title: 'x' });
  check('notificationsEnabled=false → push DISTANT désactivé (skipped)', out.skipped === 'disabled_by_user', out);
  r = await req('GET', '/notifications/preferences', null, hA());
  check('GET /notifications/preferences (original) → 200', r.status === 200 && r.body.notificationsEnabled === false, r.body);

  /* ── 7. Unregister + isolation entre comptes ── */
  await req('PUT', '/notifications/toggle', { notificationsEnabled: true }, hA());
  r = await req('POST', '/notifications/unregister', { token: TOKEN_A }, hB()); // Issa essaie de supprimer le token d'Awa
  check('unregister du token d un AUTRE compte → 403', r.status === 403, r.status);
  r = await req('POST', '/notifications/unregister', { token: TOKEN_A }, hA());
  check('unregister par le PROPRIÉTAIRE → 200 removed:1', r.status === 200 && r.body.removed === 1, r.body);
  check('doc token supprimé', dbStub._store.get('device_tokens').size === 0);

  console.log(failures === 0 ? '\nTESTS NOTIFICATIONS PUSH OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
