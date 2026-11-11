'use strict';
/**
 * Tests — Mission v6 : SaaSPay (webhook GET/POST, Premium authentifié) +
 * SMSGate (auto-réparation 401, anti-boucle numéro passerelle).
 * Tout est simulé (HTTP local) — AUCUN paiement réel, AUCUN SMS réel.
 */
process.env.LOG_LEVEL = 'error';
process.env.ROUTE_OFFLINE_HOLD = 'true';
delete process.env.REDIS_URL;
delete process.env.OFFLINE_SMS_PROVIDER;

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra ?? null).slice(0, 260)}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ══ Mock API SasPay (confirmations serveur) ══ */
const SASPAY = { checkouts: {} }; // id → {status, amount, currency}
const saspayServer = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    const m = req.url.match(/^\/api\/v1\/checkout-sessions\/([^/]+)\/?$/);
    if (req.method === 'POST' && /^\/api\/v1\/checkout-sessions\/?$/.test(req.url)) {
      let b = '{}'; req.on('data', () => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'ck-new', checkout_url: 'https://pay.saspay.test/ck-new', status: 'pending', amount: 2000, currency: 'XOF' }));
    }
    if (req.method === 'GET' && m) {
      const co = SASPAY.checkouts[decodeURIComponent(m[1])] || { status: 'pending', amount: 0, currency: 'XOF' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(co));
    }
    res.writeHead(404); res.end('{}');
  });
});

/* ══ Mock SMSGate : JWT refusé (2 premières tentatives) ; Basic TOUJOURS refusé ══ */
const GW = { bearer: 0, basic: 0, posts: [] };
const gwServer = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    const auth = String(req.headers.authorization || '');
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'jwt-' + GW.bearer, refresh_token: 'r', expires_at: new Date(Date.now() + 3600e3).toISOString() }));
    }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
      let j = {}; try { j = JSON.parse(b || '{}'); } catch (_) {}
      GW.posts.push({ to: (j.phoneNumbers || [])[0], auth: auth.startsWith('Basic') ? 'basic' : 'bearer' });
      if (auth.startsWith('Basic ')) { GW.basic++; res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      GW.bearer++;
      if (GW.bearer <= 2) { res.writeHead(401); return res.end('{"error":"invalid token"}'); }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: [`gw-v6-${GW.bearer}`] }));
    }
    res.writeHead(404); res.end('{}');
  });
});

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
  /* ════════ 1. SAASPAY ════════ */
  const saspayPort = await listen(saspayServer);
  process.env.SAASPAY_BASE_URL = `http://127.0.0.1:${saspayPort}`;
  process.env.SAASPAY_SECRET_KEY = 'sk_test_dummy';
  process.env.SAASPAY_WEBHOOK_SECRET = 'whsec-test';
  process.env.LEEKPAY_PREMIUM_AMOUNT = '2000';
  process.env.LEEKPAY_PREMIUM_CURRENCY = 'XOF';

  const db = makeDb();
  require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: db };
  for (const u of ['u-a', 'u-b', 'u-c', 'u-d']) await db.collection('users').doc(u).set({ phone: '+2267000000' + u.length, isSubscribed: false });

  const paymentRouter = require(path.join(ROOT, 'routes', 'payment.saaspay.js'));
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use('/api/payment', paymentRouter);
  const apiServer = http.createServer(app);
  const apiPort = await listen(apiServer);
  const post = (p, bodyObj, headers = {}) => fetch(`http://127.0.0.1:${apiPort}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(bodyObj),
  });
  const get = (p) => fetch(`http://127.0.0.1:${apiPort}${p}`);

  /* 1.a GET webhook → 200 vérification (fini le 404), aucun effet */
  const g1 = await get('/api/payment/webhook/saaspay');
  const g1b = await g1.json();
  check('SaaSPay : GET /webhook/saaspay → 200 (vérification URL, plus de 404)', g1.status === 200 && g1b.webhook === 'active' && g1b.method === 'POST', { status: g1.status, body: g1b });
  check('SaaSPay : GET ne débloque RIEN (aucun premium, aucun doc)', ![...db._store.get('users')?.values() || []].some((d) => d.isSubscribed === true) && !db._store.get('leekpay_payments'), 'no state');

  /* 1.b POST SIGNÉ paid → Premium activé ; replay → idempotent */
  const payloadA = { event: 'payment.completed', data: { status: 'paid', checkout_id: 'ck-signed', transaction_id: 'tx-1', amount: 2000, currency: 'XOF', metadata: { userId: 'u-a' } } };
  const rawA = JSON.stringify(payloadA);
  const sig = crypto.createHmac('sha256', 'whsec-test').update(rawA).digest('hex');
  const p1 = await post('/api/payment/webhook/saaspay', payloadA, { 'x-saaspay-signature': sig, 'x-saaspay-event': 'payment.completed' });
  await sleep(500);
  const ua = (await db.collection('users').doc('u-a').get()).data();
  const subsCount1 = db._store.get('subscriptions') ? db._store.get('subscriptions').size : 0;
  check('SaaSPay : POST signé paid → 200 reçu', p1.status === 200, p1.status);
  check('SaaSPay : Premium activé sur confirmation AUTHENTIFIÉE (signature)', ua && ua.isSubscribed === true && ua.premium === true, ua);
  const p1r = await post('/api/payment/webhook/saaspay', payloadA, { 'x-saaspay-signature': sig, 'x-saaspay-event': 'payment.completed' });
  await sleep(400);
  const subsCount2 = db._store.get('subscriptions') ? db._store.get('subscriptions').size : 0;
  check('SaaSPay : replay webhook → idempotent (toujours 1 activation)', p1r.status === 200 && subsCount1 === 1 && subsCount2 === 1, { subsCount1, subsCount2 });

  /* 1.c POST non signé + fournisseur « pending » → RIEN débloqué */
  SASPAY.checkouts['ck-pending'] = { status: 'pending', amount: 2000, currency: 'XOF' };
  const p2 = await post('/api/payment/webhook/saaspay', { event: 'payment.completed', data: { status: 'paid', checkout_id: 'ck-pending', amount: 2000, currency: 'XOF', metadata: { userId: 'u-c' } } });
  await sleep(500);
  const uc = (await db.collection('users').doc('u-c').get()).data();
  check('SaaSPay : non signé + fournisseur PAS payé → aucun Premium (jamais sur simple payload)', p2.status === 200 && uc.isSubscribed !== true, uc);

  /* 1.d POST non signé + fournisseur PAYÉ (confirmation serveur authentifiée) → Premium */
  SASPAY.checkouts['ck-paid'] = { status: 'paid', amount: 2000, currency: 'XOF' };
  const p3 = await post('/api/payment/webhook/saaspay', { event: 'payment.completed', data: { status: 'paid', checkout_id: 'ck-paid', amount: 2000, currency: 'XOF', metadata: { userId: 'u-b' } } });
  await sleep(500);
  const ub = (await db.collection('users').doc('u-b').get()).data();
  check('SaaSPay : non signé + CONFIRMATION FOURNISSEUR payée → Premium activé', p3.status === 200 && ub.isSubscribed === true, ub);

  /* 1.e Création de transaction (API officielle, Bearer secret) */
  const saaspay = require(path.join(ROOT, 'services', 'saaspay.js'));
  const co = await saaspay.createCheckout({ amount: 2000, currency: 'XOF', metadata: { userId: 'u-a' } });
  check('SaaSPay : création de transaction → checkout_id + checkout_url', co && (co.checkoutId === 'ck-new' || co.id === 'ck-new') && !!(co.checkoutUrl || co.checkout_url || co.paymentUrl), co);

  /* 1.f Fournisseur NON configuré → aucune activation possible */
  delete process.env.SAASPAY_SECRET_KEY;
  const p4 = await post('/api/payment/webhook/saaspay', { event: 'payment.completed', data: { status: 'paid', checkout_id: 'ck-nc', amount: 2000, currency: 'XOF', metadata: { userId: 'u-d' } } });
  await sleep(500);
  const ud = (await db.collection('users').doc('u-d').get()).data();
  check('SaaSPay : fournisseur non configuré → aucune activation (échec fermé)', p4.status === 200 && ud.isSubscribed !== true, ud);
  process.env.SAASPAY_SECRET_KEY = 'sk_test_dummy';

  /* ════════ 2. SMSGATE ════════ */
  const gwPort = await listen(gwServer);
  process.env.SMS_GATEWAY_LOGIN = 'login-app';
  process.env.SMS_GATEWAY_PASSWORD = 'pass-app';
  process.env.SMS_GATEWAY_DEVICE_ID = 'zfold2';
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${gwPort}`;
  process.env.SMS_GATEWAY_DEVICE_NUMBER = '+22675405214'; // SIM passerelle
  process.env.SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE = '';

  const gw = require(path.join(ROOT, 'services', 'smsGateProvider.js'));
  const r1 = await gw.sendSMS({ to: '+22670000001', text: 'v6 envoi 1', messageId: 'm-v6-1' });
  check('SMSGate : JWT et Basic refusés → échec HONNÊTE 401 (jamais « envoyé »)', r1.success === false && r1.statusCode === 401 && r1.error.startsWith('AUTH_REJECTED'), r1);
  check('SMSGate : diagnostic serveur dans l erreur (host seul, sans secret)', /SMSGate « 127\.0\.0\.1:\d+ »/.test(String(r1.error)), r1.error);
  const r2 = await gw.sendSMS({ to: '+22670000002', text: 'v6 envoi 2 (auto-réparation)', messageId: 'm-v6-2' });
  check('SMSGate : auto-réparation → JWT accepté au re-tentage → SMS accepté', r2.success === true && r2.statusCode === 202, r2);
  check('SMSGate : preuve des tentatives (2 Basic + 2 JWT refusés puis JWT accepté)', GW.basic === 2 && GW.bearer === 3, { GW });

  /* ════════ 3. ROUTAGE (préservé) + anti-boucle ════════ */
  require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gws', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => false, isConfigured: () => false, sendSMS: async () => ({ success: false }), logStartupDiagnostic: () => {}, validateWebhookSignature: () => true } };
  require.cache[path.join(ROOT, 'services', 'socketService.js')] = { id: 'sk', filename: path.join(ROOT, 'services/socketService.js'), loaded: true, exports: {
    isUserOnline: async () => false, getIO: () => null, emitToUser: () => {}, deliverPendingMessages: async () => 0,
  } };
  // userResolver RÉEL (lecture du Firestore mock) — résolution centrale v5
  const router = require(path.join(ROOT, 'services', 'messageRouter.js'));
  const base = { senderUid: 'u-sender', content: 'Mission v6', type: 'text', senderName: 'Ali', db };

  const postsBefore = GW.posts.length;
  // (a) externe SANS compte vers la SIM passerelle → garde texte (anti-boucle)
  let r = await router.routeMessage({ ...base, targetPhone: '+22675405214', messageId: 'm-gw-ext' });
  check('routage : externe (sans compte) vers la SIM passerelle → SMS annulé (anti-boucle texte), message failed', r.route === 'SMS_EXTERNE' && r.smsResult && r.smsResult.error === 'GATEWAY_NUMBER' && GW.posts.length === postsBefore, { r: { route: r.route, sms: r.smsResult }, posts: GW.posts.length });

  // (b) titulaire d un compte dont le numéro = SIM passerelle, offline → hold + secours annulé
  await db.collection('users').doc('u-gwowner').set({ phone: '+22675405214', status: 'active' });
  r = await router.routeMessage({ ...base, targetUid: 'u-gwowner', messageId: 'm-gw-own' });
  check('routage : destinataire = numéro passerelle (offline) → hold + secours annulé (anti-boucle)', r.held === true && r.smsFallback.reason === 'gateway_number' && GW.posts.length === postsBefore, { s: r.smsFallback, posts: GW.posts.length });

  // Hors ligne classique → SMSGate (le routage est préservé)
  await db.collection('users').doc('u-off').set({ phone: '+22670000077', status: 'active' });
  r = await router.routeMessage({ ...base, targetUid: 'u-off', messageId: 'm-off-v6' });
  await sleep(300);
  check('routage : hors ligne + numéro vérifié → SMSGate appelé (préservé)', r.held === true && ['sent', 'failed'].includes(r.smsFallback.status) && GW.posts.length === postsBefore + 1, { s: r.smsFallback, posts: GW.posts.length });
  check('routage : échec auth → message CONSERVÉ (pending, pas de perte)', r.message && r.message.status === 'pending', { st: r.message && r.message.status });

  apiServer.close(); gwServer.close(); saspayServer.close();
  console.log(failures === 0 ? '\nMISSION V6 OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATALE:', e); process.exit(1); });
