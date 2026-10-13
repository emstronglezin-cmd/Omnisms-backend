'use strict';
/**
 * Tests ciblés incident SMS du 11/10/2026 :
 *   A) Erreur quota fournisseur 402 INfiniReach → échec immédiat SANS retry,
 *      message marqué 'failed' (jamais 'sent'/'delivered'), file préservée.
 *   B) Routage : en ligne → interne ; hors ligne → SMS vers le numéro RÉEL du
 *      destinataire ; externe → SMS ; dédup par messageId (jobId déterministe).
 * Aucun appel réseau : smsGateway/infobip/socketService/userResolver/queueService
 * et Firestore sont des stubs en mémoire. Aucun quota de production consommé.
 */
process.env.LOG_LEVEL = 'error';
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ── Firestore mémoire ───────────────────────────────────────── */
function makeDb() {
  const store = new Map();
  const colMap = (name) => { if (!store.has(name)) store.set(name, new Map()); return store.get(name); };
  const docRef = (col, id) => ({
    id,
    create: async (data) => { if (colMap(col).has(id)) throw new Error('ALREADY_EXISTS'); colMap(col).set(id, JSON.parse(JSON.stringify(data))); },
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), ref: docRef(col, id) }; },
    set: async (data, opts) => { const c = colMap(col); const prev = c.get(id) || {}; c.set(id, Object.assign(opts && opts.merge ? prev : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => { if (!colMap(col).has(id)) throw new Error('NOT_FOUND'); Object.assign(colMap(col).get(id), JSON.parse(JSON.stringify(data))); },
    delete: async () => { colMap(col).delete(id); },
  });
  let auto = 0;
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id || `auto-${++auto}`),
      add: async (data) => { const id = `auto-${++auto}`; colMap(name).set(id, JSON.parse(JSON.stringify(data))); return { id, ref: docRef(name, id) }; },
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
    }),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, d) => r.update(d), set: (r, d, o) => r.set(d, o), create: (r, d) => r.create(d) }),
  };
}
const db = makeDb();
{
  const p = path.join(ROOT, 'config', 'firebase.js');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: db };
}

/* ── Stubs fournisseurs & présence & résolution & file ───────── */
const gatewayState = { results: [], calls: [] };
{
  const p = path.join(ROOT, 'services', 'smsGateway.js');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: {
    isSmsGatewayProvider: () => true,
    isConfigured: () => true,
    isInfobipFallbackEnabled: () => false,
    sendSMS: async (opts) => {
      gatewayState.calls.push(opts);
      const r = gatewayState.results.shift();
      if (!r) throw new Error('stub: pas de réponse programmée');
      return r;
    },
  } };
}
{
  const p = path.join(ROOT, 'services', 'infobip.js');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { isConfigured: () => false } };
}
const presence = { online: new Set() };
let emitCalls = 0;
{
  const p = path.join(ROOT, 'services', 'socketService.js');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: {
    isUserOnline: async (uid) => presence.online.has(uid),
    getIO: () => null,
    emitToUser: () => { emitCalls++; },
  } };
}
{
  const p = path.join(ROOT, 'services', 'userResolver.js');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: {
    resolveUserByPhone: async (phone) => phone === '+22670000002'
      ? { found: true, uid: 'uid-dest-offline', phone: '+22670000002', name: 'Destinataire Offline' }
      : phone === '+22670000001'
        ? { found: true, uid: 'uid-dest-online', phone: '+22670000001', name: 'Destinataire Online' }
        : { found: false },
    resolveUserByUid: async (uid) => ({ found: true, uid, phone: uid === 'uid-dest-online' ? '+22670000001' : '+22670000002' }),
    normalizeEmail: (e) => String(e || '').toLowerCase(),
  } };
}
const queueState = { jobs: [], dlq: [] };
{
  const p = path.join(ROOT, 'services', 'queueService.js');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: {
    addSmsJob: async (data, jobOpts) => { queueState.jobs.push({ data, jobOpts }); return { jobId: jobOpts && jobOpts.jobId || `job-${queueState.jobs.length}`, queued: true }; },
    addJob: async (queue, data, opts) => { if (queue === 'sms_dlq') queueState.dlq.push({ data, opts }); return { jobId: 'dlq', queued: true }; },
    createWorker: () => ({}),
  } };
}

const router = require(path.join(ROOT, 'services', 'messageRouter.js'));
const worker = require(path.join(ROOT, 'services', 'smsQueueWorker.js'));

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? ' → ' + (extra === undefined ? '' : extra) : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
}
const msgDoc = (id) => db._store.get('messages') && db._store.get('messages').get(id);

(async () => {
  /* ── 1. Deux utilisateurs connectés → circuit interne, AUCUN SMS ── */
  presence.online.add('uid-dest-online');
  // NB : aucun stub poussé ici — si un SMS partait à tort, le stub léverait une exception et le test échouerait.
  let r = await router.routeMessage({ senderUid: 'uid-sender', targetPhone: '+22670000001', content: 'salut', type: 'text', senderName: 'Emmanuel' });
  check('1. connecté → route OMNISMS', r.route === 'OMNISMS', r.route);
  check('1. aucun appel SMS, livraison Socket.IO émise', gatewayState.calls.length === 0 && queueState.jobs.length === 0 && emitCalls === 1,
    `sms=${gatewayState.calls.length} jobs=${queueState.jobs.length} emit=${emitCalls}`);
  check('1. message enregistré channel=app status=sent', (() => { const m = msgDoc(r.messageId); return m && m.channel === 'app' && m.status === 'sent'; })());
  presence.online.delete('uid-dest-online');

  /* ── 2. Reconnexion / présence temporairement absente → fallback SMS policy ── */
  // (destinataire résolu mais absent de la présence → SMS vers son numéro RÉEL, jamais l'expéditeur)
  gatewayState.results.push({ success: true, messageId: 'gw-2', state: 'queued' });
  r = await router.routeMessage({ senderUid: 'uid-sender', senderPhone: '+226765555111', targetPhone: '+22670000002', content: 'offline msg', type: 'text', senderName: 'Emmanuel' });
  check('2. hors ligne → route SMS_EXTERNE', r.route === 'SMS_EXTERNE', r.route);
  check('2. SMS vers le numéro RÉEL du destinataire', gatewayState.calls[0] && gatewayState.calls[0].to === '+22670000002', gatewayState.calls[0] && gatewayState.calls[0].to);
  check('2. message status=sent après succès fournisseur', (() => { const m = msgDoc(r.messageId); return m && m.status === 'sent'; })());

  /* ── 3. Destinataire externe → SMS direct ── */
  gatewayState.results.push({ success: true, messageId: 'gw-3', state: 'queued' });
  r = await router.routeMessage({ senderUid: 'uid-sender', targetPhone: '+22676555599', content: 'external', type: 'text', senderName: 'Emmanuel' });
  check('3. externe → SMS vers le numéro fourni', r.route === 'SMS_EXTERNE' && gatewayState.calls[1] && gatewayState.calls[1].to === '+22676555599', gatewayState.calls[1] && gatewayState.calls[1].to);

  /* ── 4/5. Réponse fournisseur 402 (quota) ── */
  // a) Chemin direct (routeur) : marqué failed, AUCUNE tâche de retry
  const jobsBefore = queueState.jobs.length;
  gatewayState.results.push({ success: false, statusCode: 402, error: '402 Free plan message limit reached (100 messages/month) - upgrade to send more' });
  r = await router.routeMessage({ senderUid: 'uid-sender', targetPhone: '+22676555444', content: 'quota test', type: 'text', senderName: 'Emmanuel' });
  check('5a. 402 direct → message status=failed (jamais livré)', (() => { const m = msgDoc(r.messageId); return m && m.status === 'failed' && m.quotaExceeded === true; })(),
    msgDoc(r.messageId) && msgDoc(r.messageId).status);
  check('5a. 402 direct → smsError QUOTA_EXCEEDED', (() => { const m = msgDoc(r.messageId); return m && String(m.smsError || '').startsWith('QUOTA_EXCEEDED'); })());
  check('5a. 402 direct → aucune tâche de retry créée', queueState.jobs.length === jobsBefore, `jobs ${jobsBefore}→${queueState.jobs.length}`);

  // b) Worker : 402 → pas de throw (pas de retry BullMQ), failed immédiat dès la 1re tentative
  const dbMsg = db.collection('messages');
  await dbMsg.add({ status: 'pending' }).then ? null : null;
  const added = await (async () => { const res = await db.collection('messages').add({ status: 'pending' }); return res.id; })();
  gatewayState.results.push({ success: false, statusCode: 402, error: '402 Free plan message limit reached (100 messages/month) - upgrade to send more' });
  let threw = null, out = null;
  try { out = await worker.processSmsJob({ id: 'job-402', data: { to: '+22676555444', text: 'x', messageId: added }, attemptsMade: 0 }); }
  catch (e) { threw = e; }
  check('5b. worker 402 → aucun throw (pas de retry BullMQ)', !threw, threw && threw.message);
  check('5b. worker 402 → résultat nonRetryable', out && out.quotaExceeded === true && out.nonRetryable === true, out);
  check('5b. worker 402 → message failed dès la 1re tentative', (() => { const m = msgDoc(added); return m && m.status === 'failed' && m.quotaExceeded === true; })());

  /* ── 6. Erreur NON-quota → comportement de retry préservé ── */
  const added2 = (await db.collection('messages').add({ status: 'pending' })).id;
  gatewayState.results.push({ success: false, statusCode: 503, error: 'device offline' });
  threw = null;
  try { await worker.processSmsJob({ id: 'job-503-a', data: { to: '+22676555444', text: 'x', messageId: added2 }, attemptsMade: 0 }); } catch (e) { threw = e; }
  check('6a. erreur 503 (tentative 0) → throw = retry BullMQ conservé', !!threw, threw && threw.message);
  check('6a. erreur 503 (tentative 0) → message NON marqué failed (attend dernière tentative)', (() => { const m = msgDoc(added2); return m && m.status === 'pending'; })(), msgDoc(added2) && msgDoc(added2).status);
  gatewayState.results.push({ success: false, statusCode: 503, error: 'device offline' });
  threw = null;
  try { await worker.processSmsJob({ id: 'job-503-b', data: { to: '+22676555444', text: 'x', messageId: added2 }, attemptsMade: 2 }); } catch (e) { threw = e; }
  check('6b. erreur 503 (tentative 2 = dernière) → throw + status=failed', !!threw && (() => { const m = msgDoc(added2); return m && m.status === 'failed'; })());
  check('6b. échec final → job archivé en DLQ (sms_dlq)', queueState.dlq.length >= 1 && queueState.dlq[queueState.dlq.length - 1].data.data.messageId === added2, queueState.dlq.length);
  await worker.enqueueSmsJob({ to: '+22676555444', text: 'p', messageId: 'm-prio-n' });
  await worker.enqueueSmsJob({ to: '+22676555444', text: 'p', messageId: 'm-prio-c', priority: 'critical' });
  const pn = queueState.jobs[queueState.jobs.length - 2].jobOpts.priority;
  const pc = queueState.jobs[queueState.jobs.length - 1].jobOpts.priority;
  check('priorités BullMQ (critical=1 avant normal=5)', pn === 5 && pc === 1, { pn, pc });

  /* ── 7. Déduplication : même message → même jobId BullMQ ── */
  await worker.enqueueSmsJob({ to: '+22676555444', text: 'a', messageId: 'msg-dedup' });
  await worker.enqueueSmsJob({ to: '+22676555444', text: 'a', messageId: 'msg-dedup' });
  const ids = queueState.jobs.slice(-2).map(j => j.jobOpts && j.jobOpts.jobId);
  check('7. dédup : jobId déterministe sms-<messageId> (2 appels → même clé)', ids[0] === 'sms-msg-dedup' && ids[1] === 'sms-msg-dedup', ids);
  const added3 = (await db.collection('messages').add({ status: 'pending' })).id;
  gatewayState.results.push({ success: true, messageId: 'gw-9', state: 'QUEUED' });
  await worker.processSmsJob({ id: 'job-ok', data: { to: '+22676555444', text: 'x', messageId: added3 }, attemptsMade: 0 });
  const mOk = msgDoc(added3);
  check('7. succès worker → status=sent (jamais "delivered" prématuré)', !!mOk && mOk.status === 'sent' && !mOk.delivered, mOk && mOk.status);

  console.log(failures === 0 ? '\nTOUS LES TESTS INCIDENT SMS PASSSENT' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
