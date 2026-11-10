'use strict';
/**
 * Tests — Secours SMS consenti (cascade hors ligne) : opt-in destinataire,
 * numéro vérifié, anti-doublon, motif clair de non-secours, externe.
 * SMSGate simulé (0 SMS réel).
 */
process.env.LOG_LEVEL = 'error';
process.env.ROUTE_OFFLINE_HOLD = 'true';
delete process.env.REDIS_URL;
delete process.env.OFFLINE_SMS_PROVIDER;

const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const MOCK = { posts: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') { res.writeHead(404); return res.end('{}'); }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
      let b = {}; try { b = JSON.parse(body || '{}'); } catch (_) {}
      MOCK.posts.push({ to: (b.phoneNumbers || [])[0], text: typeof b.message === 'string' ? b.message : '', deviceId: b.deviceId });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: [`gw-fb-${MOCK.posts.length}`] }));
    }
    res.writeHead(404); res.end('{}');
  });
});

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
      where(f1, _op, v1) { return { limit(n) { return { async get() {
        const docs = [...colMap(name).entries()].filter(([, d]) => d[f1] === v1).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: docRef(name, id) }));
        return { docs: docs.slice(0, n) };
      } }; }, async get() { return { docs: [] }; } }; },
    }),
  };
}
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: makeDb() };
require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gw', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => true, isConfigured: () => false, sendSMS: async () => ({ success: false }), logStartupDiagnostic: () => {}, validateWebhookSignature: () => true } };
const presence = { online: new Set() };
require.cache[path.join(ROOT, 'services', 'socketService.js')] = { id: 'sk', filename: path.join(ROOT, 'services/socketService.js'), loaded: true, exports: {
  isUserOnline: async (uid) => presence.online.has(uid), getIO: () => null, emitToUser: () => {}, deliverPendingMessages: async () => 0,
} };
require.cache[path.join(ROOT, 'services', 'userResolver.js')] = { id: 'ur', filename: path.join(ROOT, 'services/userResolver.js'), loaded: true, exports: {
  resolveUserByPhone: async (phone) => ({ found: ['+22670000001', '+22670000002', '+22670000003'].includes(phone), uid: `uid-${phone.slice(-4)}`, phone }),
  resolveUserByUid: async (uid) => ({ found: true, uid }),
  normalizeEmail: (e) => String(e || '').toLowerCase(),
} };

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra).slice(0, 240)}`);
  if (!cond) failures++;
};

server.listen(0, '127.0.0.1', async () => {
  const PORT = server.address().port;
  process.env.SMS_GATEWAY_LOGIN = 'login-app';
  process.env.SMS_GATEWAY_PASSWORD = 'pass-app';
  process.env.SMS_GATEWAY_DEVICE_ID = 'zfold2';
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${PORT}`;

  const db = require(path.join(ROOT, 'config', 'firebase.js'));
  const router = require(path.join(ROOT, 'services', 'messageRouter.js'));
  const { startSmsWorker } = require(path.join(ROOT, 'services', 'smsQueueWorker.js'));
  startSmsWorker();
  await new Promise((r) => setTimeout(r, 80));

  /* Utilisateurs : consentements différents */
  await db.collection('users').doc('uid-0001').set({ phone: '+22670000001', phoneVerified: true, smsFallbackEnabled: true });  // consenti + vérifié
  await db.collection('users').doc('uid-0002').set({ phone: '+22670000002', phoneVerified: true, smsFallbackEnabled: false }); // PAS consenti
  await db.collection('users').doc('uid-0003').set({ phone: '+22670000003', phoneVerified: false, smsFallbackEnabled: true }); // consenti mais NON vérifié

  const base = { senderUid: 'uid-sender', content: 'Salut, appel-moi en revenant', type: 'text', senderName: 'Awa', senderPhone: '+22670000099' };

  /* ── 1. Hors ligne + consenti + vérifié → PUSH + secours SMSGate ── */
  let r = await router.routeMessage({ ...base, targetPhone: '+22670000001' });
  check('hors ligne + consenti → held:true', r.held === true, r);
  check('cascade : smsFallback.status = sent', r.smsFallback && r.smsFallback.status === 'sent', r.smsFallback);
  check('secours parti vers SMSGate (1 POST, Device ID zfold2)', MOCK.posts.length === 1 && MOCK.posts[0].deviceId === 'zfold2', MOCK.posts);
  check('SMS vers le numéro PERSISTÉ du destinataire (jamais l UID)', MOCK.posts[0] && MOCK.posts[0].to === '+22670000001', MOCK.posts[0]);
  check('texte : expéditeur nommé + contenu, ≤160 chars', MOCK.posts[0] && MOCK.posts[0].text.startsWith('OmniSMS — Awa : Salut') && MOCK.posts[0].text.length <= 160, MOCK.posts[0] && MOCK.posts[0].text);
  const msgDoc1 = [...db._store.get('messages').values()].find((d) => d.smsFallback);
  check('statut du secours persisté dans le message (traçabilité)', !!msgDoc1, msgDoc1);

  /* ── 2. Re-route du MÊME message (même messageId pré-généré) → 0 2e SMS ── */
  const savedId = r.messageId;
  // retrouver le messageId PRÉ-GÉNÉRÉ (clé logique) stocké dans la dédup
  r = await router.routeMessage({ ...base, targetPhone: '+22670000001', messageId: savedId });
  check('re-route du même message logique → 0 nouveau SMS', MOCK.posts.length === 1, MOCK.posts.length);
  check('motif honnête : already_handled', r.smsFallback && r.smsFallback.reason === 'already_handled', r.smsFallback);

  /* ── 3. Hors ligne SANS consentement → conservé + motif clair, 0 SMS ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22670000002' });
  check('sans consentement → held + skipped:no_recipient_consent', r.held === true && r.smsFallback.reason === 'no_recipient_consent', r.smsFallback);
  check('sans consentement → aucun POST supplémentaire', MOCK.posts.length === 1, MOCK.posts.length);

  /* ── 4. Consenti mais numéro NON vérifié → pas de SMS ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22670000003' });
  check('non vérifié → skipped:phone_unverified', r.smsFallback.reason === 'phone_unverified', r.smsFallback);
  check('non vérifié → aucun POST supplémentaire', MOCK.posts.length === 1, MOCK.posts.length);

  /* ── 5. Interrupteur global → aucun secours même consenti ── */
  process.env.SMS_FALLBACK_ENABLED = 'false';
  r = await router.routeMessage({ ...base, targetPhone: '+22670000001', messageId: `m-glob-${Date.now()}` });
  process.env.SMS_FALLBACK_ENABLED = 'true';
  check('SMS_FALLBACK_ENABLED=false → skipped:disabled_globally', r.smsFallback.reason === 'disabled_globally', r.smsFallback);
  check('interrupteur global → aucun POST supplémentaire', MOCK.posts.length === 1, MOCK.posts.length);

  /* ── 6. Externe → SMS direct (mécanisme existant, inchangé) ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22677000077' });
  await new Promise((r2) => setTimeout(r2, 120));
  check('externe → SMS_EXTERNE', r.route === 'SMS_EXTERNE', r.route);
  check('externe → POST SMSGate additionnel (2e au total)', MOCK.posts.length === 2, MOCK.posts.length);

  /* ── 7. Consentement réglable via PUT /me/profile ── */
  // (vérification directe du service : lecture du champ par le fallback)
  await db.collection('users').doc('uid-0002').set({ phone: '+22670000002', phoneVerified: true, smsFallbackEnabled: true }, { merge: true });
  r = await router.routeMessage({ ...base, targetPhone: '+22670000002', messageId: `m-consent-${Date.now()}` });
  check('consentement activé → secours parti (3e POST)', r.smsFallback.status === 'sent' && MOCK.posts.length === 3, { r: r.smsFallback, n: MOCK.posts.length });

  console.log(failures === 0 ? '\nCASCADE SECOURS SMS OK' : `\n${failures} ÉCHEC(S)`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
});
