'use strict';
/**
 * Tests — Vérification du numéro à l'inscription (PHONE_VERIFICATION_REQUIRED).
 * Serveur réel en stubs ; transporteur OTP INJECTÉ (aucun SMS réel, aucun code fixe).
 */
process.env.LOG_LEVEL = 'error';
process.env.PORT = '5073';
process.env.WORKER_IN_WEB_PROCESS = 'false';
process.env.JWT_SECRET = 'phone-verify-test-secret';
process.env.PHONE_VERIFICATION_REQUIRED = 'true'; // politique ACTIVE pour les tests
process.env.AUTH_RATE_LIMIT_MAX = '100000'; // le limiteur anti brute-force /api/auth ne doit pas fausser les scénarios
const path = require('path');
const jwt = require('jsonwebtoken');
const http = require('http');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');

/* ── Firestore mémoire ── */
function makeDb() {
  const store = new Map();
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), ref: docRef(col, id) }; },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => { if (!colMap(col).has(id)) throw new Error('NOT_FOUND'); Object.assign(colMap(col).get(id), JSON.parse(JSON.stringify(data))); },
    delete: async () => colMap(col).delete(id),
    create: async (data) => { if (colMap(col).has(id)) throw new Error('ALREADY_EXISTS'); colMap(col).set(id, JSON.parse(JSON.stringify(data))); },
  });
  let auto = 0;
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id || `auto-${++auto}`),
      add: async (data) => { const id = `auto-${++auto}`; colMap(name).set(id, JSON.parse(JSON.stringify(data))); return { id, ref: docRef(name, id) }; },
      where: function (f1, op1, v1) {
        const filters = [[f1, op1, v1]];
        return {
          where(f2, op2, v2) { filters.push([f2, op2, v2]); return this; },
          limit() {
            return {
              async get() {
                let docs = [...colMap(name).entries()].map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: docRef(name, id) }));
                for (const [f, , v] of filters) docs = docs.filter((x) => x.data()[f] === v);
                return { empty: docs.length === 0, docs, size: docs.length };
              },
            };
          },
        };
      },
    }),
    runTransaction: async (fn) => fn({
      get: (r) => r.get(), update: (r, d) => r.update(d), set: (r, d, o) => r.set(d, o), delete: (r) => r.delete(), create: (r, d) => r.create(d),
    }),
  };
}
const memDb = makeDb();
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: memDb };

/* ── Transporteur OTP injecté (capte les SMS) ── */
const otpSvc = require(path.join(ROOT, 'services', 'otpService.js'));
const sentSms = [];
otpSvc._setTransportForTests(async (phone, text) => { sentSms.push({ phone, text }); return { success: true, messageId: 'stub' }; });

/* ── Stubs voisins (comme les autres suites HTTP) ── */
require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gw', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => true, isConfigured: () => false, sendSMS: async () => ({ success: false }) } };
require.cache[path.join(ROOT, 'services', 'infobip.js')] = { id: 'ib', filename: path.join(ROOT, 'services/infobip.js'), loaded: true, exports: { isConfigured: () => false, sendSMS: async () => ({ success: false }) } };
require.cache[path.join(ROOT, 'services', 'queueService.js')] = { id: 'qs', filename: path.join(ROOT, 'services/queueService.js'), loaded: true, exports: { addSmsJob: async () => ({}), addJob: async () => ({}), createWorker: () => ({}) } };

const app = require(path.join(ROOT, 'server.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`http://127.0.0.1:5073${url}`, {
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

  /* ── 1. Inscription classique (flag ON) → compte EN ATTENTE + pendingToken ── */
  let r = await req('POST', '/api/auth/register', { name: 'Awa', phone: '+22670001001', password: 'motdepasse1', username: 'awa1' });
  check('register (flag ON) → 201 requiresVerification + pendingToken (PAS de token complet)', r.status === 201 && r.body.requiresVerification === true && !!r.body.pendingToken && !r.body.token, r.status);
  const uidNew = r.body.userId;
  const pendingToken = r.body.pendingToken;
  const payload = jwt.decode(pendingToken);
  check('pendingToken : purpose phone_verification, 15 min, claim verificationRequired', payload.purpose === 'phone_verification' && payload.verificationRequired === true);
  const uDoc = memDb._store.get('users').get(uidNew);
  check('compte créé phoneVerified:false + verificationRequired:true + status pending', uDoc.phoneVerified === false && uDoc.verificationRequired === true && uDoc.status === 'pending_verification');

  /* ── 2. Accès interdit AVANT vérification ── */
  r = await req('POST', '/api/messages/send', { receiverId: '+22670001002', content: 'salut' }, { Authorization: `Bearer ${pendingToken}` });
  check('envoi HTTP bloqué (403 PHONE_VERIFICATION_REQUIRED) avant vérification', r.status === 403 && r.body.code === 'PHONE_VERIFICATION_REQUIRED', r.status);

  /* ── 3. Demande du code (pendingToken, SANS phone dans le body → numéro du compte) ── */
  r = await req('POST', '/api/auth/send-otp', {}, { Authorization: `Bearer ${pendingToken}` });
  check('send-otp → 200, SMS capté par le transporteur injecté (1 seul)', r.status === 200 && sentSms.length === 1);
  check('réponse neutre SANS code', !JSON.stringify(r.body).match(/\b\d{6}\b/));
  const code1 = (sentSms[0].text.match(/(\d{6})/) || [])[1];
  check('anonyme → 401 (jeton requis)', (await req('POST', '/api/auth/send-otp', { phone: '+22670001001' })).status === 401);

  /* ── 4. Vérification : incorrect, correct, réutilisation ── */
  r = await req('POST', '/api/auth/verify-otp', { code: '000000' }, { Authorization: `Bearer ${pendingToken}` });
  check('code incorrect → 400 OTP_INVALID', r.status === 400 && r.body.code === 'OTP_INVALID');
  r = await req('POST', '/api/auth/verify-otp', { code: code1 }, { Authorization: `Bearer ${pendingToken}` });
  check('code correct → 200 + JWT COMPLET (session) + user.phoneVerified:true', r.status === 200 && !!r.body.token && r.body.user && r.body.user.phoneVerified === true);
  const sessionToken = r.body.token;
  check('JWT session : claim verificationRequired:false', jwt.decode(sessionToken).verificationRequired === false);
  const uDoc2 = memDb._store.get('users').get(uidNew);
  check('compte activé : phoneVerified true, verificationRequired false, status active', uDoc2.phoneVerified === true && uDoc2.verificationRequired === false && uDoc2.status === 'active');
  r = await req('POST', '/api/auth/verify-otp', { code: code1 }, { Authorization: `Bearer ${pendingToken}` });
  check('réutilisation → 404/409 (code consommé ou compte activé)', [404, 409].includes(r.status));

  /* ── 5. Accès normal APRÈS vérification ── */
  r = await req('GET', '/api/auth/phone/verify/status', null, { Authorization: `Bearer ${sessionToken}` });
  check('status après vérification → phoneVerified true, pending false', r.status === 200 && r.body.phoneVerified === true && r.body.verificationRequired === false);
  r = await req('POST', '/api/messages/send', { receiverId: '+22670001002', content: 'salut' }, { Authorization: `Bearer ${sessionToken}` });
  check('envoi HTTP autorisé après vérification (≠403)', r.status !== 403, r.status);

  /* ── 6. Connexion Google à un NOUVEAU compte → en attente (email ≠ preuve de téléphone) ── */
  const google = require(path.join(ROOT, 'services', 'googleOAuth.js'));
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const gAcc = await google.findOrCreateOmniUser({ googleUid: 'g-sub-otp-1', email: 'new.google@example.com', name: 'Nouveau Google', picture: null });
  check('première inscription Google → verificationRequired:true, phone null', gAcc.data.verificationRequired === true && gAcc.data.phone === null && gAcc.data.phoneVerified === false);
  // Connexion Google à un compte EXISTANT vérifié → PAS re-bloqué
  await memDb.collection('users').doc('u-legacy-verified').set({ name: 'Legacy', phone: '+22670001009', phoneVerified: true, provider: 'phone' });
  const gLegacy = await google.findOrCreateOmniUser({ googleUid: 'g-sub-otp-9', email: undefined, name: 'Legacy', picture: null }) // pas d'email → pas de lien
    .catch(() => null); // email requis — on teste plutôt via doc existant + Google email
  const gLinked = await google.findOrCreateOmniUser({ googleUid: 'g-sub-otp-2', email: 'existing.verified@example.com', name: 'Existing', picture: null });
  await memDb.collection('users').doc(gLinked.id).set({ phone: '+22670001010', phoneVerified: true }, { merge: true });
  const gRelink = await google.findOrCreateOmniUser({ googleUid: 'g-sub-otp-2', email: 'existing.verified@example.com', name: 'Existing', picture: null });
  check('connexion Google à un compte existant → PAS de re-vérification (flag inchangé)', gRelink.data.verificationRequired !== true || gRelink.data.phoneVerified === true);

  /* ── 7. Comptes HISTORIQUES : login normal (jamais bloqués) ── */
  await memDb.collection('users').doc('u-legacy-nofield').set({ name: 'Ancien', phone: '+22670001011', password: 'x', provider: 'phone' }); // SANS phoneVerified
  // login par phone+password : le harnais bcrypt… le doc a password 'x' non hashé → 401 ; on simule plutôt le CLAIM absent :
  const legacyToken = jwt.sign({ uid: 'u-legacy-nofield', email: '+22670001011', name: 'Ancien' }, 'phone-verify-test-secret', { expiresIn: '7d' });
  r = await req('POST', '/api/messages/send', { receiverId: '+22670001002', content: 'coucou' }, { Authorization: `Bearer ${legacyToken}` });
  check('JWT historique (sans claim) → jamais bloqué par le garde', r.status !== 403, r.status);

  /* ── 8. Renvoi trop rapide (cooldown) ── */
  r = await req('POST', '/api/auth/register', { name: 'Issa', phone: '+22670001003', password: 'motdepasse2', username: 'issa3' });
  const pt2 = r.body.pendingToken;
  await req('POST', '/api/auth/send-otp', {}, { Authorization: `Bearer ${pt2}` });
  r = await req('POST', '/api/auth/send-otp', {}, { Authorization: `Bearer ${pt2}` });
  check('renvoi immédiat → 429 OTP_COOLDOWN', r.status === 429 && r.body.code === 'OTP_COOLDOWN');

  /* ── 9. Numéro déjà pris (changement) ── */
  r = await req('POST', '/api/auth/register', { name: 'Raki', phone: '+22670001004', password: 'motdepasse3', username: 'raki4' });
  if (!r.body.pendingToken) console.log('DEBUG register Raki:', r.status, JSON.stringify(r.body));
  const pt3 = r.body.pendingToken;
  r = await req('POST', '/api/auth/phone/change', { phone: '+22670001001' }, { Authorization: `Bearer ${pt3}` }); // numéro d'Awa (existe)
  check('changement vers un numéro déjà associé → 409 PHONE_ALREADY_USED', r.status === 409 && r.body.code === 'PHONE_ALREADY_USED');
  r = await req('POST', '/api/auth/phone/change', { phone: '+22670001005' }, { Authorization: `Bearer ${pt3}` });
  check('changement vers un numéro libre → 200', r.status === 200);
  const raki = [...memDb._store.get('users').values()].find((d) => d.phone === '+22670001005');
  check('le numéro du compte est bien le nouveau', !!raki);

  /* ── 10. Provider indisponible → jamais marqué vérifié ── */
  otpSvc._setTransportForTests(null); // plus de transporteur
  r = await req('POST', '/api/auth/register', { name: 'Sali', phone: '+22670001006', password: 'motdepasse4', username: 'sali6' });
  const pt6 = r.body.pendingToken;
  r = await req('POST', '/api/auth/send-otp', {}, { Authorization: `Bearer ${pt6}` });
  check('fournisseur indisponible → 503 OTP_PROVIDER_UNAVAILABLE', r.status === 503 && r.body.code === 'OTP_PROVIDER_UNAVAILABLE');
  const sali = [...memDb._store.get('users').values()].find((d) => d.phone === '+22670001006');
  check('compte reste EN ATTENTE (jamais marqué vérifié)', sali.phoneVerified === false && sali.verificationRequired === true);

  /* ── 11. Concurrentes : deux demandes → un seul code actif (doc unique par numéro) ── */
  otpSvc._setTransportForTests(async (phone, text) => { sentSms.push({ phone, text }); return { success: true }; });
  sentSms.length = 0;
  await req('POST', '/api/auth/register', { name: 'Deux', phone: '+22670001007', password: 'motdepasse5', username: 'deux7' });
  const pt7 = (await req('POST', '/api/auth/register', { name: 'Deux-bis', phone: '+22670001008', password: 'motdepasse6', username: 'deux8' })).body.pendingToken;
  // deux demandes quasi simultanées sur le MÊME numéro
  const [pA, pB] = await Promise.all([
    req('POST', '/api/auth/send-otp', {}, { Authorization: `Bearer ${pt7}` }),
    req('POST', '/api/auth/send-otp', {}, { Authorization: `Bearer ${pt7}` }),
  ]);
  const okReqs = [pA, pB].filter((x) => x.status === 200);
  check('deux demandes concurrentes → au plus une acceptée (cooldown/doc unique)', okReqs.length <= 1, [pA.status, pB.status]);

  /* ── 12. Deux inscriptions même numéro → double inscription empêchée ── */
  r = await req('POST', '/api/auth/register', { name: 'Doublon', phone: '+22670001001', password: 'motdepasse7', username: 'doublon9' });
  check('double inscription avec le même numéro → refusée', r.status === 400 || r.status === 409, r.status);

  console.log(failures === 0 ? '\nTESTS VÉRIFICATION TÉLÉPHONE OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
  process.exit(0);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
