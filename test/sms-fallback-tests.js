'use strict';
/**
 * Tests — Routage automatique V3.2 : interne / secours SMS consenti (AUTO
 * par défaut, opt-out) / vocal hors ligne → transcription → SMS texte.
 * SMSGate + Groq simulés — AUCUN SMS réel, AUCUN appel Groq réel.
 */
process.env.LOG_LEVEL = 'error';
process.env.ROUTE_OFFLINE_HOLD = 'true';
delete process.env.REDIS_URL;
delete process.env.OFFLINE_SMS_PROVIDER;

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

/* Groq SIMULÉ (contrôlé) */
global.__TX = { mode: 'ok', text: 'Voici le plan pour demain midi' };
require.cache[path.join(ROOT, 'services', 'transcriptionService.js')] = { id: 'tx', filename: path.join(ROOT, 'services/transcriptionService.js'), loaded: true, exports: {
  transcribe: async () => {
    if (global.__TX.mode === 'fail') throw new Error('Groq indisponible (test)');
    if (global.__TX.mode === 'empty') return { text: '   ', method: 'test' };
    return { text: global.__TX.text, method: 'test' };
  },
} };

const presence = { online: new Set(['uid-online-audio']) };
require.cache[path.join(ROOT, 'services', 'socketService.js')] = { id: 'sk', filename: path.join(ROOT, 'services/socketService.js'), loaded: true, exports: {
  isUserOnline: async (uid) => presence.online.has(uid), getIO: () => null, emitToUser: () => {}, deliverPendingMessages: async () => 0,
} };
const PHONE_MAP = {
  '+22670000001': 'uid-0001', '+22670000002': 'uid-0002', '+22670000003': 'uid-0003',
  '+22670000004': 'uid-0004', '+22670000005': 'uid-0005', '+22670000006': 'uid-0006',
  '+22670000007': 'uid-0007', '+22670000009': 'uid-online-audio',
};
require.cache[path.join(ROOT, 'services', 'userResolver.js')] = { id: 'ur', filename: path.join(ROOT, 'services/userResolver.js'), loaded: true, exports: {
  resolveUserByPhone: async (phone) => (PHONE_MAP[phone] ? { found: true, uid: PHONE_MAP[phone], phone } : { found: false }),
  resolveUserByUid: async (uid) => ({ found: true, uid }),
  normalizeEmail: (e) => String(e || '').toLowerCase(),
} };

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra ?? null).slice(0, 240)}`);
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
  const { startWorker } = require(path.join(ROOT, 'workers', 'transcriptionWorker.js'));
  startSmsWorker(); // inline (sans Redis)
  startWorker();    // enregistre le handler inline 'transcription'
  await new Promise((r) => setTimeout(r, 100));

  /* Comptes */
  await db.collection('users').doc('uid-0001').set({ phone: '+22670000001', phoneVerified: true, smsFallbackEnabled: true });
  await db.collection('users').doc('uid-0002').set({ phone: '+22670000002', phoneVerified: true, smsFallbackEnabled: false }); // opt-out
  await db.collection('users').doc('uid-0003').set({ phone: '+22670000003', phoneVerified: false, smsFallbackEnabled: true });
  await db.collection('users').doc('uid-0004').set({ phone: '+22670000004', phoneVerified: true }); // SANS champ → AUTO
  await db.collection('users').doc('uid-0005').set({ phone: '+22670000005', phoneVerified: true }); // vocal
  await db.collection('users').doc('uid-0006').set({ phone: '+22670000006', phoneVerified: true }); // vocal transcription vide
  await db.collection('users').doc('uid-0007').set({ phone: '+22670000007', phoneVerified: true }); // vocal Groq en échec
  await db.collection('users').doc('uid-online-audio').set({ phone: '+22670000009', phoneVerified: true });

  const base = { senderUid: 'uid-sender', content: 'Salut, appel-moi en revenant', type: 'text', senderName: 'Awa', senderPhone: '+22670000099' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ── 1. CAS A : connecté → interne, 0 SMS ── */
  let r = await router.routeMessage({ ...base, targetPhone: '+22670000009' });
  check('CAS A connecté → route OMNISMS, 0 POST SMSGate', r.route === 'OMNISMS' && MOCK.posts.length === 0, { r: r.route, n: MOCK.posts.length });

  /* ── 2. CAS B : hors ligne + opt-in explicite → SMSGate ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22670000001' });
  check('CAS B opt-in → smsFallback sent', r.smsFallback && r.smsFallback.status === 'sent', r.smsFallback);
  check('CAS B → 1 POST SMSGate (Device ID zfold2)', MOCK.posts.length === 1 && MOCK.posts[0].deviceId === 'zfold2', MOCK.posts[0]);
  check('CAS B → numéro persisté du compte (jamais l UID)', MOCK.posts[0].to === '+22670000001', MOCK.posts[0]);

  /* ── 3. Anti-doublon : même message logique ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22670000001', messageId: r.messageId });
  check('re-route même message → already_handled, 0 nouveau POST', MOCK.posts.length === 1 && r.smsFallback.reason === 'already_handled', { n: MOCK.posts.length, s: r.smsFallback });

  /* ── 4. Opt-out explicite → conservé, 0 SMS ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22670000002' });
  check('opt-out → skipped:recipient_opted_out + message conservé', r.held === true && r.smsFallback.reason === 'recipient_opted_out', r.smsFallback);
  check('opt-out → toujours 1 POST', MOCK.posts.length === 1, MOCK.posts.length);

  /* ── 5. Numéro non vérifié → jamais de SMS ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22670000003' });
  check('non vérifié → skipped:phone_unverified, 0 POST de plus', r.smsFallback.reason === 'phone_unverified' && MOCK.posts.length === 1, r.smsFallback);

  /* ── 6. NOUVEAU DÉFAUT AUTO : compte vérifié SANS champ → SMSGate ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22670000004' });
  check('AUTO (sans champ) → smsFallback sent', r.smsFallback && r.smsFallback.status === 'sent', r.smsFallback);
  check('AUTO → POST #2 vers le numéro du compte', MOCK.posts.length === 2 && MOCK.posts[1].to === '+22670000004', MOCK.posts[1]);

  /* ── 7. Interrupteur global ── */
  process.env.SMS_FALLBACK_ENABLED = 'false';
  r = await router.routeMessage({ ...base, targetPhone: '+22670000001', messageId: `m-g-${Date.now()}` });
  process.env.SMS_FALLBACK_ENABLED = 'true';
  check('global off → skipped:disabled_globally', r.smsFallback.reason === 'disabled_globally', r.smsFallback);

  /* ── 8. CAS C : externe → SMS direct ── */
  r = await router.routeMessage({ ...base, targetPhone: '+22677000077' });
  await sleep(120);
  check('CAS C externe → SMS_EXTERNE + POST', r.route === 'SMS_EXTERNE' && MOCK.posts.length === 3, { route: r.route, n: MOCK.posts.length });

  /* ── 9. VOCAL hors ligne → transcription → SMS texte ── */
  const audioFile = path.join(os.tmpdir(), `omnisms-fb-test-${Date.now()}.ogg`);
  fs.writeFileSync(audioFile, 'RIFF____WAVEfmt (audio de test — jamais un vrai appel Groq)');
  r = await router.routeMessage({ ...base, type: 'audio', content: null, audioUrl: audioFile, targetPhone: '+22670000005' });
  check('vocal hors ligne + éligible → armed (transcription_then_sms)', r.smsFallback && r.smsFallback.status === 'armed', r.smsFallback);
  await sleep(400); // laisse le job inline (transcription + reprise) s'exécuter
  const vocal = MOCK.posts.find((p) => p.text.startsWith('[OmniSMS Vocal] Awa'));
  check('vocal → SMS texte transcrit via SMSGate', !!vocal, MOCK.posts.map((p) => p.text));
  check('vocal → texte borné ≤160 + destinataire vérifié du compte', !!vocal && vocal.to === '+22670000005' && vocal.text.length <= 160, vocal);
  const msgVocal = [...db._store.get('messages').values()].find((d) => d.smsAfterTranscription);
  check('vocal → lien transcription/SMS tracé (smsAfterTranscription=sent)', !!msgVocal && msgVocal.smsAfterTranscription === 'sent', msgVocal && { s: msgVocal.smsAfterTranscription });
  check('fichier audio original NON supprimé après transcription', fs.existsSync(audioFile));

  /* ── 10. Transcription vide → AUCUN SMS vide ── */
  global.__TX.mode = 'empty';
  r = await router.routeMessage({ ...base, type: 'audio', content: null, audioUrl: audioFile, targetPhone: '+22670000006' });
  await sleep(400);
  const m6 = [...db._store.get('messages').values()].find((d) => d.smsAfterTranscription === 'skipped_empty_transcription');
  check('transcription vide → aucun SMS (erreur enregistrée)', !!m6 && MOCK.posts.filter((p) => p.text.startsWith('[OmniSMS Vocal]')).length === 1, { n: MOCK.posts.length });

  /* ── 11. Groq en échec → message conservé, repriable, aucun SMS ── */
  global.__TX.mode = 'fail';
  r = await router.routeMessage({ ...base, type: 'audio', content: null, audioUrl: audioFile, targetPhone: '+22670000007' });
  await sleep(400);
  global.__TX.mode = 'ok';
  const m7 = [...db._store.get('messages').values()].find((d) => d.smsAfterTranscription === 'pending' && d.transcriptionStatus === 'error');
  check('Groq échoué → aucun SMS, message conservé repriable (pending)', !!m7, m7 && { s: m7.smsAfterTranscription, t: m7.transcriptionStatus });

  /* ── 12. Vocal vers un CONNECTÉ → vocal original, pas de transcription-SMS ── */
  const nBefore = MOCK.posts.length;
  r = await router.routeMessage({ ...base, type: 'audio', content: null, audioUrl: audioFile, targetPhone: '+22670000009' });
  await sleep(300);
  check('vocal connecté → original livré en interne (aucun SMS vocal)', r.route === 'OMNISMS' && MOCK.posts.length === nBefore, { route: r.route, n: MOCK.posts.length });

  /* ── 13. Consentement modifiable ── */
  await db.collection('users').doc('uid-0002').set({ smsFallbackEnabled: true }, { merge: true });
  r = await router.routeMessage({ ...base, targetPhone: '+22670000002', messageId: `m-consent-${Date.now()}` });
  check('opt-out annulé → secours fonctionne', r.smsFallback.status === 'sent' && MOCK.posts.length === nBefore + 1, r.smsFallback);

  /* ── 14. Vocal vers un EXTERNE (mécanisme SESSION 13 existant) → SMS texte ── */
  const nExt = MOCK.posts.length;
  r = await router.routeMessage({ ...base, type: 'audio', content: null, audioUrl: audioFile, targetPhone: '+22677000088' });
  await sleep(300);
  const extVocal = MOCK.posts.slice(nExt).find((p) => p.text.startsWith('[OmniSMS Vocal]'));
  check('vocal externe → transcription puis SMS (mécanisme existant)', r.route === 'SMS_EXTERNE' && !!extVocal, { route: r.route, posts: MOCK.posts.slice(nExt) });

  /* ── 15. SMSGate INDISPONIBLE → échec honnête, message conservé, pas de faux succès ── */
  const goodAddr = process.env.SMS_GATEWAY_SERVER_ADDRESS;
  process.env.SMS_GATEWAY_SERVER_ADDRESS = 'http://127.0.0.1:1'; // port refusé
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'smsGateProvider.js'))];
  r = await router.routeMessage({ ...base, targetPhone: '+22670000004', messageId: `m-dead-${Date.now()}` });
  process.env.SMS_GATEWAY_SERVER_ADDRESS = goodAddr;
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'smsGateProvider.js'))];
  check('SMSGate mort → smsFallback failed (jamais « sent »)', r.smsFallback && r.smsFallback.status === 'failed' && r.smsFallback.reason === 'send_failed', r.smsFallback);
  check('SMSGate mort → message TOUJOURS conservé (held)', r.held === true && r.status === 'pending', { held: r.held, status: r.status });

  console.log(failures === 0 ? '\nROUTAGE AUTOMATIQUE V3.2 OK' : `\n${failures} ÉCHEC(S)`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
});
