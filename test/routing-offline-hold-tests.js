'use strict';
/**
 * Tests — Politique de routage offline (ROUTE_OFFLINE_HOLD) + livraison
 * à la reconnexion + idempotence. Stubs mémoire : aucun SMS réel, aucun
 * quota consommé.
 */
process.env.LOG_LEVEL = 'error';
process.env.ROUTE_OFFLINE_HOLD = 'true'; // DÉFAUT (politique interne d'abord) — les scénarios legacy forcent 'false'
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ── Firestore mémoire (where chainable sur messages) ── */
function makeDb() {
  const store = new Map();
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), ref: docRef(col, id) }; },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => { Object.assign(colMap(col).get(id) || {}, JSON.parse(JSON.stringify(data))); },
    delete: async () => colMap(col).delete(id),
  });
  let auto = 0;
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id || `auto-${++auto}`),
      add: async (data) => { const id = `auto-${++auto}`; colMap(name).set(id, JSON.parse(JSON.stringify(data))); return { id, ref: docRef(name, id) }; },
      where(f1, op1, v1) {
        const filters = [[f1, op1, v1]];
        return {
          where(f2, op2, v2) { filters.push([f2, op2, v2]); return this; },
          whereFns: filters,
          limit(n) {
            return {
              async get() {
                let docs = [...colMap(name).entries()].map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: docRef(name, id) }));
                for (const [f, op, v] of this.whereFns || filters) docs = docs.filter((x) => x.data()[f] === v);
                return { docs: docs.slice(0, n) };
              },
            };
          },
          async get() { return (await this.limit(1000)).get ? (await this.limit(1000)).get() : { docs: [] }; },
        };
      },
    }),
  };
}
const db = makeDb();
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: db };

/* ── Stubs : gateway SMS (compteur), présence contrôlée, résolution ── */
const gatewayState = { calls: [] };
require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gw', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: {
  isSmsGatewayProvider: () => true,
  isConfigured: () => true,
  sendSMS: async (opts) => { gatewayState.calls.push(opts); return { success: true, gatewayMessageId: 'stub-1' }; },
} };
require.cache[path.join(ROOT, 'services', 'infobip.js')] = { id: 'ib', filename: path.join(ROOT, 'services/infobip.js'), loaded: true, exports: { isConfigured: () => false } };

const presence = { online: new Set(['uid-dest-online']) };
const emissions = [];
require.cache[path.join(ROOT, 'services', 'socketService.js')] = { id: 'sk', filename: path.join(ROOT, 'services/socketService.js'), loaded: true, exports: {
  isUserOnline: async (uid) => presence.online.has(uid),
  getIO: () => null,
  emitToUser: (uid, event, data) => emissions.push({ uid, event, data }),
  deliverPendingMessages: async () => 0,
} };
require.cache[path.join(ROOT, 'services', 'userResolver.js')] = { id: 'ur', filename: path.join(ROOT, 'services/userResolver.js'), loaded: true, exports: {
  resolveUserByPhone: async (phone) => phone === '+22670000002'
    ? { found: true, uid: 'uid-dest-offline', phone: '+22670000002', name: 'Destinataire Offline' }
    : phone === '+22670000001'
      ? { found: true, uid: 'uid-dest-online', phone: '+22670000001', name: 'Destinataire Online' }
      : { found: false },
  resolveUserByUid: async (uid) => ({ found: true, uid, phone: uid === 'uid-dest-online' ? '+22670000001' : '+22670000002' }),
  normalizeEmail: (e) => String(e || '').toLowerCase(),
} };
require.cache[path.join(ROOT, 'services', 'queueService.js')] = { id: 'qs', filename: path.join(ROOT, 'services/queueService.js'), loaded: true, exports: {
  addSmsJob: async () => ({ queued: true }), addJob: async () => ({ queued: true }), createWorker: () => ({}),
} };

const router = require(path.join(ROOT, 'services', 'messageRouter.js'));
const socketSvc = require(path.join(ROOT, 'services', 'socketService.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

(async () => {
  const base = { senderUid: 'uid-sender', content: 'salut', type: 'text', senderName: 'Awa', senderPhone: '+22670000099' };

  /* ── 1. Connecté (APK ou PWA) → interne, aucun SMS ── */
  let r = await router.routeMessage({ ...base, targetPhone: '+22670000001' });
  check('destinataire CONNECTÉ (apk) → route OMNISMS, status sent, 0 SMS', r.route === 'OMNISMS' && !r.held && r.message.status === 'sent' && gatewayState.calls.length === 0);

  /* ── 2. Hors ligne, ROUTE_OFFLINE_HOLD=false → comportement historique : SMS ── */
  process.env.ROUTE_OFFLINE_HOLD = 'false';
  r = await router.routeMessage({ ...base, targetPhone: '+22670000002' });
  check('flag =false → repli SMS historique vers le numéro du destinataire', r.route === 'SMS_EXTERNE' && gatewayState.calls.length === 1 && String(gatewayState.calls[0].to).endsWith('000002'));
  check('aucune émission Socket.IO pour un hors ligne (flag OFF)', !emissions.some((e) => e.uid === 'uid-dest-offline'));

  /* ── 3. Hors ligne, flag ON (défaut) → attente interne, AUCUN SMS ── */
  process.env.ROUTE_OFFLINE_HOLD = 'true';
  const sentBefore = gatewayState.calls.length;
  r = await router.routeMessage({ ...base, targetPhone: '+22670000002', content: 'message en attente' });
  check('flag ON (défaut) → route OMNISMS + held:true + status pending', r.route === 'OMNISMS' && r.held === true && r.status === 'pending');
  check('flag ON → aucun SMS de plus', gatewayState.calls.length === sentBefore);
  const heldDoc = [...db._store.get('messages').values()].find((d) => d.status === 'pending' && d.channel === 'app' && d.receiverId === 'uid-dest-offline');
  check('message conservé en Firestore (channel app, status pending)', !!heldDoc);

  /* ── 4. Externe (sans compte) → SMS inchangé même avec le flag ON ── */
  const extBefore = gatewayState.calls.length;
  r = await router.routeMessage({ ...base, targetPhone: '+22675407000' });
  check('destinataire EXTERNE → SMS conservé (flag ON sans effet)', r.route === 'SMS_EXTERNE' && gatewayState.calls.length === extBefore + 1);

  /* ── 5. Retour en ligne → livraison immédiate normale ── */
  presence.online.add('uid-dest-offline');
  r = await router.routeMessage({ ...base, targetPhone: '+22670000002' });
  check('redevient connecté → interne sent (pas de hold)', r.route === 'OMNISMS' && !r.held && r.message.status === 'sent');
  presence.online.delete('uid-dest-offline');
  process.env.ROUTE_OFFLINE_HOLD = 'false';

  /* ── 6. Livraison à la reconnexion : claim AVANT émission (idempotence) ── */
  // Charger le VRAI socketService (deliverPendingMessages) — routeMessage étant
  // paresseux, les tests 1-5 ont bien utilisé le stub de présence.
  const realSocket = (() => {
    const p = path.join(ROOT, 'services', 'socketService.js');
    delete require.cache[p];
    delete require.cache[path.join(ROOT, 'services', 'redis.js')];
    const real = require(p);
    require.cache[p] = { id: 'sk', filename: p, loaded: true, exports: real };
    return real;
  })();
  // message en attente dans le store (celui du test 3)
  const pendingId = heldDoc.id || [...db._store.get('messages').entries()].find(([, d]) => d.status === 'pending')?.[0];
  const emissionsReal = [];
  // émettre via le VRAI socketService : la room n'existe pas (io null) → emitToUser est un no-op silencieux ;
  // on vérifie le CLAIM (status pending → sent) qui est la garantie d'idempotence.
  const delivered = await realSocket.deliverPendingMessages('uid-dest-offline');
  check('deliverPendingMessages réclame le message en attente (≥1)', delivered >= 1, delivered);
  const claimed = [...db._store.get('messages').values()].find((d) => d.status === 'sent' && d.deliveredVia === 'reconnect');
  check('claim avant émission : status=sent + deliveredVia=reconnect', !!claimed);
  const again = await realSocket.deliverPendingMessages('uid-dest-offline');
  check('2e appel après reconnexion rapide → 0 nouvelle livraison (pas de double envoi)', again === 0, again);

  console.log(failures === 0 ? '\nTESTS ROUTAGE OFFLINE HOLD OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
