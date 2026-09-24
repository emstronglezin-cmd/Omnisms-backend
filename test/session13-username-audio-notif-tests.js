'use strict';
/**
 * OmniSMS — Tests Session 13 (Username + Audio→SMS + Notifications)
 * ════════════════════════════════════════════════════════════════════
 *
 * Tests de VRAI comportement (pas de lecture de fichiers) :
 *   - modules réels chargés (userResolver, messageRouter, messages.v2,
 *     sms.gateway.inbound, socketService, queueService, transcriptionWorker)
 *   - Firestore / Redis / INfiniReach / Infobip / Groq mockés
 *   - serveur Express réel + Socket.IO réel (client socket.io-client réel)
 *
 * Séries :
 *   U  — USERNAME #username (POST /api/messages/send + Socket.IO + inbound SMS)
 *   A  — AUDIO → transcription → SMS (reprise après transcription, idempotence)
 *   N  — NOTIFICATIONS (émission Socket.IO réelle, payload, UID, persistance)
 *   I  — INBOUND #username (SMS entrant via protocole #)
 *
 * Exécution : node test/session13-username-audio-notif-tests.js
 * (requiert socket.io-client — installé via npm install --no-save socket.io-client)
 */

/* ── Environnement AVANT tout require de service ────────────────────────── */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-session13-0123456789abcdef';
process.env.OFFLINE_SMS_PROVIDER = 'sms_gateway';
process.env.INFINIREACH_FROM_NUMBER = '+22675405214'; // SIM passerelle (jamais destinataire)
delete process.env.INFOBIP_API_KEY;
delete process.env.INFOBIP_BASE_URL;
delete process.env.REDIS_URL;           // mode inline (sans Redis)
delete process.env.INFINIREACH_API_KEY; // transport mocké

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');

/* ── Mini-framework ─────────────────────────────────────────────────────── */
let pass = 0;
let fail = 0;
const results = [];

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    pass++;
    results.push({ name, ok: true });
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    fail++;
    results.push({ name, ok: false, error: e.message });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertIncludes(haystack, needle, msg) {
  if (typeof haystack === 'string' ? !haystack.includes(needle) : !haystack) {
    throw new Error(msg || `Expected to include ${JSON.stringify(needle)}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeoutMs = 2500, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

/* ── Injection de mocks (cache require, idem suites existantes) ─────────── */
function injectMock(rel, mock) {
  const abs = require.resolve(rel); // rel relatif au fichier de test (../config/firebase, …)
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: mock };
}

/* ── Mock Firestore ─────────────────────────────────────────────────────── */
function makeMockDb() {
  const store = {};
  const db = {
    _store: store,
    collection(name) {
      store[name] = store[name] || {};
      const self = {
        _where: null,
        where(field, _op, val) { this._where = { field, val }; return this; },
        limit() { return this; },
        orderBy() { return this; },
        async get() {
          const col  = store[name] || {};
          let docs   = Object.entries(col).map(([id, data]) => ({
            id,
            data: () => data,
            exists: true,
            ref: {
              id, __col: name, __id: id,
              async update(u) { Object.assign(col[id], u); },
              async delete()  { delete col[id]; },
            },
          }));
          if (this._where) {
            const { field, val } = this._where;
            docs = docs.filter(d => d.data()[field] === val);
          }
          return { empty: docs.length === 0, docs, size: docs.length };
        },
        doc(id) {
          return {
            id, __col: name, __id: id,
            async get() { const d = store[name][id]; return { exists: d != null, data: () => d, id }; },
            async set(data) { store[name][id] = data; },
            async update(data) { store[name][id] = Object.assign(store[name][id] || {}, data); },
            async delete() { delete store[name][id]; },
          };
        },
        async add(data) {
          const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          store[name][id] = data;
          return { id };
        },
      };
      return self;
    },
    // Transaction simple (séquentielle) pour l'atomicité audioSmsStatus
    async runTransaction(fn) {
      const tx = {
        __updates: [],
        async get(ref) {
          const d = (store[ref.__col] || {})[ref.__id];
          return { exists: d != null, data: () => d, id: ref.__id };
        },
        update(ref, data) { tx.__updates.push([ref, data]); },
      };
      const out = await fn(tx);
      for (const [ref, data] of tx.__updates) {
        const col = store[ref.__col] || {};
        col[ref.__id] = Object.assign(col[ref.__id] || {}, data);
        store[ref.__col] = col;
      }
      return out;
    },
  };
  return db;
}

/* ── Mock Redis (MemoryStore minimal — mêmes signatures qu'online_users) ── */
function makeMockRedis() {
  const store = new Map();
  const exp   = new Map();
  const fresh = (k) => {
    const e = exp.get(k);
    if (e && Date.now() > e) { store.delete(k); exp.delete(k); return true; }
    return false;
  };
  return {
    isMemoryFallback: true,
    _store: store,
    async get(k) { if (fresh(k)) return null; return store.has(k) ? store.get(k) : null; },
    async set(k, v, ...args) {
      store.set(k, v);
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === 'EX' && args[i + 1]) { exp.set(k, Date.now() + Number(args[i + 1]) * 1000); i++; }
      }
      return 'OK';
    },
    async del(k) { store.delete(k); exp.delete(k); return 1; },
    async hset(k, f, val) { const h = store.get(k) || {}; h[f] = val; store.set(k, h); return 1; },
    async hget(k, f) { const h = store.get(k) || {}; return h[f] ?? null; },
    async hdel(k, ...fs) { const h = store.get(k) || {}; fs.forEach((f) => delete h[f]); store.set(k, h); return 1; },
    async expire(k, secs) { exp.set(k, Date.now() + secs * 1000); return 1; },
    async setnx(k, v) { if (store.has(k) && !fresh(k)) return 0; store.set(k, v); return 1; },
  };
}

/* ── Mocks transports / services ────────────────────────────────────────── */
function makeMockSmsGateway() {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    isSmsGatewayProvider: () => true,
    isInfobipFallbackEnabled: () => false,
    getActiveProvider: () => 'sms_gateway',
    validateWebhookSignature: () => true,
    sendSMS: async (opts) => {
      calls.push({ ...opts });
      return {
        success: true,
        gatewayMessageId: `ir-${calls.length}`,
        messageId: `ir-${calls.length}`,
        state: 'queued',
        provider: 'sms_gateway',
      };
    },
  };
}

function makeMockInfobip() {
  const calls = [];
  return {
    calls,
    isConfigured: () => false, // standby non configuré (le gateway est actif)
    sendSMS: async (opts) => { calls.push(opts); return { success: false, error: 'not configured' }; },
  };
}

let transcribeText  = 'Bonjour, tout va bien.';
let transcribeError = null;
function makeMockTranscription() {
  return {
    transcribe: async () => {
      if (transcribeError) throw new Error(transcribeError);
      return { text: transcribeText, language: 'fr', duration: 2, segments: [], method: 'groq-whisper' };
    },
    getTranscriptionStatus: async () => ({ available: true, activeEngine: 'groq-whisper' }),
    isGroqConfigured: () => true,
    isWhisperServiceAvailable: async () => false,
    isWhisperCliAvailable: () => false,
  };
}

/* ── Capture de logs (stdout) ───────────────────────────────────────────── */
function captureLogs() {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const s = String(chunk);
    lines.push(s);
    return orig(chunk, ...rest);
  };
  return {
    lines,
    stop() { process.stdout.write = orig; },
    contains(re) { return lines.some((l) => re.test(l)); },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════════════════ */
async function main() {
  console.log('\nOmniSMS — Session 13 — Username + Audio→SMS + Notifications');
  console.log('================================================================\n');

  /* ── Construction des mocks et injection AVANT require des modules réels ── */
  const mockDb        = makeMockDb();
  const mockRedis     = makeMockRedis();
  const gatewayMock   = makeMockSmsGateway();
  const infobipMock   = makeMockInfobip();
  const transcribeMock= makeMockTranscription();

  // Comptes de test (collection users)
  mockDb._store.users = {
    'uid-alice': { phone: '+22670000001', username: 'alice',      name: 'Alice', phoneVerified: true, isSubscribed: false, credits: 100 },
    'uid-bob':   { phone: '+22670000002', username: 'petit-test', name: 'Bob',   phoneVerified: true, isSubscribed: false, credits: 100 },
    'uid-carol': { phone: '+22670123456', username: 'user_test',  name: 'Carol', phoneVerified: true, isSubscribed: false, credits: 100 },
    'uid-dave':  { phone: null,           username: '45678',      name: 'Dave',  phoneVerified: true, isSubscribed: false, credits: 100 },
    'uid-dave2': { phone: null,           username: '123456',     name: 'Dave2', phoneVerified: true, isSubscribed: false, credits: 100 },
  };

  injectMock('../config/firebase', mockDb);
  injectMock('../services/redis', mockRedis);
  injectMock('../services/smsGateway', gatewayMock);
  injectMock('../services/infobip', infobipMock);
  injectMock('../services/transcriptionService', transcribeMock);

  /* ── Modules RÉELS ─────────────────────────────────────────────────────── */
  const express         = require('express');
  const messagesRouter  = require('../routes/messages.v2');
  const inbound         = require('../routes/sms.gateway.inbound');
  const socketService   = require('../services/socketService');
  const { signToken }   = require('../middleware/authenticate');
  const { startSmsWorker } = require('../services/smsQueueWorker');
  const { transcriptionProcessor } = require('../workers/transcriptionWorker');

  /* ── Worker SMS inline (mode sans Redis) — file existante ──────────────── */
  startSmsWorker();

  /* ── Serveur Express réel + Socket.IO réel ─────────────────────────────── */
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/messages', messagesRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const io   = socketService.initSocketIO(server);

  /* ── Client Socket.IO réel (Bob en ligne) ──────────────────────────────── */
  const { io: ioClient } = require('socket.io-client');
  const bobSocket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token: signToken({ uid: 'uid-bob', email: 'bob@test.com', name: 'Bob' }) },
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
  });
  await new Promise((resolve, reject) => {
    bobSocket.once('connect', resolve);
    bobSocket.once('connect_error', reject);
  });
  await sleep(300); // présence serveur (setUserOnline)

  const bobReceived = [];
  bobSocket.on('message:receive', (m) => bobReceived.push(m));

  /* ── Helpers HTTP ──────────────────────────────────────────────────────── */
  const SENDER_NAMES = { 'uid-alice': 'Alice', 'uid-bob': 'Bob', 'uid-carol': 'Carol' };
  async function sendAs(uid, body) {
    const token = signToken({ uid, email: `${uid.replace('uid-', '')}@test.com`, name: SENDER_NAMES[uid] || 'Test' });
    const res = await fetch(`http://127.0.0.1:${port}/api/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  }

  const messagesCount = () => Object.keys(mockDb._store.messages || {}).length;
  const findMessage   = (id) => (mockDb._store.messages || {})[id];
  const externalAudio = 'data:audio/webm;base64,QUJDREVGRw==';

  function makeInboundWebhook({ messageId, from, to, body }) {
    return {
      event: 'message.inbound',
      timestamp: new Date().toISOString(),
      data: {
        messageId,
        direction: 'inbound',
        from,
        to,
        body,
        deviceId: 'zfold2-test',
        timestamp: new Date().toISOString(),
        status: 'delivered',
      },
    };
  }

  function makeJob(jobId, data) {
    return { id: jobId, attemptsMade: 0, opts: { attempts: 2 }, data };
  }

  // Fichier audio temp réel (le worker vérifie l'existence du fichier)
  const tmpAudio = path.join(os.tmpdir(), `s13-audio-${process.pid}-${Date.now()}.webm`);
  fs.writeFileSync(tmpAudio, Buffer.from('fake audio bytes — session 13 tests'));

  const CONV_ALICE_BOB = ['uid-alice', 'uid-bob'].sort().join('-');

  try {
    /* ══════════════════════════════════════════════════════════════════════
       PARTIE U — USERNAME #username
    ══════════════════════════════════════════════════════════════════════ */
    console.log('\n━━━ PARTIE U — USERNAME (#username) ━━━━━━━━━━━━━━━━━━━━━\n');

    await testAsync('U1 — #petit-test → 201, route OMNISMS, conversationId canonique', async () => {
      const r = await sendAs('uid-alice', { receiverId: '#petit-test', type: 'text', content: 'Bonjour Bob' });
      assertEqual(r.status, 201, `status=${r.status} body=${JSON.stringify(r.json)}`);
      assertEqual(r.json.route, 'OMNISMS', `route=${r.json.route}`);
      assertEqual(r.json.conversationId, CONV_ALICE_BOB, `convId=${r.json.conversationId}`);
    });

    await testAsync('U2 — #inconnu-404 → 404 USER_NOT_FOUND, aucun message, aucun SMS', async () => {
      const beforeMsg = messagesCount();
      const beforeSms = gatewayMock.calls.length;
      const r = await sendAs('uid-alice', { receiverId: '#inconnu-404', type: 'text', content: 'Salut' });
      assertEqual(r.status, 404, `status=${r.status} body=${JSON.stringify(r.json)}`);
      assertEqual(r.json.code, 'USER_NOT_FOUND', `code=${r.json.code}`);
      assertEqual(messagesCount(), beforeMsg, 'aucun message fantôme ne doit être créé');
      assertEqual(gatewayMock.calls.length, beforeSms, 'aucun SMS ne doit partir');
    });

    await testAsync('U3 — #petit-test (destinataire en ligne) → reçu par Bob via Socket.IO', async () => {
      const before = bobReceived.length;
      const r = await sendAs('uid-alice', { receiverId: '#petit-test', type: 'text', content: 'Message U3' });
      assertEqual(r.status, 201, `status=${r.status}`);
      const ok = await waitFor(() => bobReceived.length > before);
      assert(ok, 'Bob (connecté) doit recevoir le message en temps réel');
      const m = bobReceived[bobReceived.length - 1];
      assertEqual(m.receiverId, 'uid-bob', `receiverId=${m.receiverId}`);
      assertEqual(m.content, 'Message U3', `content=${m.content}`);
    });

    await testAsync('U4 — #user_test (hors ligne) → SMS au VRAI numéro du profil', async () => {
      const beforeSms = gatewayMock.calls.length;
      const beforeMsg = messagesCount();
      const r = await sendAs('uid-alice', { receiverId: '#user_test', type: 'text', content: 'Coucou Carol' });
      assertEqual(r.status, 201, `status=${r.status} body=${JSON.stringify(r.json)}`);
      assertEqual(r.json.route, 'SMS_EXTERNE', `route=${r.json.route}`);
      const newCalls = gatewayMock.calls.slice(beforeSms);
      assertEqual(newCalls.length, 1, `1 SMS attendu, ${newCalls.length} reçus`);
      assertEqual(newCalls[0].to, '+22670123456', `to=${newCalls[0].to} (vrai numéro du profil carol)`);
      assert(newCalls[0].to !== '+22675405214', 'JAMAIS le numéro de la passerelle');
      assertIncludes(newCalls[0].text, '[OmniSMS]', 'format SMS conservé');
      assertIncludes(newCalls[0].text, 'Coucou Carol', 'contenu du message');
      assertIncludes(newCalls[0].text, 'Alice', 'nom de l\'expéditeur');
      // Message persisté (channel sms)
      const ok = await waitFor(() => messagesCount() > beforeMsg);
      assert(ok, 'message persisté en Firestore');
    });

    await testAsync('U5 — téléphone direct toujours fonctionnel (rétrocompatibilité)', async () => {
      const b1 = gatewayMock.calls.length;
      const r1 = await sendAs('uid-alice', { receiverId: '+22670123456', type: 'text', content: 'Carol directe' });
      assertEqual(r1.status, 201, `status=${r1.status}`);
      assertEqual(gatewayMock.calls.length, b1 + 1, 'SMS vers +22670123456');
      assertEqual(gatewayMock.calls[b1].to, '+22670123456', `to=${gatewayMock.calls[b1].to}`);

      const b2 = gatewayMock.calls.length;
      const r2 = await sendAs('uid-alice', { receiverId: '+22670987654', type: 'text', content: 'Externe' });
      assertEqual(r2.status, 201, `status=${r2.status}`);
      assertEqual(gatewayMock.calls.length, b2 + 1, 'SMS vers un numéro externe non OmniSMS');
      assertEqual(gatewayMock.calls[b2].to, '+22670987654', `to=${gatewayMock.calls[b2].to}`);
    });

    await testAsync('U5b — #+22670123456 → protocole téléphone (priorité numéro)', async () => {
      const b = gatewayMock.calls.length;
      const r = await sendAs('uid-alice', { receiverId: '#+22670123456', type: 'text', content: 'Via # numéro' });
      assertEqual(r.status, 201, `status=${r.status}`);
      assertEqual(gatewayMock.calls.length, b + 1, 'SMS envoyé');
      assertEqual(gatewayMock.calls[b].to, '+22670123456', `to=${gatewayMock.calls[b].to}`);
    });

    await testAsync('U6 — username avec _ ou casse mixte (#User_Test)', async () => {
      const b = gatewayMock.calls.length;
      const r = await sendAs('uid-alice', { receiverId: '#User_Test', type: 'text', content: 'Casse mixte' });
      assertEqual(r.status, 201, `status=${r.status} (normalisation lowercase)`);
      assertEqual(gatewayMock.calls.length, b + 1, 'SMS vers le compte user_test');
      assertEqual(gatewayMock.calls[b].to, '+22670123456', `to=${gatewayMock.calls[b].to}`);
    });

    await testAsync('U7a — #123456 : username numérique (aucun compte n\'a ce numéro)', async () => {
      const bSms = gatewayMock.calls.length;
      const bMsg = messagesCount();
      const r = await sendAs('uid-alice', { receiverId: '#123456', type: 'text', content: 'Test U7a' });
      assertEqual(r.status, 201, `status=${r.status} (pas d\'exception, pas de 404)`);
      // dave2 (username '123456') n'a pas de téléphone → aucun SMS, message conservé
      assertEqual(gatewayMock.calls.length, bSms, 'aucun SMS (profil sans téléphone)');
      assertEqual(messagesCount(), bMsg + 1, 'message conservé en Firestore');
    });

    await testAsync('U7b — #45678 : username numérique court (jamais confondu avec un numéro)', async () => {
      const bSms = gatewayMock.calls.length;
      const r = await sendAs('uid-alice', { receiverId: '#45678', type: 'text', content: 'Test U7b' });
      assertEqual(r.status, 201, `status=${r.status}`);
      assertEqual(gatewayMock.calls.length, bSms, 'aucun SMS (dave sans téléphone)');
    });

    await testAsync('U7c — #22670123456 : le numéro prime toujours sur le username', async () => {
      const b = gatewayMock.calls.length;
      const r = await sendAs('uid-alice', { receiverId: '#22670123456', type: 'text', content: 'Numero prioritaire' });
      assertEqual(r.status, 201, `status=${r.status}`);
      assertEqual(gatewayMock.calls.length, b + 1, 'SMS vers le compte possédant ce numéro (carol)');
      assertEqual(gatewayMock.calls[b].to, '+22670123456', `to=${gatewayMock.calls[b].to}`);
    });

    await testAsync('U8 — #petit-test + audio → OMNISMS (Bob reçoit le vocal), aucun SMS', async () => {
      const before = bobReceived.length;
      const bSms = gatewayMock.calls.length;
      const r = await sendAs('uid-alice', { receiverId: '#petit-test', type: 'audio', audioUrl: externalAudio, duration: 3 });
      assertEqual(r.status, 201, `status=${r.status}`);
      assertEqual(r.json.route, 'OMNISMS', `route=${r.json.route}`);
      const ok = await waitFor(() => bobReceived.length > before);
      assert(ok, 'Bob doit recevoir le vocal en temps réel');
      const m = bobReceived[bobReceived.length - 1];
      assertEqual(m.type, 'audio', `type=${m.type}`);
      assertEqual(m.audioUrl, externalAudio, 'audioUrl transmis');
      assertEqual(gatewayMock.calls.length, bSms, 'aucun SMS pour un destinataire OmniSMS en ligne');
    });

    /* ══════════════════════════════════════════════════════════════════════
       PARTIE A — AUDIO → TRANSCRIPTION → SMS
    ══════════════════════════════════════════════════════════════════════ */
    console.log('\n━━━ PARTIE A — AUDIO → TRANSCRIPTION → SMS ━━━━━━━━━━━━━━━\n');

    let audioMsgId = null;

    await testAsync('A1 — vocal externe : envoi → transcription en attente → reprise SMS', async () => {
      const logs = captureLogs();
      try {
        const r = await sendAs('uid-alice', { receiverId: '+22670999999', type: 'audio', audioUrl: externalAudio, duration: 3 });
        assertEqual(r.status, 201, `status=${r.status}`);
        assertEqual(r.json.route, 'SMS_EXTERNE', `route=${r.json.route}`);
        audioMsgId = r.json.message.id;
        assert(audioMsgId, 'messageId présent dans la réponse');

        // Le log initial ne doit PAS annoncer un échec définitif (job asynchrone en cours)
        assert(logs.contains(/transcription en attente \(asynchrone\)/), 'log « transcription en attente (asynchrone) » présent');
        assert(!logs.contains(/Transcription réellement échouée/), 'pas de « réellement échouée » avant la fin du job');

        // Le worker (Groq simulé) termine → reprise automatique du routage SMS
        const job = makeJob('job-a1', {
          audioPath: tmpAudio,
          messageId: audioMsgId,
          userId: 'uid-alice',
          language: 'fr',
          collection: 'messages',
        });
        const res = await transcriptionProcessor(job);
        assertEqual(res.audioSms, 'sent', `action reprise=${res.audioSms}`);

        const doc = findMessage(audioMsgId);
        assertEqual(doc.transcriptionStatus, 'done', 'transcription sauvegardée');
        assertIncludes(doc.transcription, 'Bonjour, tout va bien.', 'texte transcrit stocké');
      } finally {
        logs.stop();
      }
    });

    await testAsync('A2 — la transcription est sauvegardée ET le SMS est en file (provider existant)', async () => {
      const doc = findMessage(audioMsgId);
      assert(doc.audioSmsStatus, 'marqueur audioSmsStatus présent (idempotence)');
      assert(['sent', 'queued'].includes(doc.audioSmsStatus), `audioSmsStatus=${doc.audioSmsStatus}`);
      const calls = gatewayMock.calls.filter((c) => c.messageId === audioMsgId);
      assertEqual(calls.length, 1, 'exactly un SMS pour ce message');
    });

    await testAsync('A3 — SMS envoyé via le provider existant : bon destinataire, format, externalId', async () => {
      const call = gatewayMock.calls.find((c) => c.messageId === audioMsgId);
      assert(call, 'appel provider présent');
      assertEqual(call.to, '+22670999999', `to=${call.to}`);
      assertIncludes(call.text, '[OmniSMS Vocal]', 'préfixe vocal conservé');
      assertIncludes(call.text, 'Bonjour, tout va bien.', 'seul le TEXTE est envoyé (jamais le fichier)');
      assertIncludes(call.text, 'Alice', 'expéditeur identifié');
      assert(call.text.length < 2000, 'SMS raisonnable');
      assertEqual(call.messageId, audioMsgId, 'messageId transmis → externalId omnisms-{id} (idempotence)');
      assert(!call.text.startsWith('data:'), 'jamais le data URI audio dans le SMS');
    });

    await testAsync('A4 — transcription VIDE → aucun SMS, message conservé, statut propre', async () => {
      const beforeSms = gatewayMock.calls.length;
      mockDb._store.messages['msg-audio-4'] = {
        senderId: 'uid-alice',
        receiverId: '+22670999998',
        conversationId: 'ext-uid-alice-+22670999998',
        content: '🎤 Message vocal',
        type: 'audio',
        channel: 'sms',
        audioUrl: externalAudio,
        status: 'pending',
        transcriptionStatus: 'pending',
      };
      transcribeText = '   ';
      const job = makeJob('job-a4', { audioPath: tmpAudio, messageId: 'msg-audio-4', userId: 'uid-alice', collection: 'messages' });
      const res = await transcriptionProcessor(job);
      assertEqual(res.audioSms, 'skipped', `action=${res.audioSms}`);
      assertEqual(gatewayMock.calls.length, beforeSms, 'aucun SMS envoyé');
      const doc = findMessage('msg-audio-4');
      assertEqual(doc.audioSmsStatus, 'skipped_empty_transcription', `statut=${doc.audioSmsStatus}`);
    });

    await testAsync('A5 — transcription ÉCHOUÉE → aucun SMS, statut d\'erreur propre, log clair', async () => {
      const beforeSms = gatewayMock.calls.length;
      mockDb._store.messages['msg-audio-5'] = {
        senderId: 'uid-alice',
        receiverId: '+22670999997',
        conversationId: 'ext-uid-alice-+22670999997',
        content: '🎤 Message vocal',
        type: 'audio',
        channel: 'sms',
        audioUrl: externalAudio,
        status: 'pending',
        transcriptionStatus: 'pending',
      };
      transcribeError = 'Groq HTTP error: 500';
      const logs = captureLogs();
      let threw = false;
      try {
        // Dernière tentative BullMQ (attempts 2, attemptsMade 1) → échec définitif
        const jobA5 = { id: 'job-a5', attemptsMade: 1, opts: { attempts: 2 }, data: { audioPath: tmpAudio, messageId: 'msg-audio-5', userId: 'uid-alice', collection: 'messages' } };
        await transcriptionProcessor(jobA5);
      } catch (_) {
        threw = true; // attendu : le job échoue (retry BullMQ), mais aucun SMS
      }
      logs.stop();
      transcribeError = null;
      assert(threw, 'le job de transcription échoue proprement');
      assertEqual(gatewayMock.calls.length, beforeSms, 'aucun SMS envoyé');
      const doc = findMessage('msg-audio-5');
      assertEqual(doc.transcriptionStatus, 'error', 'statut transcription=error');
      assertEqual(doc.audioSmsStatus, 'transcription_failed', `audioSmsStatus=${doc.audioSmsStatus}`);
      assert(logs.contains(/Transcription réellement échouée/), 'log « réellement échouée » (distinction attendu/échec)');
    });

    await testAsync('A6 — retry du worker → aucun doublon SMS (idempotence)', async () => {
      const beforeSms = gatewayMock.calls.filter((c) => c.messageId === audioMsgId).length;
      const res = await transcriptionProcessor(makeJob('job-a1-retry', {
        audioPath: tmpAudio, messageId: audioMsgId, userId: 'uid-alice', collection: 'messages',
      }));
      assertEqual(res.audioSms, 'skipped', `action=${res.audioSms} (déjà traité)`);
      const afterSms = gatewayMock.calls.filter((c) => c.messageId === audioMsgId).length;
      assertEqual(afterSms, beforeSms, 'aucun SMS supplémentaire après retry');
    });

    await testAsync('A7 — vocal vers OmniSMS en ligne (channel app) → aucun SMS', async () => {
      const beforeSms = gatewayMock.calls.length;
      mockDb._store.messages['msg-audio-7'] = {
        senderId: 'uid-alice',
        receiverId: 'uid-bob',
        conversationId: CONV_ALICE_BOB,
        content: '🎤 Message vocal',
        type: 'audio',
        channel: 'app',
        audioUrl: externalAudio,
        status: 'sent',
        transcriptionStatus: 'done',
        transcription: 'Bonjour',
      };
      const { continueAudioSmsAfterTranscription } = require('../services/messageRouter');
      const res = await continueAudioSmsAfterTranscription({
        messageId: 'msg-audio-7', transcription: 'Bonjour', collection: 'messages',
      });
      assertEqual(res.action, 'skipped', `action=${res.action}`);
      assertEqual(res.reason, 'not_sms_route', `reason=${res.reason}`);
      assertEqual(gatewayMock.calls.length, beforeSms, 'aucun SMS');
    });

    await testAsync('A8 — receiverId non E.164 (UID) → aucun SMS, pas de crash', async () => {
      const beforeSms = gatewayMock.calls.length;
      mockDb._store.messages['msg-audio-8'] = {
        senderId: 'uid-alice',
        receiverId: 'uid-bob',
        conversationId: CONV_ALICE_BOB,
        type: 'audio',
        channel: 'sms',
        audioUrl: externalAudio,
        status: 'pending',
      };
      const { continueAudioSmsAfterTranscription } = require('../services/messageRouter');
      const res = await continueAudioSmsAfterTranscription({
        messageId: 'msg-audio-8', transcription: 'Bonjour', collection: 'messages',
      });
      assertEqual(res.action, 'skipped', `action=${res.action}`);
      assertEqual(res.reason, 'no_valid_recipient_phone', `reason=${res.reason}`);
      assertEqual(gatewayMock.calls.length, beforeSms, 'aucun SMS');
    });

    /* ══════════════════════════════════════════════════════════════════════
       PARTIE N — NOTIFICATIONS (Socket.IO réel)
    ══════════════════════════════════════════════════════════════════════ */
    console.log('\n━━━ PARTIE N — NOTIFICATIONS (Socket.IO réel) ━━━━━━━━━━━━━\n');

    await testAsync('N1 — Bob connecté : présence en ligne + room user:uid-bob', async () => {
      assertEqual(await socketService.isUserOnline('uid-bob'), true, 'présence Redis OK');
      const room = io.sockets.adapter.rooms.get('user:uid-bob');
      assert(room, 'room user:uid-bob existante');
      assertEqual(room.size, 1, `sockets dans la room=${room.size}`);
    });

    let n2Msg = null;
    await testAsync('N2 — nouveau message → événement message:receive réellement envoyé', async () => {
      const before = bobReceived.length;
      const r = await sendAs('uid-alice', { receiverId: '+22670000002', type: 'text', content: 'Salut Bob (N2)' });
      assertEqual(r.status, 201, `status=${r.status}`);
      assertEqual(r.json.route, 'OMNISMS', `route=${r.json.route}`);
      const ok = await waitFor(() => bobReceived.length > before);
      assert(ok, 'événement message:receive reçu par Bob');
      n2Msg = bobReceived[bobReceived.length - 1];
    });

    await testAsync('N3 — l\'événement est envoyé au bon UID destinataire', async () => {
      assert(n2Msg, 'message N2 capturé');
      assertEqual(n2Msg.receiverId, 'uid-bob', `receiverId=${n2Msg.receiverId}`);
      assertEqual(n2Msg.senderId, 'uid-alice', `senderId=${n2Msg.senderId}`);
    });

    await testAsync('N4 — payload conforme au contrat (id, conversationId, content, type, createdAt…)', async () => {
      assert(n2Msg, 'message N2 capturé');
      assert(n2Msg.id, 'messageId présent');
      assertEqual(n2Msg.conversationId, CONV_ALICE_BOB, `conversationId=${n2Msg.conversationId}`);
      assertEqual(n2Msg.content, 'Salut Bob (N2)', `content=${n2Msg.content}`);
      assertEqual(n2Msg.type, 'text', `type=${n2Msg.type}`);
      assertEqual(n2Msg.channel, 'app', `channel=${n2Msg.channel}`);
      assert(n2Msg.createdAt && !Number.isNaN(Date.parse(n2Msg.createdAt)), 'createdAt ISO valide');
      // Pas de champ parasite id-temporaire : le payload porte l'ID canonique
      assert(!/^msg-\d{13}-/.test(String(n2Msg.id)), `id canonique (pas msg-timestamp-random): ${n2Msg.id}`);
    });

    await testAsync('N5 — destinataire déconnecté : pas d\'événement Socket.IO, Firestore + SMS existants', async () => {
      const before = bobReceived.length;
      const bSms = gatewayMock.calls.length;
      const r = await sendAs('uid-alice', { receiverId: '+22670123456', type: 'text', content: 'Carol offline (N5)' });
      assertEqual(r.status, 201, `status=${r.status}`);
      assertEqual(r.json.route, 'SMS_EXTERNE', `route=${r.json.route} (offline → SMS)`);
      assertEqual(gatewayMock.calls.length, bSms + 1, 'SMS de repli vers le numéro de Carol');
      await sleep(150);
      assertEqual(bobReceived.length, before, 'aucun événement de plus pour le socket de Bob');
    });

    await testAsync('N6 — aucun événement envoyé au mauvais UID', async () => {
      const wrong = bobReceived.filter((m) => m.receiverId !== 'uid-bob');
      assertEqual(wrong.length, 0, `messages reçus par Bob avec receiverId != uid-bob : ${wrong.length}`);
    });

    await testAsync('N7 — message persistant dans Firestore (id canonique === id du payload)', async () => {
      assert(n2Msg, 'message N2 capturé');
      const doc = findMessage(n2Msg.id);
      assert(doc, `message ${n2Msg.id} persisté`);
      assertEqual(doc.senderId, 'uid-alice', 'sender persisté');
      assertEqual(doc.receiverId, 'uid-bob', 'receiver persisté');
      assertEqual(doc.conversationId, CONV_ALICE_BOB, 'conversation persistée');
      assertEqual(doc.content, 'Salut Bob (N2)', 'contenu persisté');
    });

    /* ══════════════════════════════════════════════════════════════════════
       PARTIE I — INBOUND SMS avec protocole #username
    ══════════════════════════════════════════════════════════════════════ */
    console.log('\n━━━ PARTIE I — INBOUND #username (SMS entrant) ━━━━━━━━━━━━━\n');

    await testAsync('I1 — « #petit-test Bonjour Bob » → résolu, reçu par Bob (en ligne)', async () => {
      const before = bobReceived.length;
      await inbound.processSmsReceived(makeInboundWebhook({
        messageId: 'ir-i1', from: '+226701234567', to: '+22675405214', body: '#petit-test Bonjour Bob',
      }));
      const ok = await waitFor(() => bobReceived.length > before);
      assert(ok, 'Bob a reçu le message inbound en temps réel');
      const m = bobReceived[bobReceived.length - 1];
      assertEqual(m.content, 'Bonjour Bob', `content nettoyé=${m.content}`);
      assertEqual(m.direction, 'inbound', `direction=${m.direction}`);
      assertEqual(m.receiverId, 'uid-bob', `receiverId=${m.receiverId}`);
      const msgs = Object.values(mockDb._store.messages || {});
      assert(msgs.some((d) => d.content === 'Bonjour Bob' && d.senderId === '+226701234567'),
        'message inbound persisté avec le texte nettoyé');
    });

    await testAsync('I2 — « #inconnu-404 » (aucune conv, SIM non OmniSMS) → pas de livraison fantôme, pas de SMS', async () => {
      const before = bobReceived.length;
      const bSms = gatewayMock.calls.length;
      await inbound.processSmsReceived(makeInboundWebhook({
        messageId: 'ir-i2', from: '+22670123999', to: '+22675405214', body: '#inconnu-404 Coucou',
      }));
      await sleep(150);
      assertEqual(bobReceived.length, before, 'aucun événement vers Bob');
      assertEqual(gatewayMock.calls.length, bSms, 'aucun SMS de repli (pas de destinataire résolu)');
    });

    await testAsync('I3 — « #user_test » (Carol hors ligne) → SMS de repli au VRAI numéro de Carol', async () => {
      const bSms = gatewayMock.calls.length;
      await inbound.processSmsReceived(makeInboundWebhook({
        messageId: 'ir-i3', from: '+226701234567', to: '+22675405214', body: '#user_test Coucou Carol',
      }));
      await sleep(100);
      const newCalls = gatewayMock.calls.slice(bSms);
      assertEqual(newCalls.length, 1, `1 SMS de repli attendu, ${newCalls.length} reçus`);
      assertEqual(newCalls[0].to, '+22670123456', `to=${newCalls[0].to}`);
      assertIncludes(newCalls[0].text, 'Coucou Carol', 'contenu transmis');
      assertIncludes(newCalls[0].text, '+226701234567', 'expéditeur indiqué');
    });

    await testAsync('I4 — « #123456 » (username numérique, profil sans téléphone) → conservé, pas de SMS', async () => {
      const bSms = gatewayMock.calls.length;
      await inbound.processSmsReceived(makeInboundWebhook({
        messageId: 'ir-i4', from: '+226701234567', to: '+22675405214', body: '#123456 Test',
      }));
      await sleep(100);
      assertEqual(gatewayMock.calls.length, bSms, 'aucun SMS (profil sans téléphone)');
      const msgs = Object.values(mockDb._store.messages || {});
      assert(msgs.some((d) => d.content === 'Test' && d.receiverId === 'uid-dave2'),
        'message conservé en Firestore pour uid-dave2');
    });

    await testAsync('I5 — inbound protocole téléphone (rétrocompat) : « #+22670000002 » → bon owner', async () => {
      const before = bobReceived.length;
      await inbound.processSmsReceived(makeInboundWebhook({
        messageId: 'ir-i5', from: '+226701234567', to: '+22675405214', body: '#+22670000002 Coucou Bob',
      }));
      const ok = await waitFor(() => bobReceived.length > before);
      assert(ok, 'Bob (cible du #+numéro) a reçu le message inbound');
      const m = bobReceived[bobReceived.length - 1];
      assertEqual(m.content, 'Coucou Bob', `content nettoyé=${m.content}`);
      assertEqual(m.receiverId, 'uid-bob', `receiverId=${m.receiverId}`);
    });

    await testAsync('I5b — inbound sans # : conversation externe existante → bon owner', async () => {
      // Conv ext-uid-bob-+22670123988 créée explicitement pour ce sous-test
      mockDb._store.external_conversations = mockDb._store.external_conversations || {};
      const now = new Date().toISOString();
      mockDb._store.external_conversations['ext-uid-bob-+22670123988'] = {
        conversationId: 'ext-uid-bob-+22670123988',
        ownerUid: 'uid-bob',
        externalPhone: '+22670123988',
        externalName: null,
        infobipNumber: null,
        channel: 'sms',
        createdAt: now, updatedAt: now, lastMessageAt: now, lastMessage: null,
        providerMessageIds: [],
      };
      const before = bobReceived.length;
      await inbound.processSmsReceived(makeInboundWebhook({
        messageId: 'ir-i5b', from: '+22670123988', to: '+22675405214', body: 'Message sans #',
      }));
      const ok = await waitFor(() => bobReceived.length > before);
      assert(ok, 'Bob (owner de la conv) a reçu le message sans #');
      const m = bobReceived[bobReceived.length - 1];
      assertEqual(m.content, 'Message sans #', `content=${m.content}`);
    });

    await testAsync('I6 — déduplication inbound conservée (même messageId → 1 seul traitement)', async () => {
      const before = bobReceived.length;
      await inbound.processSmsReceived(makeInboundWebhook({
        messageId: 'ir-dup', from: '+226701234567', to: '+22675405214', body: '#petit-test Premier',
      }));
      await waitFor(() => bobReceived.length > before);
      const after = bobReceived.length;
      await inbound.processSmsReceived(makeInboundWebhook({
        messageId: 'ir-dup', from: '+226701234567', to: '+22675405214', body: '#petit-test Premier (doublon)',
      }));
      await sleep(150);
      assertEqual(bobReceived.length, after, 'doublon ignoré');
    });

  } finally {
    try { bobSocket.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { fs.unlinkSync(tmpAudio); } catch (_) {}
  }

  /* ── Résumé ────────────────────────────────────────────────────────────── */
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Session 13 — Résultats finaux`);
  console.log(`  Réussis : ${pass}`);
  console.log(`  Échoués : ${fail}`);
  console.log(`  Total   : ${pass + fail}`);
  console.log('═══════════════════════════════════════════════════════════════');

  if (fail === 0) {
    console.log('  ✅ Tous les tests Session 13 passent.\n');
    process.exit(0);
  } else {
    console.error(`  ❌ ${fail} test(s) échoué(s) :`);
    results.filter((r) => !r.ok).forEach((r) => console.error(`     - ${r.name}: ${r.error}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFATALE:', err);
  process.exit(1);
});
