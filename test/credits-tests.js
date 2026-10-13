'use strict';
/**
 * Tests unitaires — Ledger de crédits, quota gratuit, segments, concurrence.
 * Firestore = stub mémoire avec transactions SÉRIALISÉES (mimique l'atomicité
 * Firestore). Aucun appel réseau, aucun quota de production.
 */
process.env.LOG_LEVEL = 'error';
process.env.FREE_SMS_QUOTA = '5';
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ── Firestore mémoire avec transactions sérialisées (mutex) ── */
function makeDb() {
  const store = new Map();
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
    create: async (data) => { if (colMap(col).has(id)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }); colMap(col).set(id, JSON.parse(JSON.stringify(data))); },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => { if (!colMap(col).has(id)) throw new Error('NOT_FOUND'); Object.assign(colMap(col).get(id), JSON.parse(JSON.stringify(data))); },
    delete: async () => colMap(col).delete(id),
  });
  let auto = 0;
  let chain = Promise.resolve(); // sérialise les transactions (atomicité simulée)
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id || `auto-${++auto}`),
      add: async (data) => { const id = `auto-${++auto}`; colMap(name).set(id, JSON.parse(JSON.stringify(data))); return { id }; },
      where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }),
    }),
    // Chaque runTransaction est mis bout à bout → pas d'entrelacement.
    runTransaction: (fn) => {
      const run = chain.then(() => fn({
        get: (r) => r.get(), update: (r, d) => r.update(d),
        set: (r, d) => r.set(d), create: (r, d) => r.create(d),
      }));
      chain = run.catch(() => {});
      return run;
    },
  };
}
const db = makeDb();
require.cache[path.join(ROOT, 'config/firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: db };

const ledger = require(path.join(ROOT, 'services', 'creditLedger.js'));
const billing = require(path.join(ROOT, 'services', 'creditBilling.js'));
const seg = require(path.join(ROOT, 'services', 'segmentCalculator.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? ' → ' + (extra === undefined ? '' : extra) : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

(async () => {
  /* ── Segments ── */
  check('GSM-7 : 160 chars → 1 segment', seg.countSegments('a'.repeat(160)) === 1);
  check('GSM-7 : 161 chars → 2 segments (153/seg)', seg.countSegments('a'.repeat(161)) === 2);
  check('GSM-7 : extension { } comptent double', seg.countSegments('{' + 'a'.repeat(158) + '}') === 2, seg.countSegments('{' + 'a'.repeat(158) + '}'));
  check('UCS-2 : emoji → 70/seg', (() => { const a = seg.analyzeSms('👍'.repeat(70)); return a.encoding === 'UCS2' && a.segments === 1; })());
  check('UCS-2 : 71 emojis → 2 segments (67/seg)', seg.countSegments('👍'.repeat(71)) === 2);
  check('Réponse système tient en 1 segment GSM-7', seg.fitsOneGsm7Segment('OmniSMS: solde 12 credits. Rechargez avec RECHARGE 10 ou RECHARGE 30.'));

  /* ── Ledger : réservation → capture ── */
  await ledger.grantPurchase(db, { uid: 'u1', credits: 2, reference: 'seed-u1' });
  const r1 = await ledger.reserveCredits(db, { uid: 'u1', messageId: 'm1', credits: 2 });
  check('réservation 2 crédits → ok, solde 0 (jamais négatif après débit)', r1.ok && r1.balance === 0, r1);
  const r1b = await ledger.reserveCredits(db, { uid: 'u1', messageId: 'm1', credits: 2 });
  check('idempotence : même messageId → alreadyDone, pas de double débit', r1b.ok && r1b.alreadyDone === true && (await ledger.getBalance(db, 'u1')) === 0);
  check('capture (passerelle accepte) → solde inchangé', (await ledger.captureReservation(db, { messageId: 'm1' })).ok && (await ledger.getBalance(db, 'u1')) === 0);

  /* ── Ledger : solde insuffisant ── */
  await ledger.grantPurchase(db, { uid: 'u2', credits: 1, reference: 'seed-u2' });
  const r2 = await ledger.reserveCredits(db, { uid: 'u2', messageId: 'm2', credits: 3 });
  check('solde insuffisant → refus clair, solde intouché (1)', !r2.ok && r2.code === 'INSUFFICIENT_CREDITS' && r2.balance === 1 && r2.required === 3, r2);
  const r2b = await ledger.reserveCredits(db, { uid: 'u2', messageId: 'm2b', credits: 1 });
  check('après refus, une réservation plus petite passe (solde 0)', r2b.ok && r2b.balance === 0, r2b);
  const r2c = await ledger.refundReservation(db, { messageId: 'm2b', reason: 'test' });
  check('remboursement → solde restauré à 1', r2c.ok && (await ledger.getBalance(db, 'u2')) === 1, r2c);
  const r2d = await ledger.refundReservation(db, { messageId: 'm2b', reason: 'test' });
  check('remboursement idempotent (jamais 2 fois)', r2d.alreadyDone === true && (await ledger.getBalance(db, 'u2')) === 1);
  check('remboursement sans réservation → NO_RESERVATION', (await ledger.refundReservation(db, { messageId: 'inconnu', reason: 'x' })).code === 'NO_RESERVATION');

  /* ── Quota gratuit : 5 par numéro, consommés en premier, une seule fois ── */
  for (let i = 0; i < 5; i++) {
    const f = await billing.consumeFreeUnit(db, '+22670000001');
    if (!f.used) { check(`quota gratuit : unité ${i + 1}/5 consommée`, false, f); break; }
  }
  check('quota gratuit épuisé après 5', (await billing.consumeFreeUnit(db, '+22670000001')).used === false);
  check('quota gratuit : compteur indépendant par numéro', (await billing.consumeFreeUnit(db, '+22670000002')).used === true);
  check('getFreeRemaining → 0 après épuisement', (await billing.getFreeRemaining(db, '+22670000001')) === 0);

  /* ── chargeSmsSend : gratuit puis crédits, segments, idempotence ── */
  const c1 = await billing.chargeSmsSend({ db, uid: 'u3', senderPhoneE164: '+22670000003', messageId: 'sm1', text: 'a'.repeat(150) });
  check('1er envoi → quota gratuit consommé, 0 crédit', c1.ok && c1.freeUsed === true && c1.creditsReserved === 0, c1);
  for (let i = 0; i < 4; i++) await billing.consumeFreeUnit(db, '+22670000003'); // épuise les 5 unités du numéro
  check('quota gratuit du numéro u3 épuisé', (await billing.getFreeRemaining(db, '+22670000003')) === 0);
  await ledger.grantPurchase(db, { uid: 'u3', credits: 5, reference: 'OM-TX-1' });
  check('achat pack crédité (idempotent par référence)', (await ledger.getBalance(db, 'u3')) === 5);
  const c2 = await billing.chargeSmsSend({ db, uid: 'u3', senderPhoneE164: '+22670000003', messageId: 'sm2', text: 'a'.repeat(161) });
  check('2e envoi (2 segments, gratuit épuisé) → 2 crédits réservés', c2.ok && !c2.freeUsed && c2.creditsReserved === 2 && (await ledger.getBalance(db, 'u3')) === 3, c2);
  const c3 = await billing.refundSmsSend(db, 'sm2', 'QUOTA_EXCEEDED');
  check('refund 402 → solde restauré à 5', c3.ok && (await ledger.getBalance(db, 'u3')) === 5, c3);
  const c4 = await billing.chargeSmsSend({ db, uid: 'u3', senderPhoneE164: '+22670000003', messageId: 'sm3', text: 'x'.repeat(200) });
  check('solde juste suffisant : 2 segments pour 5 crédits ok', c4.ok && c4.creditsReserved === 2 && (await ledger.getBalance(db, 'u3')) === 3);
  await ledger.grantPurchase(db, { uid: 'u3', credits: 5, reference: 'OM-TX-1' });
  check('double crédit du même OM-TX-1 impossible (toujours solde 3)', (await ledger.getBalance(db, 'u3')) === 3);

  /* ── Concurrence : 4 envois simultanés, solde juste suffisant pour 3 ── */
  await ledger.grantPurchase(db, { uid: 'u4', credits: 3, reference: 'seed-u4' }); // solde 3
  const results = await Promise.all([
    billing.chargeSmsSend({ db, uid: 'u4', messageId: 'cc1', text: 'a'.repeat(150) }), // 1 segment
    billing.chargeSmsSend({ db, uid: 'u4', messageId: 'cc2', text: 'a'.repeat(150) }), // 1 segment
    billing.chargeSmsSend({ db, uid: 'u4', messageId: 'cc3', text: 'a'.repeat(150) }), // 1 segment
    billing.chargeSmsSend({ db, uid: 'u4', messageId: 'cc4', text: 'a'.repeat(150) }), // → doit refuser
  ]);
  const okCount = results.filter((r) => r.ok).length;
  const refused = results.filter((r) => !r.ok && r.code === 'INSUFFICIENT_CREDITS').length;
  const finalBalance = await ledger.getBalance(db, 'u4');
  check('concurrence : exactement 3 envois acceptés sur 4 (solde 3)', okCount === 3 && refused === 1, results.map((r) => (r.ok ? 'ok' : r.code)).join(','));
  check('concurrence : jamais de dépense en trop (solde final 0, jamais négatif)', finalBalance === 0, finalBalance);
  check('concurrence : aucune réservation dupliquée (4 refs uniques)', results.filter((r) => r.ok).every((r) => !r.alreadyDone));

  console.log(failures === 0 ? '\nTESTS LEDGER/SEGMENTS OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
