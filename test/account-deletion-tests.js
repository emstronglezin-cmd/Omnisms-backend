'use strict';
/** Tests — Conformité Play : suppression de compte (web + in-app + purge admin). */
process.env.LOG_LEVEL = 'error';
process.env.ADMIN_KEY = 'test-admin-key';
process.env.ACCOUNT_DELETION_RETENTION_DAYS = '30';
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const http = require('http');
const ROOT = path.join(__dirname, '..');

/* ── Firestore mémoire injecté (where chainable + delete) ── */
function makeDb() {
  const store = new Map();
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), ref: docRef(col, id) }; },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => Object.assign(colMap(col).get(id) || {}, JSON.parse(JSON.stringify(data))),
    delete: async () => { colMap(col).delete(id); },
  });
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id),
      where: function () { return this; },
      orderBy: function () { return this; },
      startAfter: function () { return this; },
      limit: function () { return this; },
      get: async () => ({ docs: [...colMap(name).entries()].map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: docRef(name, id) })) }),
    }),
    batch: () => {
      const ops = [];
      return {
        delete: (ref) => ops.push(ref),
        set: () => ops.push(null),
        update: () => ops.push(null),
        commit: async () => { ops.forEach((r) => { if (r && r.id) colMap('users').delete(r.id); }); return ops.length; },
      };
    },
  };
}
const memDb = makeDb();
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config', 'firebase.js'), loaded: true, exports: memDb };
// Pas de Redis → rateStore mémoire ; firebaseAuth : JWT seulement (stub admin rejette verifyIdToken → retombe sur JWT)
process.env.JWT_SECRET = 'test-secret-adeletion';

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

/* Boot du vrai serveur express (stubs) sur un port dédié */
process.env.PORT = '5071';
process.env.WORKER_IN_WEB_PROCESS = 'false';
const app = require(path.join(ROOT, 'server.js'));

function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`http://127.0.0.1:5071${url}`, {
      method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 1500)); // boot

  /* ── Page web publique ── */
  const page = await req('GET', '/api/account/web');
  check('page web publique 200, HTML français, mention in-app + 30 jours', page.status === 200 && /Supprimer mon compte OmniSMS/.test(page.body) && /30 jours/.test(page.body) && /Profil → Paramètres/.test(page.body));
  const redirect = await req('GET', '/delete-account');
  check('URL courte /delete-account → 302 vers la page', [301, 302].includes(redirect.status) && /\/api\/account\/web/.test(redirect.headers.location || ''));

  /* ── Demande web sans auth ── */
  const bad = await req('POST', '/api/account/web-request', { phone: '+22670000001' });
  check('web-request sans confirmation → 400', bad.status === 400);
  const ok = await req('POST', '/api/account/web-request', { phone: '+226 70 00 00 01', confirm: true });
  check('web-request valide → 202', ok.status === 202, ok.body);
  const stored = [...memDb._store.get('deletion_requests').values()][0];
  const expectedHash = crypto.createHash('sha256').update(`test-secret-adeletion:+22670000001`).digest('hex').slice(0, 40);
  check('numéro stocké HASHÉ (jamais en clair)', stored && stored.phoneHash === expectedHash && !JSON.stringify(stored).includes('70000001'), stored && stored.phoneHash);
  const rl = await req('POST', '/api/account/web-request', { phone: '+22670000002', confirm: true });
  check('2e demande acceptée (sous la limite 3/h)', rl.status === 202);

  /* ── Suppression in-app ── */
  const noauth = await req('POST', '/api/account/delete', {});
  check('delete sans JWT → 401', noauth.status === 401);
  // seed utilisateur avant suppression
  await memDb.collection('users').doc('u-del').set({ uid: 'u-del', phone: '+22676009999', email: 'a@b.c', name: 'Alice', bio: 'hello', fcmTokens: ['tok'] });
  const token = jwt.sign({ uid: 'u-del', phone: '+22676009999' }, 'test-secret-adeletion', { expiresIn: '10m' });
  const del = await req('POST', '/api/account/delete', {}, { Authorization: `Bearer ${token}` });
  check('delete authentifié → 200 + délai de purge annoncé', del.status === 200 && /30 jours/.test(del.body), del.body);
  const u = memDb._store.get('users').get('u-del');
  check('PII scrubée : phone null, email anonyme, bio null, fcmTokens []', u.phone === null && u.email === 'deleted_u-del@omnisms.deleted' && u.bio === null && Array.isArray(u.fcmTokens) && u.fcmTokens.length === 0 && u.deleted === true);
  const audit = memDb._store.get('account_deletions').get('u-del');
  check('audit horodaté créé (source in_app, purged:false)', audit && audit.source === 'in_app' && audit.purged === false && audit.deletedAt);

  /* ── Purge admin ── */
  const noKey = await req('POST', '/api/account/admin/purge-expired', {});
  check('purge sans x-admin-key → 401', noKey.status === 401);
  // compte soft-deleted il y a 40 jours → purgeable ; u-del (aujourd'hui) → conservé
  await memDb.collection('users').doc('u-old').set({ uid: 'u-old', deleted: true, deletedAt: new Date(Date.now() - 40 * 86400 * 1000).toISOString() });
  await memDb.collection('account_deletions').doc('u-old').set({ uid: 'u-old', purged: false });
  const purge = await req('POST', '/api/account/admin/purge-expired', {}, { 'x-admin-key': 'test-admin-key' });
  const purgeBody = JSON.parse(purge.body || '{}');
  check('purge admin → 200, 1 compte purgé', purge.status === 200 && purgeBody.purged === 1, purge.body);
  check('compte expiré disparu, compte récent conservé', !memDb._store.get('users').has('u-old') && memDb._store.get('users').has('u-del'));
  const auditOld = memDb._store.get('account_deletions').get('u-old');
  check('audit marqué purged:true avec horodatage', auditOld && auditOld.purged === true && !!auditOld.purgedAt);

  console.log(failures === 0 ? '\nTESTS SUPPRESSION COMPTE OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
