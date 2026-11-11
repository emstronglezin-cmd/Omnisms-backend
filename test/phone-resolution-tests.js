'use strict';
/**
 * Tests — Résolution CENTRALE du numéro vérifié + secours SMSGate (mission v5).
 * Cause prod : comptes pré-OTP sans champ phoneVerified (et parfois sans
 * status) → phone_unverified silencieux. Le résolveur central applique le
 * mécanisme EXISTANT : true/phoneVerifiedAt/legacy-actif vérifiés, false
 * explicite TOUJOURS bloquant. Tout est simulé (SMSGate HTTP local) — AUCUN
 * SMS réel.
 */
process.env.LOG_LEVEL = 'error';
process.env.ROUTE_OFFLINE_HOLD = 'true';
delete process.env.REDIS_URL;
delete process.env.OFFLINE_SMS_PROVIDER;

const http = require('http');
const path = require('path');
const express = require('express');
const ROOT = path.join(__dirname, '..');

const MOCK = { posts: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') { res.writeHead(404); return res.end('{}'); }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
      let b = {}; try { b = JSON.parse(body || '{}'); } catch (_) {}
      MOCK.posts.push({ to: (b.phoneNumbers || [])[0], text: typeof b.message === 'string' ? b.message : '' });
      if (global.__GW && global.__GW.mode === 'down') { res.writeHead(503); return res.end('{"error":"device unreachable"}'); }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: [`gw-pr-${MOCK.posts.length}`] }));
    }
    if (req.method === 'GET' && /^\/3rdparty\/v1\/messages\//.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ state: 'delivered' }));
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

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra ?? null).slice(0, 240)}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Injection Firestore mémoire AVANT tout require de config/firebase */
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: makeDb() };

server.listen(0, '127.0.0.1', async () => {
  const PORT = server.address().port;
  process.env.SMS_GATEWAY_LOGIN = 'login-app';
  process.env.SMS_GATEWAY_PASSWORD = 'pass-app';
  process.env.SMS_GATEWAY_DEVICE_ID = 'zfold2';
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${PORT}`;
  global.__GW = { mode: 'ok' };

  const db = require(path.join(ROOT, 'config', 'firebase.js'));

  /* ══ 1. Résolveur central — unités (source de vérité Firestore) ══ */
  const seed = {
    'u-verified':   { phone: '+22670000001', phoneVerified: true, status: 'active' },
    'u-otp-at':     { phone: '+22670000002', phoneVerifiedAt: '2026-01-01T00:00:00Z' },             // preuve OTP, champ perdu
    'u-unverified': { phone: '+22670000003', phoneVerified: false, status: 'pending_verification' }, // OTP en attente → BLOQUÉ
    'u-legacy':     { phone: '+22670000004' },                                                       // PRE-OTP : ni phoneVerified ni status
    'u-pending':    { phone: '+22670000005', status: 'pending_verification', verificationRequired: true },
    'u-flagoff':    { phone: '+22670000006', verificationRequired: false },                          // inscription flag OFF
    'u-rawphone':   { phone: '70 12 34 56' },                                                        // ancien format local
    'u-alias':      { phoneNumber: '+22670000007' },                                                 // alias défensif
    'u-nophone':    { status: 'active' },
    'u-deleted':    { phone: '+22670000008', deleted: true },
  };
  for (const [id, doc] of Object.entries(seed)) await db.collection('users').doc(id).set(doc);

  const { resolveVerifiedPhoneByUid } = require(path.join(ROOT, 'services', 'userResolver.js'));
  let r = await resolveVerifiedPhoneByUid('u-verified');
  check('résolveur : phoneVerified=true → vérifié (otp_verified)', r.found && r.basis === 'otp_verified' && r.phone === '+22670000001', r);
  r = await resolveVerifiedPhoneByUid('u-otp-at');
  check('résolveur : phoneVerifiedAt seul → vérifié (preuve OTP)', r.found && r.basis === 'otp_verified_at', r);
  r = await resolveVerifiedPhoneByUid('u-unverified');
  check('résolveur : phoneVerified=false explicite → phone_unverified (JAMAIS contourné)', !r.found && r.reason === 'phone_unverified', r);
  r = await resolveVerifiedPhoneByUid('u-legacy');
  check('résolveur : compte pré-OTP (ni phoneVerified ni status) → vérifié (legacy_active) — CORRECTIF PROD', r.found && r.basis === 'legacy_active' && r.phone === '+22670000004', r);
  r = await resolveVerifiedPhoneByUid('u-pending');
  check('résolveur : status=pending_verification → bloqué', !r.found && r.reason === 'phone_unverified', r);
  r = await resolveVerifiedPhoneByUid('u-flagoff');
  check('résolveur : verificationRequired=false (flag OFF) → vérifié', r.found && r.basis === 'legacy_active', r);
  r = await resolveVerifiedPhoneByUid('u-rawphone');
  check('résolveur : « 70 12 34 56 » → E.164 +22670123456', r.found && r.phone === '+22670123456', r);
  r = await resolveVerifiedPhoneByUid('u-alias');
  check('résolveur : alias phoneNumber → trouvé (source firestore.phoneNumber)', r.found && r.source === 'firestore.phoneNumber' && r.phone === '+22670000007', r);
  r = await resolveVerifiedPhoneByUid('u-nophone');
  check('résolveur : sans numéro → no_phone (jamais l UID)', !r.found && r.reason === 'no_phone', r);
  r = await resolveVerifiedPhoneByUid('u-deleted');
  check('résolveur : compte supprimé → user_not_found', !r.found && r.reason === 'user_not_found', r);

  /* ══ 2. Routage complet — mocks présence/résolution/smsGateway legacy ══ */
  require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gws', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => false, isConfigured: () => false, sendSMS: async () => ({ success: false }), logStartupDiagnostic: () => {}, validateWebhookSignature: () => true } };
  const presence = { online: new Set(['u-online']) };
  require.cache[path.join(ROOT, 'services', 'socketService.js')] = { id: 'sk', filename: path.join(ROOT, 'services/socketService.js'), loaded: true, exports: {
    isUserOnline: async (uid) => presence.online.has(uid), getIO: () => null, emitToUser: () => {}, deliverPendingMessages: async () => 0,
  } };
  const db2 = db;
  await db2.collection('users').doc('u-online').set({ phone: '+22670000010', phoneVerified: true, status: 'active' });
  await db2.collection('users').doc('u-ext-ok').set({ phone: '+22670000015', phoneVerified: true, status: 'active' });
  const router = require(path.join(ROOT, 'services', 'messageRouter.js'));
  const base = { senderUid: 'u-sender', content: 'Mission v5', type: 'text', senderName: 'Ali', db: db2 };

  /* 1. Destinataire EN LIGNE → interne, aucun SMS */
  r = await router.routeMessage({ ...base, targetUid: 'u-online', messageId: 'm-online' });
  check('scénario 1 : en ligne → interne, 0 POST', !r.held && MOCK.posts.length === 0, { held: r.held, posts: MOCK.posts.length });

  /* 2. Hors ligne + numéro vérifié → POST SMSGate (PREUVE) */
  r = await router.routeMessage({ ...base, targetUid: 'u-verified', messageId: 'm-verified' });
  await sleep(200);
  check('scénario 2 : hors ligne vérifié → SMSGate APPELÉ (preuve POST)', r.held === true && r.smsFallback.status === 'sent' && MOCK.posts.length === 1 && MOCK.posts[0].to === '+22670000001', { s: r.smsFallback, post: MOCK.posts[0] });
  check('scénario 2 : message conservé dans l historique', r.message && r.message.status === 'pending' && r.messageId, { id: r.messageId });

  /* 3. Hors ligne SANS numéro → statut explicite, conservé, 0 POST */
  r = await router.routeMessage({ ...base, targetUid: 'u-nophone', messageId: 'm-nophone' });
  check('scénario 3 : hors ligne sans numéro → no_valid_phone + conservé + 0 POST', r.held === true && r.smsFallback.reason === 'no_valid_phone' && MOCK.posts.length === 1, r.smsFallback);

  /* 4. Numéro NON vérifié (false explicite) → phone_unverified, 0 POST */
  r = await router.routeMessage({ ...base, targetUid: 'u-unverified', messageId: 'm-unverified' });
  check('scénario 4 : non vérifié (false) → phone_unverified + 0 POST', r.smsFallback.reason === 'phone_unverified' && MOCK.posts.length === 1, r.smsFallback);

  /* 5. Sans compte OmniSMS → SMSGate direct */
  r = await router.routeMessage({ ...base, targetPhone: '+22670000099', messageId: 'm-externe' });
  await sleep(200);
  check('scénario 5 : sans compte → SMS_EXTERNE via SMSGate', r.route === 'SMS_EXTERNE' && MOCK.posts.length === 2 && MOCK.posts[1].to === '+22670000099', { route: r.route, post: MOCK.posts[1] });

  /* 6. SMSGate indisponible → échec honnête, jamais « envoyé » */
  global.__GW.mode = 'down';
  r = await router.routeMessage({ ...base, targetUid: 'u-ext-ok', messageId: 'm-down' });
  await sleep(200);
  check('scénario 6 : gateway down → tentative réelle + failed honnête', MOCK.posts.length === 3 && r.smsFallback.status === 'failed', { posts: MOCK.posts.length, s: r.smsFallback });

  /* 7. Échec puis nouvelle tentative → succès */
  global.__GW.mode = 'ok';
  r = await router.routeMessage({ ...base, targetUid: 'u-ext-ok', messageId: 'm-down' });
  await sleep(200);
  check('scénario 7 : retry après échec → sent', r.smsFallback.status === 'sent' && MOCK.posts.length === 4, { s: r.smsFallback, posts: MOCK.posts.length });

  /* 9. Absence de double envoi */
  r = await router.routeMessage({ ...base, targetUid: 'u-ext-ok', messageId: 'm-down' });
  check('scénario 9 : re-route après succès → already_handled, toujours 4 POST', r.smsFallback.reason === 'already_handled' && MOCK.posts.length === 4, { s: r.smsFallback, posts: MOCK.posts.length });

  /* 10. Statut réel de livraison (accepted ≠ delivered) */
  const sgp = require(path.join(ROOT, 'services', 'smsGateProvider.js'));
  const st = await sgp.checkStatus('gw-pr-1');
  check('scénario 10 : checkStatus → delivered (statut réel distinct de l acceptation)', st.found === true && st.state === 'delivered', st);

  /* 8. Redis indisponible → inline réellement exécuté */
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'queueService.js'))];
  const qs = require(path.join(ROOT, 'services', 'queueService.js'));
  let ran = 0;
  qs.registerInlineHandler('pr-q', async () => { ran++; return { ok: true }; });
  const jr = await qs.addJob('pr-q', {});
  check('scénario 8 : Redis absent → inline RÉELLEMENT exécuté', jr.inline === true && ran === 1 && jr.result && jr.result.ok === true, jr);

  /* ══ 3. Route /send → appelle SMSGate si destinataire hors ligne (preuve) ══ */
  require.cache[path.join(ROOT, 'middleware', 'authenticate.js')] = { id: 'au', filename: path.join(ROOT, 'middleware/authenticate.js'), loaded: true, exports: (req, _res, next) => { req.user = { uid: 'u-sender', name: 'Ali' }; next(); } };
  const messagesRouter = require(path.join(ROOT, 'routes', 'messages.js'));
  const app = express();
  app.use(express.json());
  app.use(messagesRouter);
  const httpServer = http.createServer(app);
  await new Promise((res) => httpServer.listen(0, '127.0.0.1', res));
  const apiPort = httpServer.address().port;
  const resp = await fetch(`http://127.0.0.1:${apiPort}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receiverId: 'u-verified', content: 'Via /send hors ligne', type: 'text' }),
  });
  const body = await resp.json();
  await sleep(400);
  check('/send : 201 + message sauvegardé', resp.status === 201 && body.data && body.data.id, { status: resp.status, body });
  check('/send : destinataire hors ligne → SMSGate déclenché (preuve POST)', MOCK.posts.some((p) => p.to === '+22670000001' && p.text.includes('Via /send hors ligne')), { posts: MOCK.posts });
  httpServer.close();

  console.log(failures === 0 ? '\nPHONE RESOLUTION + SMS FALLBACK OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
});
