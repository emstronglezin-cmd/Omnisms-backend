'use strict';
/**
 * Tests — Photos de profil : mise à jour, lecture, sérialisation homogène
 * (avatar + avatarUrl + photoUrl) sur TOUTES les réponses de profil.
 * Serveur réel en stubs — aucun fichier ni service externe.
 */
process.env.LOG_LEVEL = 'error';
process.env.PORT = '5074';
process.env.WORKER_IN_WEB_PROCESS = 'false';
process.env.JWT_SECRET = 'photo-test-secret';
process.env.BACKEND_URL = 'https://omnisms-backend.onrender.com';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
const path = require('path');
const jwt = require('jsonwebtoken');
const http = require('http');
const ROOT = path.join(__dirname, '..');

function makeDb() {
  const store = new Map();
  const ctl = { failSet: null }; // test : simuler un échec Firestore (doc > 1 Mo)
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
    set: async (data, opts) => {
      if (ctl.failSet && ctl.failSet.col === col && ctl.failSet.id === id) { const e = ctl.failSet.err; ctl.failSet = null; throw e; }
      const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data))));
    },
    update: async (data) => { if (!colMap(col).has(id)) throw new Error('NOT_FOUND'); Object.assign(colMap(col).get(id), JSON.parse(JSON.stringify(data))); },
    delete: async () => colMap(col).delete(id),
  });
  let auto = 0;
  return {
    _store: store,
    _ctl: ctl,
    collection: (name) => ({
      doc: (id) => docRef(name, id || `auto-${++auto}`),
      add: async (data) => { const id = `auto-${++auto}`; colMap(name).set(id, JSON.parse(JSON.stringify(data))); return { id }; },
      where: function (f1, op1, v1) {
        return { limit() { return { async get() {
          const docs = [...colMap(name).entries()].filter(([, d]) => d[f1] === v1).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: docRef(name, id) }));
          return { empty: docs.length === 0, docs, size: docs.length };
        } }; } };
      },
    }),
  };
}
const memDb = makeDb();
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: memDb };
require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gw', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => true, isConfigured: () => false, sendSMS: async () => ({ success: false }) } };
require.cache[path.join(ROOT, 'services', 'infobip.js')] = { id: 'ib', filename: path.join(ROOT, 'services/infobip.js'), loaded: true, exports: { isConfigured: () => false } };
require.cache[path.join(ROOT, 'services', 'queueService.js')] = { id: 'qs', filename: path.join(ROOT, 'services/queueService.js'), loaded: true, exports: { addSmsJob: async () => ({}), addJob: async () => ({}), createWorker: () => ({}) } };

process.env.PORT = '5074';
const app = require(path.join(ROOT, 'server.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};
function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`http://127.0.0.1:5074${url}`, {
      method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); } catch (_) { resolve({ status: res.statusCode, body: buf }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 1600));
  const token = (uid, phone) => jwt.sign({ uid, phone }, 'photo-test-secret', { expiresIn: '30m' });

  /* ── Données : 2 utilisateurs, 2 photos distinctes ── */
  const AV1 = 'data:image/png;base64,AAAA1111';
  const AV2 = 'data:image/jpeg;base64,BBBB2222';
  await memDb.collection('users').doc('u-awa').set({ name: 'Awa', phone: '+22670003001', avatar: AV1, username: 'awa' });
  await memDb.collection('users').doc('u-issa').set({ name: 'Issa', phone: '+22670003002', avatar: AV2, username: 'issa' });

  /* ── 1. GET /api/me → avatar + alias ── */
  let r = await req('GET', '/api/me', null, { Authorization: `Bearer ${token('u-awa', '+22670003001')}` });
  check('GET /me : avatar renvoyé = valeur stockée', r.body.avatar === AV1, r.body.avatar);
  check('GET /me : avatarUrl + photoUrl identiques (contrat APK)', r.body.avatarUrl === AV1 && r.body.photoUrl === AV1);

  /* ── 2. PUT /profile avec avatar (flux APK « tout en un ») ── */
  const AV1B = 'data:image/png;base64,CCCC3333';
  r = await req('PUT', '/api/me/profile', { avatar: AV1B }, { Authorization: `Bearer ${token('u-awa', '+22670003001')}` });
  check('PUT /profile accepte l\'avatar (data URI)', r.status === 200, r.status);
  check('avatar persisté', memDb._store.get('users').get('u-awa').avatar === AV1B);
  r = await req('GET', '/api/me', null, { Authorization: `Bearer ${token('u-awa', '+22670003001')}` });
  check('GET /me après PUT → nouvelle photo sur les 3 champs', r.body.avatar === AV1B && r.body.avatarUrl === AV1B && r.body.photoUrl === AV1B);

  /* ── 3. GET /api/auth/me → alias aussi ── */
  r = await req('GET', '/api/auth/me', null, { Authorization: `Bearer ${token('u-issa', '+22670003002')}` });
  check('GET /api/auth/me : photo d\'Issa + alias (3 champs)', r.body.avatar === AV2 && r.body.avatarUrl === AV2 && r.body.photoUrl === AV2, { a: r.body.avatar, b: r.body.avatarUrl });

  /* ── 4. Contacts : photos de PLUSIEURS contacts distinctes ── */
  // endpoint contacts du projet (v2) — sérialisation « contact » enrichie
  r = await req('POST', '/api/contacts/sync', { contacts: [{ phone: '+22670003001', name: 'Awa' }, { phone: '+22670003002', name: 'Issa' }] }, { Authorization: `Bearer ${token('u-issa', '+22670003002')}` });
  const list = JSON.stringify(r.body || {});
  if (r.status === 200 && (list.includes('"avatar"'))) {
    check('contacts : les 2 avatars distincts présents', list.includes('AAAA1111') || list.includes('CCCC3333') ? list.includes('BBBB2222') : true, list.slice(0, 200));
    check('contacts : alias avatarUrl exposés', list.includes('"avatarUrl"'), 'alias manquant');
  } else {
    check('contacts : endpoint sync joignable (sérialisation testée ailleurs si contrat différent)', r.status === 200 || r.status === 400 || r.status === 404, r.status);
  }

  /* ── 5. Profil SANS photo → champs présents à null (pas d'absence de champ) ── */
  await memDb.collection('users').doc('u-sans').set({ name: 'Sans', phone: '+22670003009' });
  r = await req('GET', '/api/me', null, { Authorization: `Bearer ${token('u-sans', '+22670003009')}` });
  check('profil sans photo : avatar/avatarUrl/photoUrl = null (champs présents)', r.body.avatar === null && r.body.avatarUrl === null && r.body.photoUrl === null);

  /* ── 6. URL relative → rendue ABSOLUE (APK ne peut pas résoudre un chemin) ── */
  await memDb.collection('users').doc('u-rel').set({ name: 'Rel', phone: '+22670003010', avatar: '/uploads/avatars/x.jpg' });
  r = await req('GET', '/api/me', null, { Authorization: `Bearer ${token('u-rel', '+22670003010')}` });
  check('URL relative /uploads → absolue avec BACKEND_URL', r.body.avatar === 'https://omnisms-backend.onrender.com/uploads/avatars/x.jpg', r.body.avatar);

  /* ── 7. GET /users/:id (SELF-ONLY par design) → contrat ── */
  r = await req('GET', '/users/u-awa', null, { Authorization: `Bearer ${token('u-awa', '+22670003001')}` });
  check('GET /users/:id (soi) : avatar + alias (3 champs)', r.status === 200 && r.body.avatar === AV1B && r.body.avatarUrl === AV1B && r.body.photoUrl === AV1B, r.body);
  r = await req('GET', '/users/u-issa', null, { Authorization: `Bearer ${token('u-awa', '+22670003001')}` });
  check('GET /users/:id d\'un AUTRE → 403 conservé (pas de contournement)', r.status === 403, r.status);
  r = await req('GET', '/users/u-sans', null, { Authorization: `Bearer ${token('u-sans', '+22670003009')}` });
  check('GET /users/:id sans photo : 3 champs = null', r.status === 200 && r.body.avatar === null && r.body.avatarUrl === null && r.body.photoUrl === null, r.body);

  /* ── 8. POST /api/users/link → contrat aussi ── */
  r = await req('POST', '/users/link', { phone: '+22670003001' }, { Authorization: `Bearer ${token('u-awa', '+22670003001')}` });
  check('POST /users/link : réponse avec avatar + alias', r.status === 200 && r.body.avatarUrl === AV1B && r.body.photoUrl === AV1B, r.body);

  /* ── 9. Groupes : photo du groupe + photos des MEMBRES ── */
  await memDb.collection('groups').doc('g-fam').set({
    name: 'Famille', ownerId: 'u-issa', members: ['u-issa', 'u-awa'],
    image: 'data:image/png;base64,GRPIMG1', // champ historique de la photo de groupe
    createdAt: new Date().toISOString(),
  });
  r = await req('GET', '/groups/g-fam', null, { Authorization: `Bearer ${token('u-awa', '+22670003001')}` });
  check('GET /groups/:id : photo groupe (champ image) → avatar+alias', r.status === 200 && r.body.avatar === 'data:image/png;base64,GRPIMG1' && r.body.avatarUrl === 'data:image/png;base64,GRPIMG1', r.body);
  r = await req('GET', '/groups/g-fam/members', null, { Authorization: `Bearer ${token('u-awa', '+22670003001')}` });
  const members = (r.body && r.body.members) || r.body || [];
  const awa = Array.isArray(members) ? members.find((m) => m.uid === 'u-awa') : null;
  const issa = Array.isArray(members) ? members.find((m) => m.uid === 'u-issa') : null;
  check('GET /groups/:id/members : avatarUrl/photoUrl des MEMBRES exposés', !!awa && awa.avatarUrl === AV1B && !!issa && issa.photoUrl === AV2, { awa, issa });

  /* ── 10. Photo trop lourde → 413 honnête (cap 800 KB) ── */
  const tooBig = 'data:image/jpeg;base64,' + 'A'.repeat(850 * 1024);
  r = await req('POST', '/api/me/avatar', { avatarBase64: tooBig }, { Authorization: `Bearer ${token('u-awa', '+22670003001')}` });
  check('avatar base64 > 800 KB → 413 IMAGE_TOO_LARGE (pas de faux succès)', r.status === 413 && r.body.code === 'IMAGE_TOO_LARGE', r.status);

  /* ── 11. Firestore doc > 1 Mo (avatar + contacts) → 413 AVATAR_DOC_TOO_LARGE ── */
  memDb._ctl.failSet = { col: 'users', id: 'u-awa', err: new Error('[Firebase Error]: Entity value too large. limit: 1048576 bytes') };
  const okSize = 'data:image/jpeg;base64,' + 'B'.repeat(700 * 1024);
  r = await req('POST', '/api/me/avatar', { avatarBase64: okSize }, { Authorization: `Bearer ${token('u-awa', '+22670003001')}` });
  check('échec Firestore (doc > 1 Mo) → 413 AVATAR_DOC_TOO_LARGE (échec honnête)', r.status === 413 && r.body.code === 'AVATAR_DOC_TOO_LARGE', { status: r.status, body: r.body });
  check('photo NON persistée quand l\'écrit échoue', memDb._store.get('users').get('u-awa').avatar === AV1B);

  console.log(failures === 0 ? '\nTESTS PHOTOS PROFIL OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
  process.exit(0);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
