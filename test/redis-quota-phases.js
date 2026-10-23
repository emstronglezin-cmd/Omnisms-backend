'use strict';
/* Phase de test quota Redis — exécuté en sous-processus par redis-quota-tests.js */
const { installFakes } = require('./helpers/redis-quota-fakes');
const F = installFakes(); // AVANT tout require de queueService

process.env.REDIS_URL = process.env.REDIS_URL || 'redis://fake:6379';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUOTA_ERR = () => new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500000');

async function boot() {
  const qs = require('../services/queueService');
  await sleep(80); // laisse les 'ready' émis
  return qs;
}

(async () => {
  const phase = process.argv[2];
  const qs = await boot();
  const out = {};

  if (phase === 'boot') {
    const st = qs.getQueueStatus();
    out.mode = st.mode; out.quotaExhausted = st.quotaExhausted;
    qs.registerInlineHandler('sms', async ({ data }) => ({ ok: true, data }));
    const r = await qs.addSmsJob({ messageId: 'm1' }, { jobId: 'sms-m1' });
    out.queued = r.queued;
    out.jobIdPassthrough = F.added[0] && F.added[0].o && F.added[0].o.jobId;
    // opts au niveau JOB (troisième paramètre de q.add) — là où addSmsJob
    // pose attempts/backoff ; defaultJobOptions de la queue servent de base.
    const jo = (F.added[0] && F.added[0].o) || {};
    out.attempts = jo.attempts;
    out.backoffType = jo.backoff && jo.backoff.type;
    out.backoffDelay = jo.backoff && jo.backoff.delay;
    const q = qs.getQueue('sms');
    const d = q && q.opts && q.opts.defaultJobOptions;
    out.queueAttempts = d && d.attempts;
    qs.createWorker('transcription', async () => {}, 1);
    const w = F.workers[0];
    out.skipStalledCheck = w && w.opts.skipStalledCheck;
    out.lockDuration = w && w.opts.lockDuration;
    out.concurrency = w && w.opts.concurrency;
  }

  if (phase === 'breaker') {
    qs.registerInlineHandler('sms', async ({ data }) => ({ ok: true, data }));
    await qs.addSmsJob({ messageId: 'm1' }, { jobId: 'sms-m1' }); // 1 job en file
    qs.createWorker('sms', async () => {}, 2);
    out.addedBeforeQuota = F.added.length;
    F.redisInstances[0].emit('error', QUOTA_ERR());
    await sleep(120);
    const st = qs.getQueueStatus();
    out.modeAfter = st.mode;
    out.quotaExhausted = st.quotaExhausted;
    out.closedWorkers = F.closedWorkers;
    out.disconnects = F.disconnectCount;
    // retry du même job après quota → inline honnête
    const r2 = await qs.addSmsJob({ messageId: 'm1' }, { jobId: 'sms-m1' });
    out.inlineRetry = r2.queued === false && r2.inline === true;
    out.inlineResultOk = !!(r2.result && r2.result.ok);
    out.addedAfterQuota = F.added.length;
    // job sans handler inline → échec honnête
    const rt = await qs.addTranscriptionJob({ audioPath: 'x' });
    out.honestFail = rt.queued === false && !rt.inline && !!rt.error;
    // erreur quota en plein addJob
    F.addError = QUOTA_ERR();
    const r3 = await qs.addSmsJob({ messageId: 'm3' }, { jobId: 'sms-m3' });
    F.addError = null;
    out.midFlightInline = r3.queued === false && r3.inline === true;
    // pas de boucle : aucune commande ni ajout pendant 400 ms
    const ping0 = F.pingCount, added0 = F.added.length, dc0 = F.disconnectCount;
    await sleep(400);
    out.pingCount = F.pingCount;
    out.stableAfter400 = F.pingCount === ping0 && F.added.length === added0 && F.disconnectCount === dc0;
  }

  if (phase === 'recovery') {
    qs.createWorker('sms', async () => {}, 1);
    const wBefore = F.workers.length;
    F.redisInstances[0].emit('error', QUOTA_ERR());
    await sleep(120);
    out.quotaHit = qs.getQueueStatus().quotaExhausted === true;
    await sleep(1500); // ≥ 1 sonde (300 ms)
    const st = qs.getQueueStatus();
    out.modeAfter = st.mode;
    out.quotaExhausted = st.quotaExhausted;
    out.workersAfter = F.workers.length - wBefore;
    out.pingCount = F.pingCount;
  }

  if (phase === 'forced-inline') {
    out.instances = F.redisInstances.length;
    const st = qs.getQueueStatus();
    out.mode = st.mode;
    qs.registerInlineHandler('sms', async ({ data }) => ({ ok: true, data }));
    const r = await qs.addSmsJob({ messageId: 'm1' }, { jobId: 'sms-m1' });
    out.inlineOk = r.queued === false && r.inline === true && r.result.ok === true;
  }

  console.log('RESULT ' + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error('PHASE ERROR', e); process.exit(1); });
