'use strict';
/**
 * Tests d'intégration — hooks de facturation dans messageRouter/smsQueueWorker
 * avec CREDITS_ENABLED=true (mode facturé).
 * Vérifie : refus solde insuffisant (jamais envoyé aux frais de la maison),
 * réservation→capture au succès, conservation de la réservation pendant les
 * retries BullMQ, remboursement sur 402 et sur échec final.
 */
process.env.LOG_LEVEL = 'error';
process.env.CREDITS_ENABLED = 'true';
process.env.FREE_SMS_QUOTA = '5';
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');

function makeDb() {
  const store = new Map();
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => { if (!colMap(col).has(id)) throw new Error('NOT_FOUND'); Object.assign(colMap(col).get(id), JSON.parse(JSON.stringify(data))); },
    create: async (data) => { if (colMap(col).has(id)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }); colMap(col).set(id, JSON.parse(JSON.stringify(data))); },
    delete: async () => colMap(col).delete(id),
  });
  const applyFilters = (docs, filters) => docs.filter(([, d]) => filters.every(([f, , v]) => d[f] === v));
  let auto = 0;
  let chain = Promise.resolve();
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id || `auto-${++auto}`),
      add: async (data) => { const id = `auto-${++auto}`; colMap(name).set(id, JSON.parse(JSON.stringify(data))); return { id }; },
      where: (f, op, v) => {
        const filters = [[f, op, v]];
        const chainable = {
          where: (f2, op2, v2) => { filters.push([f2, op2, v2]); return chainable; },
          limit: () => ({ get: async () => ({ docs: applyFilters([...colMap(name).entries()], filters).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)) })) }) }),
          get: async () => ({ docs: applyFilters([...colMap(name).entries()], filters).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)) })) }),
        };
        return chainable;
      },
    }),
    runTransaction: (fn) => {
      const run = chain.then(() => fn({ get: (r) => r.get(), update: (r, d) => r.update(d), set: (r, d) => r.set(d), create: (r, d) => r.create(d) }));
      chain = run.catch(() => {});
      return run;
    },
  };
}
const db = makeDb();
require.cache[path.join(ROOT, 'config/firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: db };

const gwState = { results: [], calls: [] };
require.cache[path.join(ROOT, 'services/smsGateway.js')] = {
  id: 'gw', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true,
  exports: {
    isSmsGatewayProvider: () => true,
    isConfigured: () => true,
    isInfobipFallbackEnabled: () => false,
    sendSMS: async (o) => { gwState.calls.push(o); const r = gwState.results.shift(); if (!r) throw new Error('stub: pas de réponse'); return r; },
  },
};
require.cache[path.join(ROOT, 'services/infobip.js')] = { id: 'ib', filename: path.join(ROOT, 'services/infobip.js'), loaded: true, exports: { isConfigured: () => false } };
require.cache[path.join(ROOT, 'services/socketService.js')] = {
  id: 'so', filename: path.join(ROOT, 'services/socketService.js'), loaded: true,
  exports: { isUserOnline: async () => false, getIO: () => null, emitToUser: () => {} },
};
require.cache[path.join(ROOT, 'services/userResolver.js')] = {
  id: 'ur', filename: path.join(ROOT, 'services/userResolver.js'), loaded: true,
  exports: {
    resolveUserByPhone: async (p) => (p === '+22670000001' ? { found: true, uid: 'uid-sender', phone: p } : { found: false }),
    resolveUserByUid: async (uid) => ({ found: true, uid, phone: '+22670000099' }),
    normalizeEmail: (e) => String(e || '').toLowerCase(),
  },
};
const queueState = { jobs: [] };
require.cache[path.join(ROOT, 'services/queueService.js')] = {
  id: 'qs', filename: path.join(ROOT, 'services/queueService.js'), loaded: true,
  exports: {
    addSmsJob: async (data, jobOpts) => { queueState.jobs.push({ data, jobOpts }); return { jobId: (jobOpts && jobOpts.jobId) || `j${queueState.jobs.length}`, queued: true }; },
    createWorker: () => ({}),
  },
};

const router = require(path.join(ROOT, 'services', 'messageRouter.js'));
const worker = require(path.join(ROOT, 'services', 'smsQueueWorker.js'));
const ledger = require(path.join(ROOT, 'services', 'creditLedger.js'));
const billing = require(path.join(ROOT, 'services', 'creditBilling.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? ' → ' + (extra === undefined ? '' : extra) : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};
const ledgerEntry = (id) => db._store.get('credit_ledger') && db._store.get('credit_ledger').get(id);

(async () => {
  /* ── 1. Solde insuffisant → refus, aucun appel passerelle, SMS d'explication ── */
  const replies = [];
  const sendReply = async (o) => { replies.push(o); return { success: true, messageId: 'sys-1' }; };
  // notifyInsufficientBalance attend une fonction passée par le routeur — on stub
  // via l'absence de crédits + quota gratuit déjà consommé.
  for (let i = 0; i < 5; i++) await billing.consumeFreeUnit(db, '+22670000001'); // épuise le gratuit
  await ledger.grantPurchase(db, { uid: 'uid-sender', credits: 1, reference: 'seed-1' }); // solde 1
  gwState.results.push({ success: true, messageId: 'g-1', state: 'queued' });
  const r1 = await router.routeMessage({ senderUid: 'uid-sender', senderPhone: '+22670000001', targetPhone: '+22676555444', content: 'x'.repeat(300), type: 'text', senderName: 'E' });
  // 300 chars GSM-7 → 2 segments ; solde 1 → refus
  check('solde 1 < 2 segments → refus INSUFFICIENT_CREDITS', r1.smsResult && r1.smsResult.error === 'INSUFFICIENT_CREDITS' && r1.billing && r1.billing.refused === 'INSUFFICIENT_CREDITS', r1.billing);
  // Le refus envoie par design UN SMS système explicite à l EXPÉDITEUR (pas au destinataire).
  check('refus → 1 seul SMS système (explication) vers expéditeur, message failed',
    gwState.calls.length === 1 && gwState.calls[0].to === '+22670000001' && /insuffisant/i.test(gwState.calls[0].text)
    && (() => { const m = db._store.get('messages').get(r1.messageId); return m && m.status === 'failed' && m.smsError === 'INSUFFICIENT_CREDITS'; })(),
    gwState.calls.map((c) => c.to));
  check('refus → aucune tâche de retry (le message ne partira pas)', queueState.jobs.length === 0);
  check('refus → réservation refusée, solde intact (1)', (await ledger.getBalance(db, 'uid-sender')) === 1);

  /* ── 2. Solde suffisant → réservation + capture au succès ── */
  await ledger.grantPurchase(db, { uid: 'uid-sender', credits: 5, reference: 'seed-2' }); // solde 6
  gwState.results.push({ success: true, messageId: 'g-2', state: 'queued' });
  const r2 = await router.routeMessage({ senderUid: 'uid-sender', senderPhone: '+22670000001', targetPhone: '+22676555444', content: 'hello', type: 'text', senderName: 'E' });
  check('envoi facturé → réservation des segments (texte court = 1)', r2.billing && r2.billing.creditsReserved === 1, r2.billing);
  check('succès passerelle → capture écrite au ledger', !!ledgerEntry(`capt-${r2.messageId}`));
  check('solde décrémenté (6 → 5)', (await ledger.getBalance(db, 'uid-sender')) === 5);
  const lastCall = gwState.calls[gwState.calls.length - 1];
  check('SMS bien parti vers le destinataire (pas un SMS système)', lastCall && lastCall.to === '+22676555444' && lastCall.text.startsWith('[OmniSMS]'), lastCall && lastCall.to);

  /* ── 3. 402 quota → remboursement immédiat ── */
  gwState.results.push({ success: false, statusCode: 402, error: '402 Free plan message limit reached (100 messages/month) - upgrade to send more' });
  const r3 = await router.routeMessage({ senderUid: 'uid-sender', senderPhone: '+22670000001', targetPhone: '+22676555445', content: 'quota', type: 'text', senderName: 'E' });
  check('402 → message failed QUOTA_EXCEEDED + remboursement (solde restauré)',
    (() => { const m = db._store.get('messages').get(r3.messageId); return m && m.status === 'failed' && m.quotaExceeded === true; })()
    && (await ledger.getBalance(db, 'uid-sender')) === 5
    && !!ledgerEntry(`refd-${r3.messageId}`));

  /* ── 4. Échec transitoire → réservation conservée, retry en file, refund final ── */
  gwState.results.push({ success: false, statusCode: 503, error: 'device offline' });
  const r4 = await router.routeMessage({ senderUid: 'uid-sender', senderPhone: '+22670000001', targetPhone: '+22676555446', content: 'retry', type: 'text', senderName: 'E' });
  check('échec transitoire → réservation CONSERVÉE (le retry ne re-paye pas)',
    !!ledgerEntry(`resv-${r4.messageId}`) && !ledgerEntry(`refd-${r4.messageId}`) && (await ledger.getBalance(db, 'uid-sender')) === 4);
  check('échec transitoire → tâche de retry en file (jobId déterministe)',
    queueState.jobs.length === 1 && queueState.jobs[0].jobOpts.jobId === `sms-${r4.messageId}`);
  // Le worker échoue à la dernière tentative → remboursement automatique
  gwState.results.push({ success: false, statusCode: 503, error: 'device offline' });
  let threw = null;
  try { await worker.processSmsJob({ id: `sms-${r4.messageId}`, data: queueState.jobs[0].data, attemptsMade: 2 }); } catch (e) { threw = e; }
  check('worker échec final → throw (retry BullMQ) + remboursement crédits',
    !!threw && !!ledgerEntry(`refd-${r4.messageId}`) && (await ledger.getBalance(db, 'uid-sender')) === 5);
  // Idempotence : rejouer le refund ne crédite pas deux fois
  await billing.refundSmsSend(db, r4.messageId, 'sms_failed_final');
  check('refund idempotent (solde toujours 5)', (await ledger.getBalance(db, 'uid-sender')) === 5);

  console.log(failures === 0 ? '\nTESTS HOOKS FACTURATION OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
