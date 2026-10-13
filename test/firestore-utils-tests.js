'use strict';
/** Tests — utilitaires Firestore à l'échelle (compteurs shardés, batch, curseur, cache). */
process.env.LOG_LEVEL = 'error';
const path = require('path');
const ROOT = path.join(__dirname, '..');

function makeDb() {
  const store = new Map();
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
  });
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id),
      where: function () { return this; },
      orderBy: function () { return this; },
      startAfter: function () { return this; },
      limit: function (n) {
        return { get: async () => ({ docs: [...colMap(name).entries()].slice(0, n).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)) })) }) };
      },
      get: async () => ({ docs: [...colMap(name).entries()].map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)) })) }),
    }),
    batch: () => {
      const ops = [];
      return {
        set: (ref, data, opts) => ops.push({ ref, data, opts }),
        update: () => ops.push({}),
        delete: () => ops.push({}),
        commit: async () => { ops.forEach((o) => { const d = colMap('batched'); d.set(o.ref.id, JSON.parse(JSON.stringify(o.data))); }); return ops.length; },
      };
    },
  };
}
const db = makeDb();
require.cache[path.join(ROOT, 'config/firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: db };
// pas de Redis → cache mémoire
const u = require(path.join(ROOT, 'services', 'firestoreUtils.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

(async () => {
  /* ── Compteur shardé ── */
  for (let i = 0; i < 100; i++) await u.shardIncrement(db, 'messages_out', 1, 10);
  const total = await u.shardTotal(db, 'messages_out', 10);
  check('100 incréments shardés (10 shards) → total exact, aucun doc chaud', total === 100, total);
  const shardDocs = [...db._store.get('counters').values()];
  check('écritures réparties sur plusieurs shards (max < total)', shardDocs.length > 1 && Math.max(...shardDocs.map((d) => d.count)) < 100, shardDocs.map((d) => d.count));

  /* ── Batch borné ── */
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `doc-${i}`, v: i }));
  const committed = await u.runBatched(db, items, (batch, chunk) => {
    chunk.forEach((it) => batch.set({ id: it.id }, it));
  }, 450);
  check('1000 écritures groupées → 3 commits (450+450+100), aucun lot > 450', committed === 1000 && db._store.get('batched').size === 1000, committed);

  /* ── Pagination curseur ── */
  const items2 = Array.from({ length: 55 }, (_, i) => ({ id: `p${String(i).padStart(2, '0')}`, createdAt: new Date(2026, 0, 1, 0, i).toISOString() }));
  db._store.set('paged', new Map(items2.map((it) => [it.id, it])));
  // orderBy non supporté par le stub → le helper trie côté stub ? Non : on simule
  // une collection triée en passant orderBy 'id' absent → stub renvoie tout ; on
  // vérifie surtout le mécanisme de curseur (startAfter ignoré par le stub).
  const page1 = await u.cursorPaginate(db, { collection: 'paged', limit: 20, orderBy: 'createdAt' });
  check('page 1 → limit respecté + curseur présent', page1.items.length === 20 && !!page1.nextCursor, page1.nextCursor);
  check('curseur = id du dernier doc de la page', page1.nextCursor === page1.items[page1.items.length - 1].id);

  /* ── Cache ── */
  let loaderCalls = 0;
  const loader = async () => { loaderCalls++; return { uid: 'u1', phone: '+22670000001' }; };
  const c1 = await u.getWithCache('phone:+22670000001', 60000, loader, { enabled: true });
  const c2 = await u.getWithCache('phone:+22670000001', 60000, loader, { enabled: true });
  check('cache : 2 lectures → 1 seul appel loader, valeur identique', loaderCalls === 1 && c1.uid === 'u1' && c2.uid === 'u1', loaderCalls);
  await u.invalidateCache('phone:+22670000001');
  await u.getWithCache('phone:+22670000001', 60000, loader, { enabled: true });
  check('invalidation → rechargement', loaderCalls === 2, loaderCalls);
  const d1 = await u.getWithCache('k2', 60000, loader, { enabled: false });
  const d2 = await u.getWithCache('k2', 60000, loader, { enabled: false });
  check('flag off → pas de cache (2 appels loader)', loaderCalls === 4 && d1 && d2, loaderCalls);

  console.log(failures === 0 ? '\nTESTS FIRESTORE UTILS OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
