'use strict';
/**
 * Tests — Parseur Orange Money (fixtures « À REMPLACER ») + recharge par SMS :
 * unitaires (parseur), idempotence (même OM-SMS 2×), caps journaliers,
 * parcours complet RECHARGE → SMS Orange Money → crédit → SOLDE, PAYE tiers.
 */
process.env.LOG_LEVEL = 'error';
process.env.FREE_SMS_QUOTA = '5';
process.env.PAYMENT_INTENT_TTL_MIN = '30';
process.env.OM_DAILY_MAX_RECHARGES = '3';
process.env.OM_GATEWAY_NUMBER = '+22675405214';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const fixtures = require(path.join(__dirname, 'fixtures', 'om-sms.json'));

/* ── Firestore mémoire avec where(f,op,v) filtrant ── */
function makeDb() {
  const store = new Map();
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => { if (!colMap(col).has(id)) throw new Error('NOT_FOUND'); Object.assign(colMap(col).get(id), JSON.parse(JSON.stringify(data))); },
    create: async (data) => { if (colMap(col).has(id)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }); colMap(col).set(id, JSON.parse(JSON.stringify(data))); },
  });
  const applyFilters = (docs, filters) => docs.filter(([, d]) =>
    filters.every(([f, , v]) => d[f] === v));
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
require.cache[path.join(ROOT, 'services/userResolver.js')] = {
  id: 'ur', filename: path.join(ROOT, 'services/userResolver.js'), loaded: true,
  exports: {
    resolveUserByPhone: async (p) => (p === '+22670000001' ? { found: true, uid: 'uid-user1', phone: p }
      : p === '+22670000002' ? { found: true, uid: 'uid-user2', phone: p } : { found: false }),
    resolveUserByUid: async (uid) => ({ found: true, uid, phone: uid === 'uid-user1' ? '+22670000001' : '+22670000002' }),
    normalizeEmail: (e) => String(e || '').toLowerCase(),
  },
};

const om = require(path.join(ROOT, 'services', 'orangeMoneyParser.js'));
const recharge = require(path.join(ROOT, 'services', 'rechargeService.js'));
const ledger = require(path.join(ROOT, 'services', 'creditLedger.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? ' → ' + (extra === undefined ? '' : extra) : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};
const balanceOf = (uid) => ledger.getBalance(db, uid);
const replies = [];

(async () => {
  /* ── Parseur : fixtures (dont « À REMPLACER ») ── */
  for (const fx of fixtures.fixtures) {
    const parsed = om.parseOmConfirmation({ senderId: fx.senderId, body: fx.body, receivedAt: '2026-10-11T14:32:00Z' });
    if (fx.expected.ok === false) {
      check(`parseur [${fx.name}] → rejet ${fx.expected.reason}`, !parsed.ok && parsed.reason === fx.expected.reason, parsed);
    } else {
      check(`parseur [${fx.name}] (${fx.status})`, parsed.ok
        && parsed.amountFcfa === fx.expected.amountFcfa
        && parsed.txnId === fx.expected.txnId
        && parsed.payerPhone === fx.expected.payerPhone, parsed);
    }
  }

  /* ── Parcours complet : RECHARGE → OM SMS → crédit → SOLDE ── */
  const r1 = await recharge.handleSmsCommand({ db, phoneE164: '+22670000001', text: '  recharge  30 ' });
  check('RECHARGE 30 (casse/espaces insensibles) → instructions 600F + ref', r1.handled && /600F au \+22675405214/.test(r1.reply) && /PI-/.test(r1.reply), r1.reply);
  const intents = [...db._store.get('payment_intents').values()];
  check('intention pending créée (montant attendu, payeur, expiration 30 min)', intents.length === 1
    && intents[0].status === 'pending' && intents[0].amountFcfa === 600 && intents[0].phone === '+22670000001'
    // Tolérance 5 ms : createdAt et expiresAt sont deux lectures d'horloge
    // distinctes (une frontière de ms peut s'intercaler) — le flocon était ici.
    && Math.abs(new Date(intents[0].expiresAt) - new Date(intents[0].createdAt) - 30 * 60 * 1000) <= 5, intents[0] && intents[0].status);

  // Le même SMS Orange Money traité 2 fois (replay webhook) → 1 seul crédit
  const omSms = { senderId: 'ORANGE MONEY', body: 'Vous avez recu 600 FCFA du +226 70 00 00 01 le 11/10/2026. ID transaction: MP261011.1500.XZZ777.' };
  const p1 = om.parseOmConfirmation(omSms);
  const h1 = await recharge.handleOmPayment({ db, parsed: p1, notifyReply: async (to, reply) => replies.push({ to, reply }) });
  check('OM SMS → MATCHED, +30 crédits', h1.status === 'matched' && /plus 30 credits|paiement recu/i.test(h1.reply || '') && (await balanceOf('uid-user1')) === 30, h1.status);
  const h1b = await recharge.handleOmPayment({ db, parsed: om.parseOmConfirmation(omSms) });
  check('même OM-SMS rejoué → duplicate, solde inchangé (jamais 2 crédits)', h1b.status === 'duplicate' && (await balanceOf('uid-user1')) === 30, h1b.status);
  const h1c = await recharge.handleOmPayment({ db, parsed: om.parseOmConfirmation(omSms) });
  check('3e replay → toujours duplicate', h1c.status === 'duplicate' && (await balanceOf('uid-user1')) === 30);

  const s1 = await recharge.handleSmsCommand({ db, phoneE164: '+22670000001', text: 'solde' });
  check('SOLDE → « solde 30 credits »', /solde 30 credits/.test(s1.reply), s1.reply);

  /* ── PAYE : dépôt par un tiers (payeur ≠ utilisateur) ── */
  const omTier = { senderId: '4001', body: 'Trans 250FCFA de +22676559988, ref OMCLAIM0001, le 2026-10-11 15:03.' };
  const hp = await recharge.handleOmPayment({ db, parsed: om.parseOmConfirmation(omTier) });
  check('dépôt tiers sans intention → UNMATCHED (stocké, pas crédité)', hp.status === 'unmatched' && (await balanceOf('uid-user2')) === 0, hp.status);
  const payDoc = db._store.get('incoming_payments').get('OMCLAIM0001');
  check('paiement stocké avec statut unmatched', payDoc && payDoc.status === 'unmatched' && payDoc.amountFcfa === 250, payDoc && payDoc.status);
  const c1 = await recharge.handleSmsCommand({ db, phoneE164: '+22670000002', text: 'PAYE OMCLAIM0001' });
  check('PAYE <id> → rapproché, +10 crédits (pack 250F)', c1.handled && /\+10 credits/.test(c1.reply) && (await balanceOf('uid-user2')) === 10, c1.reply);
  const c2 = await recharge.handleSmsCommand({ db, phoneE164: '+22670000002', text: 'paye omclaim0001' });
  check('PAYE rejoué → refus (déjà crédité), solde intact', /deja ete credite/.test(c2.reply) && (await balanceOf('uid-user2')) === 10, c2.reply);
  const c3 = await recharge.handleSmsCommand({ db, phoneE164: '+22670000002', text: 'PAYE INCONNU123' });
  check('PAYE id inconnu → message clair', /inconnu/.test(c3.reply), c3.reply);

  /* ── Montant sans pack → review, aucun crédit auto ── */
  const omBad = { senderId: 'ORANGE MONEY', body: 'Vous avez recu 777 FCFA du +226 70 00 00 01. ID transaction: MPBADAMT001.' };
  const hb = await recharge.handleOmPayment({ db, parsed: om.parseOmConfirmation(omBad), notifyReply: async (to, reply) => replies.push({ to, reply }) });
  check('montant non reconnu → REVIEW + aucun crédit + SMS « en verification »',
    hb.status === 'review' && (await balanceOf('uid-user1')) === 30
    && replies.some((r) => /verification/.test(r.reply)), hb.status);

  /* ── Caps journaliers : max 3 recharges/jour ── */
  process.env.OM_DAILY_MAX_RECHARGES = '3';
  const freshPhone = '+22679999' + Date.now().toString().slice(-4);
  require.cache[path.join(ROOT, 'services/userResolver.js')].exports.resolveUserByPhone = async (p) =>
    (p === freshPhone ? { found: true, uid: 'uid-fresh', phone: p } : { found: false });
  let refused = null;
  for (let i = 0; i < 4; i++) {
    const r = await recharge.handleSmsCommand({ db, phoneE164: freshPhone, text: `RECHARGE 10` });
    if (!/Envoyer|envoyez/i.test(r.reply || '') && /Limite journaliere/.test(r.reply || '')) { refused = r; break; }
  }
  check('4e recharge du jour refusée (plafond 3/jour)', !!refused && /Limite journaliere/.test(refused.reply), refused && refused.reply);

  /* ── Anti-spam commandes ── */
  process.env.SMS_COMMANDS_PER_HOUR = '2';
  const spamPhone = '+22679888' + Date.now().toString().slice(-4);
  require.cache[path.join(ROOT, 'services/userResolver.js')].exports.resolveUserByPhone = async (p) =>
    (p === spamPhone ? { found: true, uid: 'uid-spam', phone: p } : { found: false });
  await recharge.handleSmsCommand({ db, phoneE164: spamPhone, text: 'AIDE' });
  await recharge.handleSmsCommand({ db, phoneE164: spamPhone, text: 'AIDE' });
  const spammed = await recharge.handleSmsCommand({ db, phoneE164: spamPhone, text: 'AIDE' });
  check('3e commande en <1h refusée (anti-spam, on ne paie pas ses SMS)', spammed.handled && /trop de commandes/.test(spammed.reply), spammed.reply);

  /* ── Non-commandes : laissées au traitement de message normal ── */
  const plain = await recharge.handleSmsCommand({ db, phoneE164: '+22670000001', text: 'Bonjour, ca va ?' });
  check('message ordinaire → non intercepté (handled=false)', plain.handled === false);

  console.log(failures === 0 ? '\nTESTS PARSEUR + RECHARGE OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
