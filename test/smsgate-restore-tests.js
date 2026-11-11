'use strict';
/**
 * Tests — RESTAURATION du routage SMSGate + envoi hors ligne (mission v3).
 * Table de mission : en ligne / hors ligne / sans compte / numéro introuvable /
 * gateway déconnecté / gateway reconnecté / Redis indisponible / nouvelle tentative.
 * SMSGate simulé (HTTP local) — AUCUN SMS réel, AUCUN appel externe.
 */
process.env.LOG_LEVEL = 'error';
process.env.ROUTE_OFFLINE_HOLD = 'true';
delete process.env.REDIS_URL;
delete process.env.OFFLINE_SMS_PROVIDER;

const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ── Mock SMSGate HTTP local (mode contrôlable : global.__GW.mode) ── */
const MOCK = { posts: [] }; // chaque tentative (même 503) est enregistrée
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') { res.writeHead(404); return res.end('{}'); }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
      let b = {}; try { b = JSON.parse(body || '{}'); } catch (_) {}
      const entry = { to: (b.phoneNumbers || [])[0], text: typeof b.message === 'string' ? b.message : '', deviceId: b.deviceId };
      MOCK.posts.push(entry);
      if (global.__GW && global.__GW.mode === 'down') { res.writeHead(503); return res.end('{"error":"device unreachable"}'); }
      return res.writeHead(202, { 'Content-Type': 'application/json' }), res.end(JSON.stringify({ id: [`gw-${MOCK.posts.length}`] }));
    }
    if (req.method === 'GET' && /^\/3rdparty\/v1\/messages\//.test(req.url)) {
      if (global.__GW && global.__GW.mode === 'down') { res.writeHead(503); return res.end('{}'); }
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
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: makeDb() };
require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gw', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => true, isConfigured: () => false, sendSMS: async () => ({ success: false }), logStartupDiagnostic: () => {}, validateWebhookSignature: () => true } };

const presence = { online: new Set(['uid-online']) };
require.cache[path.join(ROOT, 'services', 'socketService.js')] = { id: 'sk', filename: path.join(ROOT, 'services/socketService.js'), loaded: true, exports: {
  isUserOnline: async (uid) => presence.online.has(uid), getIO: () => null, emitToUser: () => {}, deliverPendingMessages: async () => 0,
} };

/* Résolution UID → utilisateur (le téléphone vient TOUJOURS du profil) */
require.cache[path.join(ROOT, 'services', 'userResolver.js')] = { id: 'ur', filename: path.join(ROOT, 'services/userResolver.js'), loaded: true, exports: {
  resolveUserByPhone: async (phone) => ({ found: false }),
  resolveUserByUid: async (uid) => ({ found: true, uid }),
  normalizeEmail: (e) => String(e || '').toLowerCase(),
  // Miroir minimal des règles réelles de resolveVerifiedPhoneByUid (source de
  // vérité Firestore) : false explicite bloquant, legacy actif vérifié, E.164.
  resolveVerifiedPhoneByUid: async (uid) => {
    const dbi = require(path.join(ROOT, 'config', 'firebase.js'));
    const snap = await dbi.collection('users').doc(String(uid)).get();
    if (!snap || !snap.exists) return { found: false, reason: 'user_not_found' };
    const u = snap.data() || {};
    if (u.deleted === true) return { found: false, reason: 'user_not_found' };
    const raw = String(u.phone || u.phoneNumber || '').trim();
    if (!raw) return { found: false, reason: 'no_phone' };
    if (u.phoneVerified === false) return { found: false, reason: 'phone_unverified' };
    if (u.phoneVerified !== true && u.status && u.status !== 'active') return { found: false, reason: 'phone_unverified' };
    let ph = /^[+][1-9]\d{6,14}$/.test(raw) ? raw : null;
    if (!ph) { try { ph = require(path.join(ROOT, 'services', 'phoneNormalizer.js')).normalizePhone(raw) || null; } catch (_) {} }
    if (!ph) return { found: false, reason: 'invalid_phone' };
    return { found: true, phone: ph, source: u.phone ? 'firestore.phone' : 'firestore.phoneNumber', basis: u.phoneVerified === true ? 'otp_verified' : 'legacy_active', user: u };
  },
} };

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra ?? null).slice(0, 240)}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, '127.0.0.1', async () => {
  const PORT = server.address().port;
  process.env.SMS_GATEWAY_LOGIN = 'login-app';
  process.env.SMS_GATEWAY_PASSWORD = 'pass-app';
  process.env.SMS_GATEWAY_DEVICE_ID = 'zfold2';
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${PORT}`;
  global.__GW = { mode: 'ok' };

  const fs = require('fs');
  const db = require(path.join(ROOT, 'config', 'firebase.js'));
  const router = require(path.join(ROOT, 'services', 'messageRouter.js'));

  /* Comptes de test (profils users/{uid}) */
  const U = db._store.get('users') || db._store.get('users');
  const usersCol = (() => { db.collection('users').doc('seed').set({}); return null; })();
  const setU = (id, doc) => db.collection('users').doc(id).set(doc);
  await setU('uid-online',         { phone: '+22670000010', phoneVerified: true, status: 'active' });
  await setU('uid-legacy',         { phone: '+22670000011', status: 'active' });                       // SANS champ phoneVerified (legacy)
  await setU('uid-legacy-raw',     { phone: '70 12 34 56', status: 'active' });                        // numéro ancien format (local BF)
  await setU('uid-nophone',        { status: 'active' });                                              // numéro vérifié introuvable
  await setU('uid-explicitfalse',  { phone: '+22670000014', phoneVerified: false, status: 'active' }); // OTP non fait → JAMAIS de SMS
  await setU('uid-ok',             { phone: '+22670000015', phoneVerified: true, status: 'active' });  // gateway down/up
  await setU('uid-externe',        { phone: '+22670000016', phoneVerified: true, status: 'active' });  // destinataire sans compte (externe)

  const base = { senderUid: 'uid-sender', content: 'Bonjour du test', type: 'text', senderName: 'Ali', db };

  /* ── 0. Tags de logs demandés (source) ── */
  const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const mr = src('services/messageRouter.js'), fb = src('services/smsFallback.js'),
        gp = src('services/smsGateProvider.js'), ib = src('routes/sms.gateway.inbound.js');
  check('[ROUTING] Recipient online/offline + Verified phone resolved (tags source)', mr.includes('[ROUTING] Recipient online') && mr.includes('[ROUTING] Recipient offline') && fb.includes('[ROUTING] Verified phone resolved'));
  check('[SMSGATE] Sending/accepted/unavailable/failed/delivery confirmed (tags source)', gp.includes('[SMSGATE] Sending SMS') && gp.includes('[SMSGATE] SMS accepted') && gp.includes('[SMSGATE] Gateway unavailable') && gp.includes('[SMSGATE] SMS failed') && gp.includes('[SMSGATE] SMS delivery confirmed') && ib.includes('[SMSGATE] SMS delivery confirmed'));

  /* ── 1. Destinataire OmniSMS EN LIGNE → interne, AUCUN SMS externe ── */
  let r = await router.routeMessage({ ...base, targetUid: 'uid-online', messageId: 'm-online' });
  await sleep(200);
  check('en ligne → pas de hold, 0 POST SMSGate', !r.held && MOCK.posts.length === 0, { held: r.held, posts: MOCK.posts.length });

  /* ── 2. Destinataire OmniSMS HORS LIGNE (UID direct, compte LEGACY sans champ phoneVerified) → SMSGate ── */
  r = await router.routeMessage({ ...base, targetUid: 'uid-legacy', messageId: 'm-legacy' });
  await sleep(200);
  check('hors ligne (uid direct, legacy) → hold + SMSGate appelé', r.held === true && MOCK.posts.length === 1, { held: r.held, posts: MOCK.posts.length });
  check('numéro = profil vérifié (jamais l UID), E.164, Device ID', MOCK.posts[0] && MOCK.posts[0].to === '+22670000011' && MOCK.posts[0].deviceId === 'zfold2', MOCK.posts[0]);
  check('secours = sent (statut réel enregistré)', r.smsFallback && r.smsFallback.status === 'sent', r.smsFallback);

  /* ── 3. Hors ligne + numéro ancien format → normalisé puis envoyé ── */
  r = await router.routeMessage({ ...base, targetUid: 'uid-legacy-raw', messageId: 'm-raw' });
  await sleep(200);
  check('numéro legacy « 70 12 34 56 » normalisé E.164 → POST +22670123456', MOCK.posts.length === 2 && MOCK.posts[1].to === '+22670123456', MOCK.posts[1]);

  /* ── 4. Numéro vérifié introuvable → erreur explicite, aucun faux envoi ── */
  r = await router.routeMessage({ ...base, targetUid: 'uid-nophone', messageId: 'm-nophone' });
  check('numéro introuvable → skipped:no_valid_phone + message conservé + 0 POST', r.held === true && r.smsFallback.reason === 'no_valid_phone' && MOCK.posts.length === 2, r.smsFallback);

  /* ── 5. phoneVerified=false EXPLICITE (OTP en attente) → jamais de SMS ── */
  r = await router.routeMessage({ ...base, targetUid: 'uid-explicitfalse', messageId: 'm-explicitfalse' });
  check('phoneVerified=false explicite → phone_unverified, 0 POST', r.smsFallback.reason === 'phone_unverified' && MOCK.posts.length === 2, r.smsFallback);

  /* ── 6. Gateway DÉCONNECTÉ → tentative RÉELLE puis échec identifié ── */
  global.__GW.mode = 'down';
  r = await router.routeMessage({ ...base, targetUid: 'uid-ok', messageId: 'm-retry' });
  await sleep(200);
  check('gateway down → tentative réelle effectuée (POST tenté)', MOCK.posts.length === 3, { posts: MOCK.posts.length });
  check('gateway down → statut failed honnête (jamais « envoyé »)', r.held === true && r.smsFallback.status === 'failed', r.smsFallback);

  /* ── 7. Gateway RECONNECTÉ → nouvelle tentative qui aboutit ── */
  global.__GW.mode = 'ok';
  r = await router.routeMessage({ ...base, targetUid: 'uid-ok', messageId: 'm-retry' });
  await sleep(200);
  check('gateway revenu → re-route du MÊME message → sent (retry autorisé après échec)', r.smsFallback && r.smsFallback.status === 'sent' && MOCK.posts.length === 4, { s: r.smsFallback, posts: MOCK.posts.length });

  /* ── 8. Nouvelle tentative après SUCCÈS → aucun SMS en double ── */
  r = await router.routeMessage({ ...base, targetUid: 'uid-ok', messageId: 'm-retry' });
  await sleep(200);
  check('re-route après succès → already_handled, toujours 4 POST', r.smsFallback.reason === 'already_handled' && MOCK.posts.length === 4, { s: r.smsFallback, posts: MOCK.posts.length });

  /* ── 9. Destinataire SANS COMPTE (numéro fourni) → SMSGate direct ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22670000099', messageId: 'm-externe' });
  await sleep(200);
  check('sans compte → SMS_EXTERNE via SMSGate', r.route === 'SMS_EXTERNE' && MOCK.posts.length === 5 && MOCK.posts[4].to === '+22670000099', { route: r.route, posts: MOCK.posts.length });

  /* ── 10. Redis INDISPONIBLE → exécution inline RÉELLE (pas de perte silencieuse) ── */
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'queueService.js'))];
  const qs = require(path.join(ROOT, 'services', 'queueService.js'));
  let spyRan = 0;
  qs.registerInlineHandler('restore-q', async ({ data }) => { spyRan++; return { ok: true, got: data.x }; });
  const jr = await qs.addJob('restore-q', { x: 42 });
  check('Redis absent → handler inline réellement exécuté (résultat honnête)', jr.inline === true && jr.queued === false && spyRan === 1 && jr.result && jr.result.ok === true && jr.result.got === 42, jr);
  const jx = await qs.addJob('restore-unknown-q', { x: 1 });
  check('file sans handler → jobId null + erreur (jamais de faux succès)', jx.jobId === null && !!jx.error, jx);

  /* ── 11. Statut livré via checkStatus (DLR simulé) ── */
  const sgp = require(path.join(ROOT, 'services', 'smsGateProvider.js'));
  const st = await sgp.checkStatus('gw-3');
  check('checkStatus → delivered (confirmation distincte de l acceptation HTTP)', st && st.found === true && st.state === 'delivered', st);

  console.log(failures === 0 ? '\nRESTAURATION SMSGATE OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
});
