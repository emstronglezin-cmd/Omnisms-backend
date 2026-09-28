'use strict';
/**
 * OmniSMS — Tests ADMIN + PAIEMENT
 * ════════════════════════════════════════════════════════════════
 *
 * Couvre :
 *   A1–A20  : Système ADMIN (authentification, autorisation, routes,
 *             données Firestore, erreurs)
 *   P1–P13  : Système de PAIEMENT (configuration, création, montant,
 *             confirmation, refus, identification serveur, activation
 *             Premium, idempotence, erreur fournisseur, falsification)
 *   N1–N7   : Non-régression backend (routes/contrats conservés)
 *
 * Principe : Firestore et le fournisseur de paiement sont remplacés par
 * des mocks EN MÉMOIRE injectés dans le cache `require` AVANT tout
 * chargement. Aucun réseau, aucune credential, aucun paiement réel.
 *
 * ⚠️ Ces tests ne constituent PAS un paiement réel chez le fournisseur :
 *    ils vérifient le comportement du backend (voir rapport : tests
 *    unitaires + intégration ; les tests fournisseur réels nécessitent
 *    SAASPAY_SECRET_KEY / SAASPAY_API_KEY de production).
 *
 * Usage : node test/admin-payment-tests.js
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

/* ═══════════════════════════════════════════════════════════════
   HARNESS
═══════════════════════════════════════════════════════════════ */
let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}\n     ↳ ${err.message}`);
    failed++;
    failures.push({ name, message: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion échouée');
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Valeur inattendue'} — attendu ${JSON.stringify(expected)}, reçu ${JSON.stringify(actual)}`);
  }
}

/* ═══════════════════════════════════════════════════════════════
   1. ENVIRONNEMENT DE TEST
═══════════════════════════════════════════════════════════════ */
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
process.env.NODE_ENV           = 'test';
process.env.ADMIN_KEY          = 'test-admin-key-1234';
delete process.env.ADMIN_UIDS;

/* ═══════════════════════════════════════════════════════════════
   2. MOCK FIRESTORE — comportement fidèle au SDK réel
      · where(égalité) + orderBy(autre champ) SANS index composite
        → erreur FAILED_PRECONDITION (comme Firestore en production)
      · count() disponible (firebase-admin >= 7.5)
      · orderBy exclut les documents dépourvus du champ
═══════════════════════════════════════════════════════════════ */
function createFirestoreMock() {
  const store = new Map(); // collection → Map(id → objet)

  const col = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  };

  const indexDefs = [];
  const declareIndexes = (list) => { indexDefs.push(...list); return indexDefs; };
  const hasIndex = (fields) =>
    indexDefs.some(idx => idx.length === fields.length && idx.every((f, i) => f === fields[i]));

  const applyState = (name, state) => {
    let rows = [...col(name).entries()].map(([id, obj]) => ({ id, ...obj }));

    for (const f of state.filters) rows = rows.filter(r => r[f.field] === f.value);

    if (state.orderBy) {
      const { field, dir } = state.orderBy;
      rows = rows.filter(r => r[field] !== undefined && r[field] !== null);
      rows.sort((a, b) => {
        const cmp = a[field] > b[field] ? 1 : (a[field] < b[field] ? -1 : 0);
        return dir === 'desc' ? -cmp : cmp;
      });
    }

    if (state.orderBy && state.filters.length) {
      const fields = [...state.filters.map(f => f.field), state.orderBy.field];
      if (new Set(fields).size > 1 && !hasIndex(fields)) {
        const err = new Error(
          'The query requires an index. You can create it here: ' +
          'https://console.firebase.google.com/project/_/firestore/indexes'
        );
        err.code = 9; // FAILED_PRECONDITION
        throw err;
      }
    }

    if (state.startAfterId != null) {
      const idx = rows.findIndex(r => r.id === state.startAfterId);
      rows = idx >= 0 ? rows.slice(idx + 1) : rows;
    }
    if (state.limit != null) rows = rows.slice(0, state.limit);
    return rows;
  };

  const queryApi = (name, state) => ({
    where: (field, op, value) => queryApi(name, { ...state, filters: [...state.filters, { field, op, value }] }),
    orderBy: (field, dir = 'asc') => queryApi(name, { ...state, orderBy: { field, dir } }),
    limit: (n) => queryApi(name, { ...state, limit: n }),
    startAfter: (docOrId) => queryApi(name, {
      ...state,
      startAfterId: typeof docOrId === 'string' ? docOrId : docOrId?.id,
    }),
    select: () => queryApi(name, state),
    async get() {
      const rows = applyState(name, state);
      return {
        empty: rows.length === 0,
        size : rows.length,
        docs : rows.map(r => ({ id: r.id, exists: true, data: () => ({ ...r }) })),
      };
    },
    count: () => ({
      async get() {
        const rows = applyState(name, state);
        return { data: () => ({ count: rows.length }) };
      },
    }),
    doc: (id) => docApi(name, id),
  });

  const docApi = (name, id) => ({
    id,
    async get() {
      const obj = col(name).get(id);
      return { id, exists: obj !== undefined, data: () => (obj ? { ...obj } : undefined) };
    },
    async set(obj, opts) {
      const current = col(name).get(id) || {};
      col(name).set(id, opts && opts.merge ? { ...current, ...obj } : { ...obj });
    },
    async update(obj) {
      if (!col(name).has(id)) throw new Error('no entity to update: ' + id);
      col(name).set(id, { ...(col(name).get(id) || {}), ...obj });
    },
    async delete() { col(name).delete(id); },
  });

  return {
    _store          : store,
    _declaredIndexes: indexDefs,
    _declareIndexes : declareIndexes,
    collection(name) {
      const api = queryApi(name, { filters: [], orderBy: null, limit: null, startAfterId: null });
      api.add = async (obj) => {
        const id = 'auto-' + Math.random().toString(36).slice(2, 10);
        col(name).set(id, { ...obj });
        return { id };
      };
      api.doc = (id) => docApi(name, id ?? 'auto-' + Math.random().toString(36).slice(2, 10));
      return api;
    },
    batch() {
      const ops = [];
      return {
        set   : (ref, obj, opts) => ops.push(() => ref.set(obj, opts)),
        update: (ref, obj) => ops.push(() => ref.update(obj)),
        delete: (ref) => ops.push(() => ref.delete()),
        commit: async () => { for (const op of ops) await op(); },
      };
    },
    runTransaction: async (fn) => fn({
      get    : async (ref) => ref.get(),
      set    : (ref, obj, opts) => { ref.set(obj, opts); },
      update : (ref, obj) => { ref.update(obj); },
    }),
  };
}

/* ═══════════════════════════════════════════════════════════════
   3. MOCK FOURNISSEUR SaaSPay (aucun appel réseau réel)
═══════════════════════════════════════════════════════════════ */
const provider = {
  configured      : true,
  createError     : null,
  checkouts       : {},          // checkoutId → { status, amount, currency, metadata }
  createCalls     : 0,
  statusCalls     : 0,
  createCheckout  : async ({ amount, currency, metadata }) => {
    provider.createCalls++;
    if (provider.createError) throw new Error(provider.createError);
    const id = 'ck_' + Math.random().toString(36).slice(2, 8);
    provider.checkouts[id] = { status: 'pending', amount, currency, metadata };
    return {
      checkoutId: id,
      paymentUrl: `https://pay.saspay.me/checkout/${id}`,
      status    : 'pending',
      expiresAt : '2026-12-31T23:59:59Z',
      amount,
      currency,
    };
  },
  getCheckoutStatus: async (checkoutId) => {
    provider.statusCalls++;
    const entry = provider.checkouts[checkoutId];
    if (!entry) throw new Error(`SaaSPay status error (404): checkout inconnu ${checkoutId}`);
    return {
      checkoutId,
      status       : entry.status,
      amount       : entry.amount,
      currency     : entry.currency,
      paidAt       : entry.status === 'paid' ? '2026-09-28T10:00:00Z' : null,
      paymentMethod: 'mobile_money',
      metadata     : entry.metadata || {},
      customer     : {},
      isPaid       : entry.status === 'paid',
    };
  },
  verifyWebhookSignature: (rawBody, signature) => signature === 'valid-hmac-signature',
  isConfigured    : () => provider.configured,
  validateAmount  : (amount, currency) => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error(`Montant invalide : ${amount}.`);
    const curr = String(currency || '').toUpperCase();
    if (!['XOF', 'EUR', 'USD', 'GHS', 'KES', 'NGN'].includes(curr)) throw new Error(`Devise non supportée : ${currency}.`);
    const MIN = { XOF: 100, EUR: 1, USD: 1, GHS: 1, KES: 1, NGN: 100 };
    if (amt < (MIN[curr] || 1)) throw new Error(`Montant minimum pour ${curr} : ${MIN[curr]}. Reçu : ${amt}.`);
  },
  getConfigStatus: () => ({ configured: provider.configured, provider: 'SaaSPay', baseUrl: 'https://api.saspay.me' }),
  maskSensitiveFields: (o) => o,
  PREMIUM_AMOUNT  : 2000,
  PREMIUM_CURRENCY: 'XOF',
};

/* ═══════════════════════════════════════════════════════════════
   4. HELPERS HTTP
═══════════════════════════════════════════════════════════════ */
let server = null;
let baseUrl = '';

function get(pathname, headers = {}) {
  return fetch(baseUrl + pathname, { headers });
}

function postJson(pathname, body, headers = {}) {
  return fetch(baseUrl + pathname, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body   : JSON.stringify(body ?? {}),
  });
}

async function jsonOf(res) {
  try { return await res.json(); } catch (_) { return null; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Attend qu'une condition devienne vraie (traitement webhook asynchrone) */
async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

function userDoc(db, uid) {
  return db._store.get('users')?.get(uid) || null;
}
function subCount(db, uid) {
  const subs = db._store.get('subscriptions') || new Map();
  return [...subs.values()].filter(s => s.userId === uid).length;
}
function paymentDoc(db, id) {
  return db._store.get('leekpay_payments')?.get(id) || null;
}

/* ═══════════════════════════════════════════════════════════════
   5. EXÉCUTION
═══════════════════════════════════════════════════════════════ */
(async () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   OmniSMS — Tests ADMIN + PAIEMENT (+ non-régression)    ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  /* ══════════════════════════════════════════════════════════
     PARTIE A — TESTS UNITAIRES (service réel, avant injection)
  ══════════════════════════════════════════════════════════ */
  console.log('\n━━━ PARTIE A — CONFIGURATION & SIGNATURE (unitaire) ━━━━━━━\n');

  await test('A1 — les variables LEEKPAY_* ne prennent jamais le dessus sur SasPay', async () => {
    const saved = {
      SAASPAY_API_KEY: process.env.SAASPAY_API_KEY,
      SAASPAY_SECRET_KEY: process.env.SAASPAY_SECRET_KEY,
      SAASPAY_BASE_URL: process.env.SAASPAY_BASE_URL,
      LEEKPAY_API_KEY: process.env.LEEKPAY_API_KEY,
      LEEKPAY_SECRET_KEY: process.env.LEEKPAY_SECRET_KEY,
      LEEKPAY_BASE_URL: process.env.LEEKPAY_BASE_URL,
    };
    try {
      delete process.env.SAASPAY_API_KEY;
      delete process.env.SAASPAY_SECRET_KEY;
      delete process.env.SAASPAY_BASE_URL;
      process.env.LEEKPAY_API_KEY = 'pk_legacy_value';
      process.env.LEEKPAY_SECRET_KEY = 'sk_legacy_value';
      process.env.LEEKPAY_BASE_URL = 'https://leekpay.fr';
      delete require.cache[require.resolve(path.join(ROOT, 'config/paymentEnv'))];
      const paymentEnv = require(path.join(ROOT, 'config/paymentEnv'));
      const result = paymentEnv.normalizePaymentEnv();
      const status = paymentEnv.getPaymentEnvStatus();
      assertEqual(result.applied.length, 0, 'aucune variable LeekPay recopiée');
      assertEqual(process.env.SAASPAY_SECRET_KEY, undefined, 'clé SasPay absente reste absente');
      assertEqual(process.env.SAASPAY_API_KEY, undefined, 'aucune ancienne clé publique recopiée');
      assertEqual(status.configured, false, 'ancienne clé seule ne configure pas SasPay');
      assert(status.missingRequired.includes('SAASPAY_SECRET_KEY'), 'clé SasPay requise');
      assert(status.baseUrl === 'https://api.saspay.me', 'base URL officielle par défaut sans env');
      assert(status.legacyPresent.includes('LEEKPAY_SECRET_KEY'), 'présence legacy diagnostiquée sans adoption');
      assert(!JSON.stringify(status).includes('sk_legacy_value'), 'aucun secret dans le statut');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      delete require.cache[require.resolve(path.join(ROOT, 'config/paymentEnv'))];
    }
  });

  await test('A2 — vérification de signature webhook : FAIL-CLOSED (absente → false)', async () => {
    process.env.SAASPAY_WEBHOOK_SECRET = 'whsec_test';
    process.env.SAASPAY_API_KEY        = 'pk_test';
    process.env.SAASPAY_SECRET_KEY     = 'sk_test';
    delete require.cache[require.resolve(path.join(ROOT, 'services/saaspay'))];
    const saaspay = require(path.join(ROOT, 'services/saaspay'));

    const body      = JSON.stringify({ event: 'payment.completed', data: { status: 'paid' } });
    const validSig  = crypto.createHmac('sha256', 'whsec_test').update(body, 'utf8').digest('hex');

    assertEqual(saaspay.verifyWebhookSignature(body, validSig), true,  'signature valide acceptée');
    assertEqual(saaspay.verifyWebhookSignature(body, 'deadbeef'), false, 'signature invalide rejetée');
    assertEqual(saaspay.verifyWebhookSignature(body, ''), false, 'signature absente refusée (fail-closed)');
    assertEqual(saaspay.verifyWebhookSignature(body, undefined), false, 'signature undefined refusée');

    assert(typeof saaspay.createCheckout === 'function',   'createCheckout exporté');
    assert(typeof saaspay.getCheckoutStatus === 'function','getCheckoutStatus exporté');
    assert(typeof saaspay.getConfigStatus === 'function',  'getConfigStatus exporté');
    assert(typeof saaspay.isConfigured === 'function',     'isConfigured exporté');

    const cfg = saaspay.getConfigStatus();
    assertEqual(cfg.configured, true, 'service considéré configuré');
    assert(!JSON.stringify(cfg).includes('sk_test'), 'aucun secret dans getConfigStatus()');
  });

  await test('A3 — sans variables SAASPAY_* : configuration absente (détectée explicitement)', async () => {
    const savedKey = process.env.SAASPAY_SECRET_KEY;
    const savedApi = process.env.SAASPAY_API_KEY;
    const savedLeg = process.env.LEEKPAY_API_KEY;
    const savedLeg2 = process.env.LEEKPAY_SECRET_KEY;
    try {
      delete process.env.SAASPAY_SECRET_KEY;
      delete process.env.SAASPAY_API_KEY;
      delete process.env.LEEKPAY_API_KEY;
      delete process.env.LEEKPAY_SECRET_KEY;
      delete require.cache[require.resolve(path.join(ROOT, 'config/paymentEnv'))];
      const paymentEnv = require(path.join(ROOT, 'config/paymentEnv'));
      const status = paymentEnv.getPaymentEnvStatus();
      assertEqual(status.configured, false, 'configuration détectée comme incomplète');
      assertEqual(status.missingRequired.length, 1, 'seule la clé API secrète est requise');
      assert(status.missingRequired.includes('SAASPAY_SECRET_KEY'), 'nom exact signalé');
      assert(!status.missingRequired.includes('SAASPAY_API_KEY'), 'clé séparée non requise par SasPay');
    } finally {
      if (savedKey) process.env.SAASPAY_SECRET_KEY = savedKey;
      if (savedApi) process.env.SAASPAY_API_KEY = savedApi;
      if (savedLeg) process.env.LEEKPAY_API_KEY = savedLeg;
      if (savedLeg2) process.env.LEEKPAY_SECRET_KEY = savedLeg2;
      delete require.cache[require.resolve(path.join(ROOT, 'config/paymentEnv'))];
    }
  });

  await test('A4 — contrat API SasPay : base par défaut, checkout 2000 XOF et statut PAID', async () => {
    const axios = require('axios');
    const saved = {
      SAASPAY_SECRET_KEY: process.env.SAASPAY_SECRET_KEY,
      SAASPAY_API_KEY: process.env.SAASPAY_API_KEY,
      SAASPAY_BASE_URL: process.env.SAASPAY_BASE_URL,
    };
    const originalPost = axios.post;
    const originalGet = axios.get;
    try {
      process.env.SAASPAY_SECRET_KEY = 'sk_test_contract';
      delete process.env.SAASPAY_API_KEY;
      delete process.env.SAASPAY_BASE_URL;
      delete require.cache[require.resolve(path.join(ROOT, 'services/saaspay'))];
      const saaspay = require(path.join(ROOT, 'services/saaspay'));
      let request;
      axios.post = async (url, body, options) => {
        request = { url, body, options };
        return { status: 201, data: {
          id: 'checkout-contract', checkout_url: 'https://pay.saspay.me/checkout/contract',
          status: 'PENDING', amount: '2000.00', currency: 'XOF',
        } };
      };
      const metadata = { userId: 'user-contract', orderId: 'order-contract', app: 'OmniSMS', webhookUrl: 'https://omnisms-backend.onrender.com/api/payment/webhook/saaspay' };
      const checkout = await saaspay.createCheckout({
        amount: 2000, currency: 'XOF', description: 'OmniSMS Premium',
        returnUrl: 'https://frontend.example/success', customerEmail: 'buyer@example.com',
        customerName: 'Buyer', metadata,
      });
      assertEqual(saaspay.isConfigured(), true, 'la clé secrète unique suffit');
      assertEqual(request.url, 'https://api.saspay.me/api/v1/checkout-sessions/', 'endpoint officiel checkout-sessions');
      assertEqual(request.body.amount, '2000.00', 'montant envoyé en décimal chaîne');
      assertEqual(request.body.currency, 'XOF', 'devise XOF');
      assertEqual(request.body.country, 'BF', 'pays Burkina Faso');
      assertEqual(request.body.metadata.orderId, metadata.orderId, 'metadata orderId conservée');
      assertEqual(request.options.headers.Authorization, 'Bearer sk_test_contract', 'auth Bearer secret SasPay');
      assertEqual(checkout.paymentUrl, 'https://pay.saspay.me/checkout/contract', 'checkout_url extraite');

      axios.get = async (url) => {
        assertEqual(url, 'https://api.saspay.me/api/v1/checkout-sessions/checkout-contract/', 'endpoint de détail officiel');
        return { status: 200, data: { id: 'checkout-contract', status: 'PAID', amount: '2000.00', currency: 'XOF' } };
      };
      const status = await saaspay.getCheckoutStatus('checkout-contract');
      assertEqual(status.isPaid, true, 'PAID fournisseur reconnu');
      assertEqual(Number(status.amount), 2000, 'montant de statut disponible pour vérification serveur');
    } finally {
      axios.post = originalPost;
      axios.get = originalGet;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      delete require.cache[require.resolve(path.join(ROOT, 'services/saaspay'))];
    }
  });

  /* ── Injection des mocks (Firestore + fournisseur) ── */
  const db = createFirestoreMock();
  require.cache[require.resolve(path.join(ROOT, 'config/firebase'))] = {
    id: 'mock-firebase', filename: 'mock-firebase', loaded: true, exports: db,
  };
  require.cache[require.resolve(path.join(ROOT, 'services/saaspay'))] = {
    id: 'mock-saaspay', filename: 'mock-saaspay', loaded: true, exports: provider,
  };
  /* Le contrôleur legacy (routes/payment.leekpay.js) utilise le même moteur */
  require.cache[require.resolve(path.join(ROOT, 'services/leekpay'))] = {
    id: 'mock-leekpay', filename: 'mock-leekpay', loaded: true, exports: provider,
  };

  /* Jeu de données de test (aucune donnée réelle) */
  db.collection('users').doc('user-premium').set({
    isSubscribed: true, updatedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
  });
  db.collection('users').doc('user-free').set({
    isSubscribed: false, updatedAt: '2026-09-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
  });
  db.collection('users').doc('user-free-2').set({
    isSubscribed: false, updatedAt: '2026-09-03T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
  });
  /* Paiements du système actuel (SaaSPay) */
  db.collection('leekpay_payments').doc('ck_paid_current').set({
    checkoutId: 'ck_paid_current', orderId: 'OMNI-LP-CURRENT', userId: 'user-premium',
    status: 'paid', amount: 2000, currency: 'XOF', premiumActivated: true,
    updatedAt: '2026-09-05T00:00:00.000Z',
  });
  db.collection('leekpay_payments').doc('OMNI-LP-PENDING').set({
    orderId: 'OMNI-LP-PENDING', userId: 'user-free', status: 'pending',
    amount: 2000, currency: 'XOF', premiumActivated: false, updatedAt: '2026-09-04T00:00:00.000Z',
  });
  /* Paiements historiques (legacy — ne doivent pas être perdus) */
  db.collection('payments_fusionpay').doc('legacy-paid-1').set({
    userId: 'user-premium', status: 'paid', amount: 2000, updatedAt: '2026-01-05T00:00:00.000Z',
  });
  db.collection('subscriptions').doc('sub-1').set({
    userId: 'user-premium', isSubscribed: true, createdAt: '2026-01-05T00:00:00.000Z',
  });

  /* App Express : routes réelles, mêmes protections que server.js */
  const express    = require(path.join(ROOT, 'node_modules/express'));
  const adminRoutes        = require(path.join(ROOT, 'routes/admin'));
  const paymentRoutes      = require(path.join(ROOT, 'routes/payment.saaspay'));
  const legacyRoutes       = require(path.join(ROOT, 'routes/payment.leekpay'));
  const legacyWebhookRoute = require(path.join(ROOT, 'routes/webhook'));

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use('/admin', adminRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/payment', paymentRoutes);
  app.use('/api/payment-legacy', legacyRoutes);      // twin legacy (rétrocompat)
  app.use('/api/payment-retro', legacyWebhookRoute); // ancien webhook /webhook

  server = http.createServer(app);
  server.unref();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  /* ══════════════════════════════════════════════════════════
     PARTIE B — ADMIN
  ══════════════════════════════════════════════════════════ */
  console.log('\n━━━ PARTIE B — ADMIN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const ADMIN_HEADERS = { 'x-admin-key': 'test-admin-key-1234' };

  await test('A4 — utilisateur non authentifié → 401 NO_ADMIN_KEY', async () => {
    const res = await get('/admin/stats');
    const body = await jsonOf(res);
    assertEqual(res.status, 401, 'statut HTTP');
    assertEqual(body.code, 'NO_ADMIN_KEY', 'code erreur');
  });

  await test('A5 — clé admin invalide → 403 INVALID_ADMIN_KEY', async () => {
    const res = await get('/admin/stats', { 'x-admin-key': 'mauvaise-cle' });
    const body = await jsonOf(res);
    assertEqual(res.status, 403, 'statut HTTP');
    assertEqual(body.code, 'INVALID_ADMIN_KEY', 'code erreur');
  });

  await test('A6 — clé admin valide → accès autorisé (200)', async () => {
    const res = await get('/admin/stats', ADMIN_HEADERS);
    assertEqual(res.status, 200, 'statut HTTP');
  });

  await test('A7 — clé surdimensionnée/affixée → 403 (aucun contournement, aucun crash)', async () => {
    const res = await get('/admin/stats', { 'x-admin-key': 'test-admin-key-1234-EXTRA' });
    assertEqual(res.status, 403, 'statut HTTP');
    const body = await jsonOf(res);
    assertEqual(body.code, 'INVALID_ADMIN_KEY', 'code erreur');
  });

  await test('A8 — en-tête x-admin-key dupliqué → 403/401 (jamais 500)', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/admin/stats', method: 'GET',
        headers: { 'x-admin-key': ['mauvaise', 'test-admin-key-1234'] },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert([401, 403].includes(status), `statut inattendu ${status}`);
  });

  await test('A9 — ADMIN_KEY absente en production → 503 ADMIN_NOT_CONFIGURED', async () => {
    const savedKey = process.env.ADMIN_KEY;
    const savedEnv = process.env.NODE_ENV;
    try {
      delete process.env.ADMIN_KEY;
      process.env.NODE_ENV = 'production';
      const res = await get('/admin/stats', { 'x-admin-key': 'peu-importe' });
      const body = await jsonOf(res);
      assertEqual(res.status, 503, 'statut HTTP');
      assertEqual(body.code, 'ADMIN_NOT_CONFIGURED', 'code erreur');
    } finally {
      process.env.ADMIN_KEY = savedKey;
      process.env.NODE_ENV  = savedEnv;
    }
  });

  await test('A10 — ADMIN_UIDS configuré : UID non listé → 403 (autorisation vérifiée)', async () => {
    const savedUids = process.env.ADMIN_UIDS;
    process.env.ADMIN_UIDS = 'uid-admin-autorise';
    try {
      /* Injecte un middleware Firebase simulé (jeton valide, UID non admin) */
      require.cache[require.resolve(path.join(ROOT, 'middleware/firebaseAuth'))] = {
        id: 'mock-fbauth', filename: 'mock-fbauth', loaded: true,
        exports: Object.assign(
          (req, res, next) => next(),
          { optionalFirebaseAuth: (req, _res, next) => { req.user = { uid: 'uid-inconnu', authType: 'firebase' }; next(); } }
        ),
      };
      const res = await get('/admin/stats', { authorization: 'Bearer jeton-simule' });
      const body = await jsonOf(res);
      assertEqual(res.status, 403, 'statut HTTP');
      assertEqual(body.code, 'FORBIDDEN', 'code erreur');
    } finally {
      if (savedUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedUids;
      delete require.cache[require.resolve(path.join(ROOT, 'middleware/firebaseAuth'))];
    }
  });

  await test('A11 — ADMIN_UIDS configuré : UID administrateur → accès autorisé', async () => {
    const savedUids = process.env.ADMIN_UIDS;
    process.env.ADMIN_UIDS = 'uid-admin-autorise';
    try {
      require.cache[require.resolve(path.join(ROOT, 'middleware/firebaseAuth'))] = {
        id: 'mock-fbauth', filename: 'mock-fbauth', loaded: true,
        exports: Object.assign(
          (req, res, next) => next(),
          { optionalFirebaseAuth: (req, _res, next) => { req.user = { uid: 'uid-admin-autorise', authType: 'firebase' }; next(); } }
        ),
      };
      const res = await get('/admin/stats', { authorization: 'Bearer jeton-simule' });
      assertEqual(res.status, 200, 'statut HTTP');
    } finally {
      if (savedUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedUids;
      delete require.cache[require.resolve(path.join(ROOT, 'middleware/firebaseAuth'))];
    }
  });

  await test('A12 — GET /admin/stats → compteurs Firestore corrects (2 collections de paiement)', async () => {
    const res = await get('/admin/stats', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.stats.totalUsers, 3, 'utilisateurs');
    assertEqual(body.stats.subscribedUsers, 1, 'abonnés actifs');
    assertEqual(body.stats.totalPayments, 3, 'paiements (2 SaaSPay + 1 legacy)');
    assertEqual(body.stats.successfulPayments, 2, 'paiements réussis');
    assertEqual(body.stats.subscriptions, 1, 'abonnements');
    assert(body.stats.paymentsBySource.leekpay_payments, 'détail par collection présent');
  });

  await test('A13 — GET /admin/users → liste paginée (aucun index composite requis)', async () => {
    const res = await get('/admin/users?limit=10', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.count, 3, 'nombre d’utilisateurs');
    assert(Array.isArray(body.users) && body.users[0].userId, 'format de réponse conservé');
  });

  await test('A14 — GET /admin/users?subscribed=true → filtre fonctionnel (ex-erreur d’index)', async () => {
    const res = await get('/admin/users?subscribed=true', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.count, 1, 'un seul abonné');
    assertEqual(body.users[0].userId, 'user-premium', 'utilisateur attendu');
  });

  await test('A15 — aucun index composite déclaré dans le mock (preuve de non-dépendance)', async () => {
    const res = await get('/admin/payments?status=paid&limit=10', ADMIN_HEADERS);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(db._declaredIndexes.length, 0, 'aucun index composite déclaré');
    assert(db._declaredIndexes.length === 0, 'les requêtes admin ne nécessitent aucun index composite');
  });

  await test('A16 — GET /admin/user/:userId → détail + paiements des 2 collections', async () => {
    const res = await get('/admin/user/user-premium', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.user.userId, 'user-premium', 'utilisateur');
    assertEqual(body.payments.length, 2, 'paiements fusionnés (SaaSPay + legacy)');
    const sources = body.payments.map(p => p.source).sort();
    assert(sources.includes('saaspay'), 'source SaaSPay présente');
    assert(sources.includes('legacy_fusionpay'), 'source legacy présente');
  });

  await test('A17 — GET /admin/user/:userId inconnu → 404 USER_NOT_FOUND', async () => {
    const res = await get('/admin/user/utilisateur-inexistant', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 404, 'statut HTTP');
    assertEqual(body.code, 'USER_NOT_FOUND', 'code erreur');
  });

  await test('A18 — GET /admin/payments → liste complète (SaaSPay + legacy)', async () => {
    const res = await get('/admin/payments?limit=50', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.count, 3, 'paiements listés');
    const ids = body.payments.map(p => p.id);
    assert(ids.includes('ck_paid_current'), 'paiement SaaSPay présent');
    assert(ids.includes('legacy-paid-1'), 'paiement legacy présent');
  });

  await test('A19 — GET /admin/payments?status=paid → filtre fonctionnel (ex-erreur d’index)', async () => {
    const res = await get('/admin/payments?status=paid', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.count, 2, 'deux paiements payés');
  });

  await test('A20 — GET /admin/payments?status=inexistant → 200 avec liste vide (pas 500)', async () => {
    const res = await get('/admin/payments?status=nawak', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.count, 0, 'aucun résultat');
  });

  await test('A21 — GET /admin/subscriptions → liste depuis Firestore', async () => {
    const res = await get('/admin/subscriptions', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.count, 1, 'un abonnement');
  });

  await test('A22 — POST /admin/user/:id/activate → abonnement activé + trace abonnement', async () => {
    const res = await postJson('/admin/user/user-free/activate', { reason: 'manual_admin' }, ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.success, true, 'succès');
    assertEqual(userDoc(db, 'user-free').isSubscribed, true, 'isSubscribed mis à jour');
    assertEqual(userDoc(db, 'user-free').paymentMethod, 'manual_admin', 'méthode enregistrée');
    assertEqual(subCount(db, 'user-free'), 1, 'document subscriptions créé');
  });

  await test('A23 — POST /admin/user/:id/activate (déjà abonné) → 409 ALREADY_SUBSCRIBED', async () => {
    const res = await postJson('/admin/user/user-free/activate', {}, ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 409, 'statut HTTP');
    assertEqual(body.code, 'ALREADY_SUBSCRIBED', 'code erreur');
  });

  await test('A24 — POST /admin/user/:id/deactivate sans raison → 400 REASON_REQUIRED', async () => {
    const res = await postJson('/admin/user/user-free/deactivate', {}, ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 400, 'statut HTTP');
    assertEqual(body.code, 'REASON_REQUIRED', 'code erreur');
  });

  await test('A25 — POST /admin/user/:id/deactivate avec raison → abonnement désactivé', async () => {
    const res = await postJson('/admin/user/user-free/deactivate', { reason: 'remboursement client' }, ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.success, true, 'succès');
    assertEqual(userDoc(db, 'user-free').isSubscribed, false, 'isSubscribed remis à false');
  });

  await test('A26 — route admin inconnue → 404 JSON (jamais de HTML)', async () => {
    const res = await get('/admin/route-inexistante', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 404, 'statut HTTP');
    assertEqual(body.code, 'ADMIN_ROUTE_NOT_FOUND', 'code erreur');
  });

  await test('A27 — /api/admin alias protégé de la même façon (401 sans clé)', async () => {
    const res = await get('/api/admin/stats');
    assertEqual(res.status, 401, 'statut HTTP');
  });

  await test('A28 — /api/admin alias accessible avec la clé admin', async () => {
    const res = await get('/api/admin/users?limit=5', ADMIN_HEADERS);
    assertEqual(res.status, 200, 'statut HTTP');
  });

  await test('A29 — GET /admin/health → statut + configuration paiement masquée', async () => {
    const res = await get('/admin/health', ADMIN_HEADERS);
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.firestore.ok, true, 'Firestore joignable');
    assert(body.payment && body.payment.provider === 'SaaSPay', 'configuration paiement exposée');
  });

  /* ══════════════════════════════════════════════════════════
     PARTIE C — PAIEMENT
  ══════════════════════════════════════════════════════════ */
  console.log('\n━━━ PARTIE C — PAIEMENT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const SIGNED = { 'x-saaspay-signature': 'valid-hmac-signature' };

  await test('P1 — configuration valide → création de paiement possible', async () => {
    provider.configured = true;
    const res = await postJson('/api/payment/leekpay', { userId: 'user-free-2', amount: 2000 });
    assertEqual(res.status, 200, 'statut HTTP');
  });

  await test('P2 — configuration manquante → 503 SAASPAY_NOT_CONFIGURED (aucun appel fournisseur)', async () => {
    provider.configured = false;
    const before = provider.createCalls;
    const res = await postJson('/api/payment/leekpay', { userId: 'user-free-2' });
    const body = await jsonOf(res);
    assertEqual(res.status, 503, 'statut HTTP');
    assertEqual(body.code, 'SAASPAY_NOT_CONFIGURED', 'code erreur');
    assertEqual(provider.createCalls, before, 'aucun appel au fournisseur');
    provider.configured = true;
  });

  await test('P3 — création du paiement → URL de checkout + enregistrement pending', async () => {
    const res = await postJson('/api/payment/leekpay', { userId: 'user-free-2', amount: 2000 });
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.success, true, 'succès');
    assert(body.payment_url && body.payment_url.startsWith('https://'), 'URL de paiement fournie');
    assert(body.checkout_id, 'checkout_id fourni');
    assertEqual(body.amount, 2000, 'montant renvoyé');

    const record = paymentDoc(db, body.checkout_id);
    assert(record, 'enregistrement Firestore créé');
    assertEqual(record.userId, 'user-free-2', 'utilisateur enregistré côté serveur');
    assertEqual(record.status, 'pending', 'statut initial');
    assertEqual(record.premiumActivated, false, 'Premium non activé à la création');
  });

  await test('P4 — montant valide (2000 XOF) → accepté', async () => {
    const res = await postJson('/api/payment/leekpay', { userId: 'user-free-2', amount: 2000, currency: 'XOF' });
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.currency, 'XOF', 'devise');
  });

  await test('P5 — montant invalide (10 XOF) → 400 INVALID_AMOUNT', async () => {
    const res = await postJson('/api/payment/leekpay', { userId: 'user-free-2', amount: 10 });
    const body = await jsonOf(res);
    assertEqual(res.status, 400, 'statut HTTP');
    assertEqual(body.code, 'INVALID_AMOUNT', 'code erreur');
  });

  await test('P5b — devise invalide (XXX) → 400 INVALID_AMOUNT', async () => {
    const res = await postJson('/api/payment/leekpay', { userId: 'user-free-2', currency: 'XXX' });
    const body = await jsonOf(res);
    assertEqual(res.status, 400, 'statut HTTP');
    assertEqual(body.code, 'INVALID_AMOUNT', 'code erreur');
  });

  await test('P5c — userId absent → 400 MISSING_USER_ID', async () => {
    const res = await postJson('/api/payment/leekpay', {});
    const body = await jsonOf(res);
    assertEqual(res.status, 400, 'statut HTTP');
    assertEqual(body.code, 'MISSING_USER_ID', 'code erreur');
  });

  await test('P5d — utilisateur déjà Premium → 400 ALREADY_SUBSCRIBED', async () => {
    const res = await postJson('/api/payment/leekpay', { userId: 'user-premium' });
    const body = await jsonOf(res);
    assertEqual(res.status, 400, 'statut HTTP');
    assertEqual(body.code, 'ALREADY_SUBSCRIBED', 'code erreur');
  });

  await test('P6 — paiement confirmé (webhook signé) → Premium activé', async () => {
    /* Création d'un checkout puis confirmation par le fournisseur */
    const create = await postJson('/api/payment/leekpay', { userId: 'user-free-2', amount: 2000 });
    const { checkout_id: checkoutId } = await jsonOf(create);
    provider.checkouts[checkoutId].status = 'paid';

    const res = await postJson('/api/payment/webhook/saaspay', {
      event: 'payment.completed',
      data : { checkout_id: checkoutId, status: 'paid', amount: 2000, currency: 'XOF',
               transaction_id: 'TXN-TEST-1', payment_method: 'mobile_money',
               metadata: { userId: 'user-free-2' } },
    }, SIGNED);
    assertEqual(res.status, 200, 'webhook acquitté en 200');

    const activated = await waitFor(() => userDoc(db, 'user-free-2')?.isSubscribed === true);
    assert(activated, 'utilisateur passé Premium');
    assertEqual(subCount(db, 'user-free-2'), 1, 'une entrée d’abonnement');
    assertEqual(paymentDoc(db, checkoutId).premiumActivated, true, 'paiement marqué activé');
  });

  await test('P7 — paiement refusé (status failed) → aucun Premium activé', async () => {
    /* Réinitialisation de l'utilisateur AVANT la création (isolation du scénario) */
    db.collection('users').doc('user-free-2').set({ isSubscribed: false, updatedAt: '2026-09-02T00:00:00.000Z' });

    const create = await postJson('/api/payment/leekpay', { userId: 'user-free-2', amount: 2000 });
    const createBody = await jsonOf(create);
    assertEqual(create.status, 200, 'checkout créé');
    const checkoutId = createBody.checkout_id;

    const res = await postJson('/api/payment/webhook/saaspay', {
      event: 'payment.failed',
      data : { checkout_id: checkoutId, status: 'failed', amount: 2000, currency: 'XOF' },
    }, SIGNED);
    assertEqual(res.status, 200, 'webhook acquitté');

    await waitFor(() => paymentDoc(db, checkoutId)?.status === 'failed');
    assertEqual(userDoc(db, 'user-free-2').isSubscribed, false, 'aucun Premium activé');
    assertEqual(paymentDoc(db, checkoutId)?.status, 'failed', 'statut du paiement enregistré');
  });

  await test('P8 — identification serveur : userId de l’enregistrement fait foi (anti-fraude)', async () => {
    const create = await postJson('/api/payment/leekpay', { userId: 'user-premium-owner', amount: 2000 });
    const { checkout_id: checkoutId } = await jsonOf(create);

    db.collection('users').doc('user-premium-owner').set({ isSubscribed: false });
    db.collection('users').doc('attaquant').set({ isSubscribed: false });
    provider.checkouts[checkoutId].status = 'paid';
    provider.checkouts[checkoutId].metadata = { userId: 'user-premium-owner' };

    /* Le webhook prétend que l'acheteur est l'attaquant */
    await postJson('/api/payment/webhook/saaspay', {
      event: 'payment.completed',
      data : { checkout_id: checkoutId, status: 'paid', amount: 2000, currency: 'XOF',
               metadata: { userId: 'attaquant' } },
    }, SIGNED);

    await waitFor(() => userDoc(db, 'user-premium-owner')?.isSubscribed === true);
    assertEqual(userDoc(db, 'attaquant').isSubscribed, false, 'l’attaquant n’est PAS crédité');
    assertEqual(userDoc(db, 'user-premium-owner').isSubscribed, true, 'le propriétaire du checkout est crédité');
  });

  await test('P9 — activation Premium correcte (champs Firestore + abonnement)', async () => {
    const uid = 'user-premium-owner';
    const user = userDoc(db, uid);
    assertEqual(user.isSubscribed, true, 'isSubscribed');
    assert(user.subscribedAt, 'subscribedAt renseigné');
    assert(user.transactionId, 'transactionId renseigné');
    assertEqual(subCount(db, uid), 1, 'une seule entrée subscriptions');
  });

  await test('P10 — idempotence : rejeu du webhook → une seule activation', async () => {
    const before = subCount(db, 'user-premium-owner');
    let checkoutId = null;
    for (const [id, entry] of Object.entries(provider.checkouts)) {
      if (entry.metadata?.userId === 'user-premium-owner') checkoutId = id;
    }
    assert(checkoutId, 'checkout retrouvé');

    await postJson('/api/payment/webhook/saaspay', {
      event: 'payment.completed',
      data : { checkout_id: checkoutId, status: 'paid', amount: 2000, currency: 'XOF',
               metadata: { userId: 'user-premium-owner' } },
    }, SIGNED);

    await sleep(300);
    assertEqual(subCount(db, 'user-premium-owner'), before, 'aucune activation supplémentaire');
  });

  await test('P11 — erreur fournisseur → 502, aucun Premium activé', async () => {
    provider.createError = 'SaaSPay API error (500): boom';
    const res = await postJson('/api/payment/leekpay', { userId: 'user-free-2', amount: 2000 });
    const body = await jsonOf(res);
    provider.createError = null;

    assertEqual(res.status, 502, 'statut HTTP');
    assertEqual(body.success, false, 'échec signalé');
    assertEqual(userDoc(db, 'user-free-2').isSubscribed, false, 'aucun Premium activé');
  });

  await test('P12 — webhook falsifié (sans signature, non confirmé par le fournisseur) → refusé', async () => {
    db.collection('users').doc('attaquant').set({ isSubscribed: false });

    await postJson('/api/payment/webhook/saaspay', {
      event: 'payment.completed',
      data : { checkout_id: 'ck_inexistant_chez_le_fournisseur', status: 'paid',
               amount: 2000, currency: 'XOF', metadata: { userId: 'attaquant' } },
    });

    await sleep(400);
    assertEqual(userDoc(db, 'attaquant').isSubscribed, false,
      'aucune activation Premium sur simple réponse falsifiée');
  });

  await test('P12b — montant falsifié (< montant attendu) → activation refusée', async () => {
    const create = await postJson('/api/payment/leekpay', { userId: 'user-fraude-montant', amount: 2000 });
    const { checkout_id: checkoutId } = await jsonOf(create);
    db.collection('users').doc('user-fraude-montant').set({ isSubscribed: false });

    /* Le fournisseur confirme bien un paiement… de 2000, le webhook en annonce 500 */
    provider.checkouts[checkoutId].status = 'paid';

    await postJson('/api/payment/webhook/saaspay', {
      event: 'payment.completed',
      data : { checkout_id: checkoutId, status: 'paid', amount: 500, currency: 'XOF',
               metadata: { userId: 'user-fraude-montant' } },
    }, SIGNED);

    await sleep(400);
    assertEqual(userDoc(db, 'user-fraude-montant').isSubscribed, false, 'remise non appliquée');
  });

  await test('P12c — /poll avec un userId étranger → le propriétaire réel est crédité', async () => {
    db.collection('users').doc('user-proprietaire').set({ isSubscribed: false });
    db.collection('users').doc('attaquant').set({ isSubscribed: false });
    db.collection('leekpay_payments').doc('ck_poll_owned').set({
      checkoutId: 'ck_poll_owned', orderId: 'OMNI-LP-POLL', userId: 'user-proprietaire',
      status: 'paid', amount: 2000, currency: 'XOF', premiumActivated: false,
    });
    provider.checkouts['ck_poll_owned'] = {
      status: 'paid', amount: 2000, currency: 'XOF', metadata: { userId: 'user-proprietaire' },
    };

    const res = await postJson('/api/payment/poll/ck_poll_owned', { userId: 'attaquant' });
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.callerPremium, false, 'l’appelant n’est pas Premium');
    assertEqual(body.activatedUserId, 'user-proprietaire', 'utilisateur crédité = propriétaire');
    assertEqual(userDoc(db, 'attaquant').isSubscribed, false, 'attaquant non crédité');
    assertEqual(userDoc(db, 'user-proprietaire').isSubscribed, true, 'propriétaire crédité');
  });

  await test('P13 — /poll légitime → Premium + callerPremium = true', async () => {
    db.collection('users').doc('user-poll-legit').set({ isSubscribed: false });
    db.collection('leekpay_payments').doc('ck_poll_legit').set({
      checkoutId: 'ck_poll_legit', orderId: 'OMNI-LP-POLL-2', userId: 'user-poll-legit',
      status: 'paid', amount: 2000, currency: 'XOF', premiumActivated: false,
    });
    provider.checkouts['ck_poll_legit'] = {
      status: 'paid', amount: 2000, currency: 'XOF', metadata: { userId: 'user-poll-legit' },
    };

    const res = await postJson('/api/payment/poll/ck_poll_legit', { userId: 'user-poll-legit' });
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.isPaid, true, 'paiement confirmé');
    assertEqual(body.callerPremium, true, 'utilisateur Premium');
    assertEqual(userDoc(db, 'user-poll-legit').isSubscribed, true, 'Premium activé en base');
  });

  await test('P14 — GET /api/payment/status/:id → statut depuis Firestore', async () => {
    const res = await get('/api/payment/status/ck_paid_current');
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.status, 'paid', 'statut du paiement');
    assertEqual(body.premiumActivated, true, 'Premium déjà activé');
  });

  await test('P15 — GET /api/payment/status/:id inconnu → 404 NOT_FOUND', async () => {
    const res = await get('/api/payment/status/ck-inconnu-xyz');
    const body = await jsonOf(res);
    assertEqual(res.status, 404, 'statut HTTP');
    assertEqual(body.success, false, 'échec signalé');
  });

  await test('P16 — GET /api/payment/user-status → statut Premium utilisateur', async () => {
    const res = await get('/api/payment/user-status?userId=user-premium');
    const body = await jsonOf(res);
    assertEqual(res.status, 200, 'statut HTTP');
    assertEqual(body.premium, true, 'utilisateur Premium');
  });

  await test('P17 — GET /api/payment/user-status sans userId → 400 MISSING_USER_ID', async () => {
    const res = await get('/api/payment/user-status');
    const body = await jsonOf(res);
    assertEqual(res.status, 400, 'statut HTTP');
    assertEqual(body.code, 'MISSING_USER_ID', 'code erreur');
  });

  await test('P18 — aucun secret dans les réponses HTTP de paiement', async () => {
    provider.configured = false;
    const res = await postJson('/api/payment/leekpay', { userId: 'user-free-2' });
    const text = await res.text();
    provider.configured = true;
    assert(!text.includes('sk_'), 'aucune clé secrète exposée');
    assert(!text.includes('pk_'), 'aucune clé publique exposée');
  });

  /* ══════════════════════════════════════════════════════════
     PARTIE D — NON-RÉGRESSION (contrats backend conservés)
  ══════════════════════════════════════════════════════════ */
  console.log('\n━━━ PARTIE D — NON-RÉGRESSION ━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const fs = require('fs');

  await test('N1 — routes de paiement historiques conservées (+ nouveau webhook)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/payment.leekpay.js'), 'utf8');
    assert(src.includes("'/webhook/leekpay'"), 'webhook leekpay conservé');
    assert(src.includes("'/status/:transactionId'"), 'route status conservée');
    assert(src.includes("'/user-status'"), 'route user-status conservée');
    assert(src.includes("'/poll/:checkoutId'"), 'route poll conservée');

    const srcNew = fs.readFileSync(path.join(ROOT, 'routes/payment.saaspay.js'), 'utf8');
    assert(srcNew.includes("'/webhook/saaspay'"), 'webhook saaspay présent');
    assert(srcNew.includes("'/leekpay'"), 'route /leekpay (compat frontend) conservée');
  });

  await test('N2 — server.js : admin + paiement (legacy et nouveau) toujours montés', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert(src.includes("app.use('/admin'"), 'routes admin montées');
    assert(src.includes('payment.saaspay'), 'routes saaspay montées');
    assert(src.includes('payment.leekpay'), 'routes leekpay (legacy) montées');
    assert(src.includes('SAASPAY_SECRET_KEY'), 'clé API SasPay vérifiée');
  });

  await test('N3 — services/saaspay.js : aucun nom de variable legacy (contrainte Session 12)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'services/saaspay.js'), 'utf8');
    assert(src.includes('SAASPAY_SECRET_KEY'), 'SAASPAY_SECRET_KEY utilisé');
    assert(src.includes('SAASPAY_API_KEY'), 'SAASPAY_API_KEY utilisé');
    assert(!src.includes('LEEKPAY_SECRET_KEY') && !src.includes('LEEKPAY_API_KEY'), 'aucune variable legacy');
    assert(src.includes('api.saspay.me'), 'URL API SasPay officielle présente');
    assert(!src.includes('leekpay.fr'), 'URL LeekPay absente');
  });

  await test('N4 — routes/admin.js : tous les endpoints conservés et protégés', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/admin.js'), 'utf8');
    for (const route of ["'/health'", "'/stats'", "'/users'", "'/user/:userId'",
                         "'/user/:userId/activate'", "'/user/:userId/deactivate'",
                         "'/payments'", "'/subscriptions'"]) {
      assert(src.includes(`router.get(${route}`) || src.includes(`router.post(${route}`),
        `route ${route} conservée`);
    }
    assert(src.includes('router.use(adminRateLimiter, requireAdminAuth)'), 'protections appliquées à toutes les routes');
    assert(src.includes('ADMIN_KEY'), 'clé admin vérifiée');
  });

  await test('N5 — collections de paiement : legacy conservée, actuelle supportée', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/admin.js'), 'utf8');
    assert(src.includes('leekpay_payments'), 'collection actuelle lue');
    assert(src.includes('payments_fusionpay'), 'collection historique conservée');
  });

  await test('N6 — modules hors périmètre inchangés (exports critiques intacts)', async () => {
    const messageRouter = require(path.join(ROOT, 'services/messageRouter'));
    const userResolver  = require(path.join(ROOT, 'services/userResolver'));
    const phoneNormalizer = require(path.join(ROOT, 'services/phoneNormalizer'));
    assert(typeof messageRouter.routeMessage === 'function', 'messageRouter.routeMessage');
    assert(typeof userResolver.resolveUserByPhone === 'function' || typeof userResolver.resolvePhoneToUid === 'function',
      'résolution phone → UID');
    assert(typeof phoneNormalizer.normalizePhone === 'function', 'normalizePhone');
  });

  await test('N7 — authentification messages/auth intacte (fichiers non modifiés)', async () => {
    const authSrc = fs.readFileSync(path.join(ROOT, 'middleware/firebaseAuth.js'), 'utf8');
    assert(authSrc.includes('verifyIdToken'), 'vérification Firebase conservée');
    assert(authSrc.includes('verifyJwtToken'), 'fallback JWT conservé');
    const messagesSrc = fs.readFileSync(path.join(ROOT, 'routes/messages.v2.js'), 'utf8');
    assert(messagesSrc.length > 1000, 'routes messages v2 présentes');
  });

  await test('N8 — contrôleur legacy : création + webhook signé → Premium activé (même moteur)', async () => {
    db.collection('users').doc('user-legacy').set({ isSubscribed: false, updatedAt: '2026-09-10T00:00:00.000Z' });

    const create = await postJson('/api/payment-legacy/leekpay', { userId: 'user-legacy', amount: 2000 });
    const createBody = await jsonOf(create);
    assertEqual(create.status, 200, 'checkout legacy créé');
    const checkoutId = createBody.checkout_id;
    assert(checkoutId, 'checkout_id fourni');

    provider.checkouts[checkoutId].status = 'paid';

    const res = await postJson('/api/payment-legacy/webhook/leekpay', {
      event: 'payment.completed',
      data : { checkout_id: checkoutId, status: 'paid', amount: 2000, currency: 'XOF',
               metadata: { userId: 'user-legacy' } },
    }, SIGNED);
    assertEqual(res.status, 200, 'webhook legacy acquitté');

    const activated = await waitFor(() => userDoc(db, 'user-legacy')?.isSubscribed === true);
    assert(activated, 'Premium activé via le contrôleur legacy');
    assertEqual(subCount(db, 'user-legacy'), 1, 'une entrée d’abonnement');
  });

  await test('N9 — ancien endpoint POST /api/payment/webhook toujours opérationnel', async () => {
    db.collection('users').doc('user-retro').set({ isSubscribed: false, updatedAt: '2026-09-10T00:00:00.000Z' });
    db.collection('leekpay_payments').doc('ck_retro').set({
      checkoutId: 'ck_retro', orderId: 'OMNI-LP-RETRO', userId: 'user-retro',
      status: 'paid', amount: 2000, currency: 'XOF', premiumActivated: false,
    });
    provider.checkouts['ck_retro'] = {
      status: 'paid', amount: 2000, currency: 'XOF', metadata: { userId: 'user-retro' },
    };

    const res = await postJson('/api/payment-retro/webhook', {
      event: 'payment.completed',
      data : { checkout_id: 'ck_retro', status: 'paid', amount: 2000, currency: 'XOF',
               metadata: { userId: 'user-retro' } },
    }, SIGNED);
    assertEqual(res.status, 200, 'route rétrocompat acquittée');

    const activated = await waitFor(() => userDoc(db, 'user-retro')?.isSubscribed === true);
    assert(activated, 'Premium activé via /api/payment/webhook');
  });

  /* ── Nettoyage ── */
  server.close();

  /* ══════════════════════════════════════════════════════════
     RÉSUMÉ
  ══════════════════════════════════════════════════════════ */
  const total = passed + failed;
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log(`║  Résultats : ${passed} PASS / ${failed} FAIL / ${total} total`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log('\n❌ Échecs :');
    failures.forEach(f => console.log(`   • ${f.name} → ${f.message}`));
    process.exit(1);
  }
  console.log('\n✅ Tous les tests Admin + Paiement passent.');
  process.exit(0);

})().catch(err => {
  console.error('\nERREUR FATALE TESTS ADMIN/PAIEMENT :', err);
  process.exit(1);
});
