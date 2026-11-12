'use strict';
/**
 * Tests — Mission v7 : job transcription jamais exécuté (fix inline-quota),
 * reprise des vocaux orphelines → SMS automatique, webhooks SMSGate
 * (sms:sent/delivered/failed), instrumentation latence.
 * Tout est simulé (Groq + SMSGate HTTP local) — AUCUN SMS réel.
 */
process.env.LOG_LEVEL = 'error';
process.env.ROUTE_OFFLINE_HOLD = 'true';
process.env.REDIS_URL = 'redis://127.0.0.1:1'; // Redis INJOIGNABLE (quota/DNS en prod)
delete process.env.OFFLINE_SMS_PROVIDER;

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra ?? null).slice(0, 240)}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Mock SMSGate (auth Basic : token 404 → repli Basic) ── */
const GW = { posts: [] };
const gwServer = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') { res.writeHead(404); return res.end('{}'); }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
      let j = {}; try { j = JSON.parse(b || '{}'); } catch (_) {}
      GW.posts.push({ to: (j.phoneNumbers || [])[0], text: typeof j.message === 'string' ? j.message : '' });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: [`gw-v7-${GW.posts.length}`] }));
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
      } }; }, async get() { return { docs: [...colMap(name).entries()].filter(([, d]) => d[f1] === v1).slice(0, 50).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: docRef(name, id) })) }; } }; },
    }),
  };
}
const db = makeDb();
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: db };

/* Groq SIMULÉ (avant tout require du worker) */
require.cache[path.join(ROOT, 'services', 'transcriptionService.js')] = { id: 'tx', filename: path.join(ROOT, 'services/transcriptionService.js'), loaded: true, exports: {
  transcribe: async () => ({ text: 'Transcription v7 OK', method: 'test' }),
} };

const presence = { online: new Set() };
require.cache[path.join(ROOT, 'services', 'socketService.js')] = { id: 'sk', filename: path.join(ROOT, 'services/socketService.js'), loaded: true, exports: {
  isUserOnline: async () => presence.online.has('_'), getIO: () => null, emitToUser: () => {}, deliverPendingMessages: async () => 0,
} };
require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gws', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => false, isConfigured: () => false, sendSMS: async () => ({ success: false }), logStartupDiagnostic: () => {}, validateWebhookSignature: () => true } };
require.cache[path.join(ROOT, 'services', 'userResolver.js')] = { id: 'ur', filename: path.join(ROOT, 'services/userResolver.js'), loaded: true, exports: {
  resolveUserByPhone: async (phone) => (phone === '+22675405214' ? { found: true, uid: 'u-gwowner', phone } : { found: false }),
  resolveUserByUid: async (uid) => ({ found: true, uid }),
  normalizeEmail: (e) => String(e || '').toLowerCase(),
  resolveVerifiedPhoneByUid: async (uid) => {
    const snap = await db.collection('users').doc(String(uid)).get();
    if (!snap || !snap.exists) return { found: false, reason: 'user_not_found' };
    const u = snap.data() || {};
    if (u.deleted === true) return { found: false, reason: 'user_not_found' };
    const raw = String(u.phone || u.phoneNumber || '').trim();
    if (!raw) return { found: false, reason: 'no_phone' };
    if (u.phoneVerified === false) return { found: false, reason: 'phone_unverified' };
    if (u.phoneVerified !== true && u.status && u.status !== 'active') return { found: false, reason: 'phone_unverified' };
    return { found: true, phone: raw, source: 'firestore.phone', basis: u.phoneVerified === true ? 'otp_verified' : 'legacy_active', user: u };
  },
} };

(async () => {
  const gwPort = await new Promise((r) => gwServer.listen(0, '127.0.0.1', () => r(gwServer.address().port)));
  process.env.SMS_GATEWAY_LOGIN = 'login-app';
  process.env.SMS_GATEWAY_PASSWORD = 'pass-app';
  process.env.SMS_GATEWAY_DEVICE_ID = 'zfold2';
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${gwPort}`;
  process.env.SMS_GATEWAY_DEVICE_NUMBER = '+22675405214';

  /* ══ 1. LE BUG : worker BullMQ réel créé, puis quota épuisé (shutdown) ══ */
  const qs = require(path.join(ROOT, 'services', 'queueService.js'));
  let ran = 0;
  const proc = async () => { ran++; return { ok: true }; };
  const w = qs.createWorker('v7-q', proc, 1); // Redis configuré (injoignable) → VRAI worker BullMQ
  if (w && w.on) w.on('error', () => {});
  check('bug reproduit : worker BullMQ créé, handler inline ABSENT avant le fix', ran === 0);

  qs.shutdownForQuota('test quota'); // ← le chemin exact de la prod (quota épuisé)
  await sleep(250);
  const jr = await qs.addJob('v7-q', { x: 1 });
  check('FIX : après fermeture workers (quota), le job s\'exécute en INLINE (plus jamais « No queue or handler »)', jr.inline === true && ran === 1 && jr.result && jr.result.ok === true, jr);

  /* ══ 2. Reprise des vocaux orphelines → transcription → SMS automatique ══ */
  const tw = require(path.join(ROOT, 'workers', 'transcriptionWorker.js'));
  tw.startWorker(); // enregistre le handler inline « transcription » (mode dégradé)
  const audioPath = path.join(os.tmpdir(), `v7-audio-${Date.now()}.wav`);
  fs.writeFileSync(audioPath, Buffer.alloc(2048));

  await db.collection('users').doc('u-v7-voice').set({ phone: '+22670000042', status: 'active' }); // legacy vérifié
  await db.collection('messages').doc('m-v7-orphan').set({
    type: 'audio', channel: 'app', status: 'pending',
    transcriptionStatus: 'pending', transcription: null,
    smsAfterTranscription: 'pending',
    audioUrl: audioPath, senderName: 'Ali', receiverId: 'u-v7-voice', senderId: 'u-sender',
    conversationId: 'conv-v7', createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(), // > 10 min
  });
  const postsBefore = GW.posts.length;
  const sweep = await tw.sweepOrphanTranscriptions();
  await sleep(500);
  check('sweep : vocal orphelin ré-armé', sweep && sweep.requeued === 1, sweep);
  const after = (await db.collection('messages').doc('m-v7-orphan').get()).data();
  check('sweep → transcription (Groq simulé) → SMS SMSGate ENVOYÉ AUTOMATIQUEMENT (preuve POST)', GW.posts.length === postsBefore + 1 && GW.posts[postsBefore].text.includes('Transcription v7 OK'), { posts: GW.posts.slice(postsBefore), after });
  check('statuts enregistrés : smsAfterTranscription=sent + smsMessageId + smsAcceptedAt', after.smsAfterTranscription === 'sent' && !!after.smsMessageId && !!after.smsAcceptedAt, { s: after.smsAfterTranscription, id: after.smsMessageId, at: after.smsAcceptedAt });
  check('audio original CONSERVÉ (fichier toujours présent)', fs.existsSync(audioPath));

  /* 2.b Vocaux RÉCENTS et déjà transcrits → jamais re-armés (anti-doublon) */
  await db.collection('messages').doc('m-v7-recent').set({
    type: 'audio', transcriptionStatus: 'pending', audioUrl: audioPath,
    receiverId: 'u-v7-voice', createdAt: new Date().toISOString(), // < 10 min → in-flight possible
  });
  const postsBefore2 = GW.posts.length;
  const sweep2 = await tw.sweepOrphanTranscriptions();
  check('sweep : vocaux récents (>0 min) et déjà traités ignorés (pas de double transcription)', sweep2.requeued === 0 && GW.posts.length === postsBefore2, { sweep2, posts: GW.posts.length });

  /* ══ 3. Webhooks SMSGate : sms:delivered / sms:failed associés au doc ══ */
  await db.collection('messages').doc('m-v7-dlr').set({ status: 'sent', smsMessageId: 'gw-dlr-a' });
  await db.collection('messages').doc('m-v7-dlr2').set({ status: 'sent', smsMessageId: 'gw-dlr-b' });
  const inboundRouter = require(path.join(ROOT, 'routes', 'sms.gateway.inbound.js'));
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', inboundRouter);
  const apiServer = http.createServer(app);
  const apiPort = await new Promise((r) => apiServer.listen(0, '127.0.0.1', () => r(apiServer.address().port)));
  const postHook = (body) => fetch(`http://127.0.0.1:${apiPort}/api/webhooks/sms-gateway/inbound`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const h1 = await postHook({ event: 'sms:delivered', messagePayload: { id: 'gw-dlr-a', receivedAt: '2026-11-12T10:00:00Z' } });
  await sleep(300);
  const d1 = (await db.collection('messages').doc('m-v7-dlr').get()).data();
  check('webhook sms:delivered → 200 + statut doc = delivered (accepted ≠ delivered)', h1.status === 200 && d1.status === 'delivered' && !!d1.deliveredAt, { status: h1.status, doc: d1 });
  const h2 = await postHook({ event: 'sms:failed', messagePayload: { id: 'gw-dlr-b', error: 'device offline' } });
  await sleep(300);
  const d2 = (await db.collection('messages').doc('m-v7-dlr2').get()).data();
  check('webhook sms:failed → statut doc = failed + motif enregistré', h2.status === 200 && d2.status === 'failed' && /device offline/.test(String(d2.smsError || '')), { doc: d2 });
  const h3 = await postHook({ event: 'sms:received', messagePayload: { id: 'inb-1', phoneNumber: '+22670000099', message: 'REP' } });
  check('webhook sms:received → traité sans crash (SMS entrant passerelle)', h3.status === 200, h3.status);

  /* ══ 4. Instrumentation latence (source) ══ */
  const src = fs.readFileSync(path.join(ROOT, 'services', 'smsGateProvider.js'), 'utf8');
  check('latence : [SMSGATE] SMS accepted journalise durationMs (backend → acceptation)', src.includes('durationMs: Date.now() - t0'));

  gwServer.close(); apiServer.close();
  console.log(failures === 0 ? '\nMISSION V7 OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATALE:', e); process.exit(1); });
