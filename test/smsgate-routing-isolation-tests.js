'use strict';
/**
 * Test critique — ISOLATION DU ROUTAGE avec SMSGate ACTIVÉ (variables
 * Render du propriétaire : SMS_GATEWAY_*) :
 *   1. interne en ligne    → JAMAIS de SMSGate (Socket.IO seulement) ;
 *   2. interne hors ligne  → JAMAIS de SMSGate (attente interne) ;
 *   3. externe (sans compte) → SMSGate (INfiniReach jamais appelé).
 * Aucun SMS réel : serveur SMSGate simulé local.
 */
process.env.LOG_LEVEL = 'error';
process.env.ROUTE_OFFLINE_HOLD = 'true';
delete process.env.REDIS_URL; // sans Redis : inline (stratégie retenue)
delete process.env.OFFLINE_SMS_PROVIDER;

const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ── Serveur SMSGate simulé (compteur) ── */
const MOCK = { posts: 0, last: null };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') {
      res.writeHead(404); return res.end('{}'); // serveur sans JWT → repli Basic
    }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
      MOCK.posts++;
      let b = {}; try { b = JSON.parse(body || '{}'); } catch (_) {}
      MOCK.last = { to: (b.phoneNumbers || [])[0], text: typeof b.message === 'string' ? b.message : (b.textMessage || {}).text, deviceId: b.deviceId };
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: ['gw-iso-1'] }));
    }
    res.writeHead(404); res.end('{}');
  });
});

/* ── Stubs (même harnais que routing-offline-hold) ── */
function makeDb() {
  const store = new Map();
  let auto = 0;
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), ref: docRef(col, id) }; },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => { Object.assign(colMap(col).get(id) || {}, JSON.parse(JSON.stringify(data))); },
    delete: async () => colMap(col).delete(id),
  });
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id || `auto-${++auto}`),
      add: async (data) => { const id = `auto-${++auto}`; colMap(name).set(id, JSON.parse(JSON.stringify(data))); return { id, ref: docRef(name, id) }; },
      where(f1, _op, v1) {
        return {
          limit(n) { return { async get() {
            const docs = [...colMap(name).entries()].filter(([, d]) => d[f1] === v1).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: docRef(name, id) }));
            return { docs: docs.slice(0, n) };
          } }; },
          async get() { return { docs: [] }; },
        };
      },
    }),
  };
}
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: makeDb() };

const infini = { calls: [] };
require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gw', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: {
  isSmsGatewayProvider: () => true,
  isConfigured: () => true,
  sendSMS: async (opts) => { infini.calls.push(opts); return { success: true, gatewayMessageId: 'infini-1' }; },
  logStartupDiagnostic: () => {},
  validateWebhookSignature: () => true,
} };

const presence = { online: new Set(['uid-dest-online']) };
const emissions = [];
require.cache[path.join(ROOT, 'services', 'socketService.js')] = { id: 'sk', filename: path.join(ROOT, 'services/socketService.js'), loaded: true, exports: {
  isUserOnline: async (uid) => presence.online.has(uid),
  getIO: () => null,
  emitToUser: (uid, event, data) => emissions.push({ uid, event, data }),
  deliverPendingMessages: async () => 0,
} };
require.cache[path.join(ROOT, 'services', 'userResolver.js')] = { id: 'ur', filename: path.join(ROOT, 'services/userResolver.js'), loaded: true, exports: {
  resolveUserByPhone: async (phone) => phone === '+22670000001'
    ? { found: true, uid: 'uid-dest-online', phone, name: 'Dest Online' }
    : phone === '+22670000002'
      ? { found: true, uid: 'uid-dest-offline', phone, name: 'Dest Offline' }
      : { found: false },
  resolveUserByUid: async (uid) => ({ found: true, uid }),
  normalizeEmail: (e) => String(e || '').toLowerCase(),
} };

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra).slice(0, 220)}`);
  if (!cond) failures++;
};

server.listen(0, '127.0.0.1', async () => {
  const PORT = server.address().port;
  /* ── Les QUATRE variables Render exactes ── */
  process.env.SMS_GATEWAY_LOGIN = 'login-app';
  process.env.SMS_GATEWAY_PASSWORD = 'pass-app';
  process.env.SMS_GATEWAY_DEVICE_ID = 'device-app';
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${PORT}`;

  const router = require(path.join(ROOT, 'services', 'messageRouter.js'));
  const { startSmsWorker, selectTransport } = require(path.join(ROOT, 'services', 'smsQueueWorker.js'));
  const sp = require(path.join(ROOT, 'services', 'smsProvider.js'));

  check('statut : activeProvider = smsgate (4 variables reconnues)', sp.getProviderStatus().activeProvider === 'smsgate', sp.getProviderStatus());
  check('transport sélectionné = android… non : smsgate (stratégie SMS_GATEWAY)', selectTransport().provider === 'smsgate');

  startSmsWorker(); // sans Redis → handler inline (tâche exécutée immédiatement)
  await new Promise((r) => setTimeout(r, 100));

  const base = { senderUid: 'uid-sender', content: 'coucou', type: 'text', senderName: 'Awa', senderPhone: '+22670000099' };

  /* ── 1. Interne → connecté : JAMAIS SMSGate ── */
  let r = await router.routeMessage({ ...base, targetPhone: '+22670000001' });
  check('interne en ligne → route OMNISMS + message sent', r.route === 'OMNISMS' && (r.status === 'sent' || r.message.status === 'sent'), { route: r.route, status: r.status, msgStatus: r.message && r.message.status });
  check('interne en ligne → 0 POST SMSGate', MOCK.posts === 0, MOCK);
  check('interne en ligne → 0 appel INfiniReach', infini.calls.length === 0, infini);
  check('interne en ligne → message:receive émis (Socket.IO intact)', emissions.some((e) => e.event === 'message:receive'), emissions.length);

  /* ── 2. Interne → hors ligne : JAMAIS SMSGate (attente interne) ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22670000002' });
  check('interne hors ligne → held (attente interne)', r.held === true && r.status === 'pending', r);
  check('interne hors ligne → 0 POST SMSGate', MOCK.posts === 0, MOCK);
  check('interne hors ligne → 0 appel INfiniReach', infini.calls.length === 0, infini);

  /* ── 3. Externe (sans compte OmniSMS) → SMSGate, pas INfiniReach ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22677000099' });
  await new Promise((r2) => setTimeout(r2, 150)); // laisse l'inline s'exécuter
  check('externe → routage SMS_EXTERNE (envoi synchrone inline)', r.route === 'SMS_EXTERNE' && r.smsResult && r.smsResult.success === true, r);
  check('externe → 1 POST SMSGate avec numéro + Device ID', MOCK.posts === 1 && MOCK.last && MOCK.last.to === '+22677000099' && MOCK.last.deviceId === 'device-app', MOCK.last);
  check('externe → 0 appel INfiniReach (SMSGate prioritaire)', infini.calls.length === 0, infini);

  console.log(failures === 0 ? '\nISOLATION ROUTAGE SMSGATE OK' : `\n${failures} ÉCHEC(S)`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
});
