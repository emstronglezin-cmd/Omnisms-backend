'use strict';
/* Phases pour test/stabilisation-tests.js — chaque phase = sous-processus propre. */
const { installFakes } = require('./helpers/redis-quota-fakes');
const path = require('path');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUOTA_ROOT = path.join(__dirname, '..');

function stubCore(opts = {}) {
  // Stubs minimaux pour booter server.js / smsQueueWorker sans services externes.
  function makeDb() {
    const store = new Map();
    const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
    let auto = 0;
    return {
      _store: store, _stub: true,
      collection: (name) => ({
        doc: (id) => ({ id: id || `auto-${++auto}`,
          get: async () => { const d = colMap(name).get(id); return { exists: !!d, id, data: () => d }; },
          set: async (data) => colMap(name).set(id || `auto-${++auto}`, { ...data }),
          update: async (data) => colMap(name).set(id, { ...(colMap(name).get(id) || {}), ...data }),
          delete: async () => colMap(name).delete(id) }),
        add: async (data) => { const id = `auto-${++auto}`; colMap(name).set(id, data); return { id }; },
        where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [], size: 0 }) }) }),
      }),
    };
  }
  require.cache[require.resolve(path.join(QUOTA_ROOT, 'config', 'firebase.js'))] = { id: 'fb', filename: path.join(QUOTA_ROOT, 'config/firebase.js'), loaded: true, exports: makeDb() };
  require.cache[require.resolve(path.join(QUOTA_ROOT, 'services', 'smsGateway.js'))] = { id: 'gw', filename: path.join(QUOTA_ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => true, isConfigured: () => false, sendSMS: async () => ({ success: false }), logStartupDiagnostic: () => {}, validateWebhookSignature: () => true, getConfig: () => ({}) } };
  if (!opts.realQueueService) {
    require.cache[require.resolve(path.join(QUOTA_ROOT, 'services', 'queueService.js'))] = { id: 'qs', filename: path.join(QUOTA_ROOT, 'services/queueService.js'), loaded: true, exports: { addJob: async () => ({}), addSmsJob: async () => ({}), addTranscriptionJob: async () => ({}), createWorker: () => null, getQueueStatus: () => ({ mode: 'inline-stub' }), registerInlineHandler: () => {} } };
  }
}

function req(port, method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(`http://127.0.0.1:${port}${url}`, { method, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode }));
    });
    r.on('error', reject); r.end();
  });
}

(async () => {
  const phase = process.argv[2];
  const out = {};

  /* ── Webhook : signature stricte / permissive (appel unitaire direct) ── */
  if (phase === 'webhook') {
    delete process.env.SMS_GATEWAY_WEBHOOK_SECRET;
    delete process.env.SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE;
    const gw = require(path.join(QUOTA_ROOT, 'services', 'smsGateway'));
    const noSig = { headers: {}, rawBody: '{"a":1}' };
    out.r1_permissiveNoSecret = gw.validateWebhookSignature(noSig) === true;
    process.env.SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE = 'true';
    out.r2_strictNoSecretRejected = gw.validateWebhookSignature(noSig) === false; // NOUVEAU comportement
    process.env.SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE = '';
    process.env.SMS_GATEWAY_WEBHOOK_SECRET = 'sekret-test';
    const crypto = require('crypto');
    const body = '{"event":"sms.delivered","id":"m1"}';
    const good = crypto.createHmac('sha256', 'sekret-test').update(body).digest('hex');
    out.r3_validHmacAccepted = gw.validateWebhookSignature({ headers: { 'x-signature': good }, rawBody: body }) === true;
    out.r4_badHmacRejected = gw.validateWebhookSignature({ headers: { 'x-signature': 'deadbeef' }, rawBody: body }) === false;
    // Comportement historique documenté : secret configuré + signature absente
    // = permissif par défaut (transition douce) ; le strict passe par REQUIRE.
    out.r5_missingSigPermissiveByDefault = gw.validateWebhookSignature({ headers: {}, rawBody: body }) === true;
    process.env.SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE = 'true';
    out.r6_missingSigStrictRejected = gw.validateWebhookSignature({ headers: {}, rawBody: body }) === false;
    process.env.SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE = '';
  }

  /* ── drainDelay configurable ── */
  if (phase === 'drain') {
    const F = installFakes();
    process.env.REDIS_URL = 'redis://fake:6379';
    const qs = require(path.join(QUOTA_ROOT, 'services', 'queueService'));
    await sleep(60);
    process.env.QUEUE_DRAIN_DELAY_MS = '10';
    qs.createWorker('q-a', async () => {}, 1);
    delete process.env.QUEUE_DRAIN_DELAY_MS;
    qs.createWorker('q-b', async () => {}, 1);
    out.withEnv = F.workers.find((w) => w.name === 'q-a').opts.drainDelay;
    out.withoutEnv = F.workers.find((w) => w.name === 'q-b').opts.drainDelay;
  }

  /* ── /api/diag protégé quand ADMIN_KEY configurée ── */
  if (phase === 'diag-gate' || phase === 'diag-open') {
    if (phase === 'diag-gate') process.env.ADMIN_KEY = 'testkey123';
    stubCore();
    process.env.PORT = '5076';
    process.env.JWT_SECRET = 'stabilisation-secret';
    process.env.LOG_LEVEL = 'error';
    require(path.join(QUOTA_ROOT, 'server.js'));
    await sleep(1500);
    if (phase === 'diag-gate') {
      out.noHeader = (await req('5076', 'GET', '/api/diag')).status;
      out.badHeader = (await req('5076', 'GET', '/api/diag', { 'x-admin-key': 'wrong' })).status;
      out.goodHeader = (await req('5076', 'GET', '/api/diag', { 'x-admin-key': 'testkey123' })).status;
    } else {
      out.noHeader = (await req('5076', 'GET', '/api/diag')).status; // compat historique
    }
  }

  /* ── Flags workers ── */
  if (phase === 'sms-worker-off' || phase === 'sms-worker-on') {
    const F = installFakes();
    process.env.REDIS_URL = 'redis://fake:6379';
    stubCore({ realQueueService: true }); // vrai queueService sur fake bullmq
    if (phase === 'sms-worker-off') process.env.QUEUE_SMS_WORKER = 'false';
    const qs = require(path.join(QUOTA_ROOT, 'services', 'queueService'));
    const { startSmsWorker } = require(path.join(QUOTA_ROOT, 'services', 'smsQueueWorker'));
    await sleep(60);
    startSmsWorker();
    await sleep(60);
    out.bullmqWorkers = F.workers.length;
    out.statusWorkers = qs.getQueueStatus().workers.length;
  }

  if (phase === 'tx-worker-off') {
    const F = installFakes();
    process.env.REDIS_URL = 'redis://fake:6379';
    require.cache[require.resolve(path.join(QUOTA_ROOT, 'services', 'transcriptionService.js'))] = { id: 'ts', filename: path.join(QUOTA_ROOT, 'services/transcriptionService.js'), loaded: true, exports: { transcribe: async () => ({ text: '' }) } };
    process.env.QUEUE_TRANSCRIPTION_WORKER = 'false';
    const { startWorker } = require(path.join(QUOTA_ROOT, 'workers', 'transcriptionWorker.js'));
    out.result = startWorker();
    out.bullmqWorkers = F.workers.length;
  }

  console.log('RESULT ' + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error('PHASE ERROR', e.message); process.exit(1); });
