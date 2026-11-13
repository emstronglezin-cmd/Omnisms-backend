'use strict';
/**
 * Tests — Mission v8 : secours durable Firestore (outbox) + fiabilité Groq.
 * Redis/BullMQ = chemin principal (non testé ici : pas de Redis réel dans le
 * sandbox) ; tous les scénarios dégradés sont réellement exécutés.
 * Tout est simulé (Groq + SMSGate HTTP local) — AUCUN SMS réel.
 */
process.env.LOG_LEVEL = 'error';
process.env.ROUTE_OFFLINE_HOLD = 'true';
delete process.env.REDIS_URL; // Redis INDISPONIBLE (cas prod quota/DNS)
delete process.env.OFFLINE_SMS_PROVIDER;

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra ?? null).slice(0, 240)}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Mock SMSGate (Basic : token 404) ── */
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
      return res.end(JSON.stringify({ id: [`gw-v8-${GW.posts.length}`] }));
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

/* Groq SIMULÉ avec compteur (vide d'abord, puis succès) */
let txCalls = 0;
require.cache[path.join(ROOT, 'services', 'transcriptionService.js')] = { id: 'tx', filename: path.join(ROOT, 'services/transcriptionService.js'), loaded: true, exports: {
  transcribe: async () => { txCalls++; return txCalls === 1 ? { text: '   ', method: 'test' } : { text: 'V8 transcription OK', method: 'test' }; },
} };

require.cache[path.join(ROOT, 'services', 'socketService.js')] = { id: 'sk', filename: path.join(ROOT, 'services/socketService.js'), loaded: true, exports: {
  isUserOnline: async () => false, getIO: () => null, emitToUser: () => {}, deliverPendingMessages: async () => 0,
} };
require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gws', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => false, isConfigured: () => false, sendSMS: async () => ({ success: false }), logStartupDiagnostic: () => {}, validateWebhookSignature: () => true } };

(async () => {
  const gwPort = await new Promise((r) => gwServer.listen(0, '127.0.0.1', () => r(gwServer.address().port)));
  process.env.SMS_GATEWAY_LOGIN = 'login-app';
  process.env.SMS_GATEWAY_PASSWORD = 'pass-app';
  process.env.SMS_GATEWAY_DEVICE_ID = 'zfold2';
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${gwPort}`;
  process.env.SMS_GATEWAY_DEVICE_NUMBER = '+22675405214';

  const qs = require(path.join(ROOT, 'services', 'queueService.js'));

  /* Processeurs espions (les VRAIS sont enregistrés par les workers au boot) */
  let smsRuns = 0, smsResults = [];
  qs.createWorker('sms', async ({ data }) => { smsRuns++; smsResults.push(data.messageId); return { success: true, messageId: data.messageId }; }, 1);
  let txRuns = 0;
  qs.createWorker('transcription', async () => { txRuns++; return { ok: true }; }, 1);

  /* ══ 2. SMS avec Redis INDISPONIBLE → inline + outbox durable ══ */
  let jr = await qs.addJob('sms', { to: '+22670000001', text: 'v8 #1', messageId: 'm-v8-1' });
  await sleep(150);
  check('SMS inline (Redis indispo) → exécuté + retour honnête', jr.inline === true && jr.queued === false && jr.result.success === true, jr);
  const ob1 = (await db.collection('queue_fallback').doc('sms:m-v8-1').get()).data();
  check('outbox : tâche enregistrée AVANT exécution → status done', ob1 && ob1.status === 'done' && ob1.kind === 'sms' && ob1.taskId === 'm-v8-1', ob1);

  /* ══ 7. Prévention des doubles : re-exécution d'une tâche done → bloquée ══ */
  jr = await qs.addJob('sms', { to: '+22670000001', text: 'v8 #1 re-route', messageId: 'm-v8-1' });
  check('re-exécution d une tâche done → bloquée (already_done, spy inchangé)', jr.result && jr.result.already_done === true && smsRuns === 1, { jr, smsRuns });

  /* ══ 5. Reprise après ERREUR : échec → backoff progressif → récupération ══ */
  qs.createWorker('sms', async ({ data }) => { // le même job échoue d'abord
    smsRuns++;
    if (smsRuns <= 2) return { success: false, error: 'gateway down (v8 test)' };
    smsResults.push(data.messageId);
    return { success: true, messageId: data.messageId };
  }, 1);
  jr = await qs.addJob('sms', { to: '+22670000002', text: 'v8 #2', messageId: 'm-v8-2' });
  await sleep(120);
  const ob2 = (await db.collection('queue_fallback').doc('sms:m-v8-2').get()).data();
  check('échec SMS inline → PAS « done » : attempts=1 + backoff progressif', ob2 && ob2.status === 'pending' && ob2.attempts === 1 && ob2.nextAttemptAt > Date.now() + 15000, ob2);
  const rec1 = await qs.recoverFallbackTasks({ limit: 10 }); // pas encore dû
  check('recovery avant échéance → rien ré-exécuté (anti-doublon)', smsResults.filter((m) => m === 'm-v8-2').length === 0, rec1);
  await db.collection('queue_fallback').doc('sms:m-v8-2').set({ nextAttemptAt: Date.now() - 1000 }, { merge: true }); // dû
  const rec2 = await qs.recoverFallbackTasks({ limit: 10 });
  await sleep(120);
  const ob2b = (await db.collection('queue_fallback').doc('sms:m-v8-2').get()).data();
  check('recovery après échéance → ré-exécuté UNE fois → done (1 seul SMS au total)', ob2b.status === 'done' && smsResults.filter((m) => m === 'm-v8-2').length === 1, { ob: ob2b, rec2 });

  /* ══ 3/4. Transcription inline → outbox done (Redis indisponible) ══ */
  jr = await qs.addJob('transcription', { audioPath: '/tmp/x.wav', messageId: 'm-v8-tx', userId: 'u', language: 'fr' });
  await sleep(120);
  const ob3 = (await db.collection('queue_fallback').doc('transcription:m-v8-tx').get()).data();
  check('transcription inline → done (outbox)', jr.inline === true && ob3 && ob3.status === 'done' && txRuns === 1, { jr, ob: ob3 });

  /* ══ 9. Plusieurs tâches simultanées → chacune exécutée une seule fois ══ */
  for (const mid of ['m-v8-c1', 'm-v8-c2', 'm-v8-c3']) {
    await db.collection('queue_fallback').doc(`sms:${mid}`).set({
      kind: 'sms', taskId: mid, data: { messageId: mid }, status: 'pending', attempts: 0, maxAttempts: 4, nextAttemptAt: Date.now() - 1000,
    });
  }
  const rec3 = await qs.recoverFallbackTasks({ limit: 10 });
  check('tâches simultanées → toutes traitées, chacune UNE fois', rec3.done === 3 && smsResults.filter((m) => /^m-v8-c/.test(m)).length === 3, { rec3, smsResults });

  /* ══ 6. Anti-simultané : bail valide → pas de traitement concurrent ══ */
  await db.collection('queue_fallback').doc('sms:m-v8-lock').set({
    kind: 'sms', taskId: 'm-v8-lock', data: { messageId: 'm-v8-lock' }, status: 'processing', claimUntil: Date.now() + 60000, attempts: 0, maxAttempts: 4,
  });
  const rec4 = await qs.recoverFallbackTasks({ limit: 10 });
  check('bail valide (claimUntil futur) → tâche NON reprise (pas de traitement simultané)', !smsResults.includes('m-v8-lock') && (rec4.done === 0), rec4);

  /* ══ 5.b Échecs répétés → échec DÉFINITIF borné (traçabilité) ══ */
  qs.createWorker('sms', async () => { smsRuns++; throw new Error('toujours en panne (v8)'); }, 1);
  await db.collection('queue_fallback').doc('sms:m-v8-dead').set({
    kind: 'sms', taskId: 'm-v8-dead', data: { messageId: 'm-v8-dead' }, status: 'pending', attempts: 3, maxAttempts: 4, nextAttemptAt: Date.now() - 1000,
  });
  const rec5 = await qs.recoverFallbackTasks({ limit: 10 });
  const obDead = (await db.collection('queue_fallback').doc('sms:m-v8-dead').get()).data();
  check('max attempts atteint → status failed + lastError (plus jamais retenté)', obDead.status === 'failed' && /toujours en panne/.test(obDead.lastError || '') && rec5.failed === 1, { ob: obDead, rec5 });
  const rec6 = await qs.recoverFallbackTasks({ limit: 10 });
  check('failed → ignoré par les recoveries suivants', rec6.done === 0 && rec6.failed === 0, rec6);

  /* ══ 10. Retour de Redis (preferQueue) → réintégration propre (chemin testé : inline) ══ */
  qs.createWorker('sms', async ({ data }) => { smsRuns++; smsResults.push(data.messageId); return { success: true }; }, 1);
  await db.collection('queue_fallback').doc('sms:m-v8-back').set({
    kind: 'sms', taskId: 'm-v8-back', data: { messageId: 'm-v8-back' }, status: 'pending', attempts: 0, maxAttempts: 4, nextAttemptAt: Date.now() - 1000,
  });
  const rec7 = await qs.recoverFallbackTasks({ limit: 10, preferQueue: true });
  const obBack = (await db.collection('queue_fallback').doc('sms:m-v8-back').get()).data();
  check('retour Redis (preferQueue) → tâche réintégrée puis done', obBack.status === 'done' && smsResults.includes('m-v8-back'), { ob: obBack, rec7 });

  /* ══ 6bis. Reprise après REDÉMARRAGE : modules rechargés, outbox persiste ══ */
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'queueService.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'fallbackOutbox.js'))];
  const qs2 = require(path.join(ROOT, 'services', 'queueService.js'));
  qs2.createWorker('sms', async ({ data }) => { smsRuns++; smsResults.push(data.messageId); return { success: true }; }, 1);
  const beforeRestart = smsResults.length;
  const rec8 = await qs2.recoverFallbackTasks({ limit: 10 });
  check('redémarrage → les done ne sont PAS ré-exécutés (aucun doublon)', smsResults.length === beforeRestart && rec8.done === 0, { rec8, smsRuns });

  /* ══ 8. FIABILITÉ GROQ : texte vide → 1 nouvelle tentative → SMS part ══ */
  const tw = require(path.join(ROOT, 'workers', 'transcriptionWorker.js'));
  tw.startWorker();
  const audioPath = path.join(os.tmpdir(), `v8-audio-${Date.now()}.wav`);
  fs.writeFileSync(audioPath, Buffer.alloc(2048));
  await db.collection('users').doc('u-v8-voice').set({ phone: '+22670000091', status: 'active' });
  await db.collection('messages').doc('m-v8-voice').set({
    type: 'audio', channel: 'app', status: 'pending',
    transcriptionStatus: 'pending', transcription: null, smsAfterTranscription: 'pending',
    audioUrl: audioPath, senderName: 'Ali', receiverId: 'u-v8-voice', senderId: 'u-sender',
    conversationId: 'conv-v8', createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  });
  const postsBefore = GW.posts.length;
  await tw.transcriptionProcessor({ data: { audioPath, messageId: 'm-v8-voice', userId: 'u-v8-voice', language: 'fr', collection: 'messages' } });
  await sleep(400);
  check('Groq : texte vide → 1 re-tentative de TRANSCRIPTION (2 appels)', txCalls >= 2, { txCalls });
  check('Groq : après re-tentative réussie → SMS envoyé UNE fois avec le texte', GW.posts.length === postsBefore + 1 && GW.posts[postsBefore].text.includes('V8 transcription OK'), GW.posts.slice(postsBefore));
  const voiceDoc = (await db.collection('messages').doc('m-v8-voice').get()).data();
  check('statuts : smsAfterTranscription=sent + smsMessageId + smsAcceptedAt', voiceDoc.smsAfterTranscription === 'sent' && !!voiceDoc.smsMessageId && !!voiceDoc.smsAcceptedAt, { s: voiceDoc.smsAfterTranscription });
  check('audio original conservé', fs.existsSync(audioPath));

  /* ══ Paramètres Groq réels (source) ══ */
  const ts = fs.readFileSync(path.join(ROOT, 'services', 'transcriptionService.js'), 'utf8');
  check('Groq multipart : temperature=0 + prompt français ajoutés (API réelle)', ts.includes('name="temperature"') && ts.includes('name="prompt"') && /name="temperature"\\r\\n\\r\\n0/.test(ts));

  gwServer.close();
  console.log(failures === 0 ? '\nMISSION V8 OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATALE:', e); process.exit(1); });
