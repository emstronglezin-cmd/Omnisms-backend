'use strict';
/**
 * Tests — SUPPRESSION DÉFINITIVE d'INfiniReach (SMSGate exclusivement).
 * Vérifie qu'aucune configuration legacy ne peut plus être sélectionnée ni
 * appelée, que le démarrage annonce SMSGATE, et que le routage offline /
 * sans compte reste opérationnel via SMSGate. Tout est simulé (HTTP local).
 */
process.env.LOG_LEVEL = 'error';
delete process.env.REDIS_URL;

const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const MOCK = { posts: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') { res.writeHead(404); return res.end('{}'); }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
      let b = {}; try { b = JSON.parse(body || '{}'); } catch (_) {}
      MOCK.posts.push({ to: (b.phoneNumbers || [])[0], text: typeof b.message === 'string' ? b.message : '' });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: [`gw-ir-${MOCK.posts.length}`] }));
    }
    res.writeHead(404); res.end('{}');
  });
});

function makeDb() {
  const store = new Map();
  let auto = 0;
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), ref: docRef(col, id) }; },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => { Object.assign(colMap(col).get(id) || {}, JSON.parse(JSON.stringify(data))); },
    delete: async () => colMap(col).delete(id),
  });
  return {
    _store: store,
    collection: (name) => ({
      doc: (id) => docRef(name, id || `auto-${++auto}`),
      add: async (data) => { const id = `auto-${++auto}`; colMap(name).set(id, JSON.parse(JSON.stringify(data))); return { id, ref: docRef(name, id) }; },
      where(f1, _op, v1) { return { limit(n) { return { async get() {
        const docs = [...colMap(name).entries()].filter(([, d]) => d[f1] === v1).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: docRef(name, id) }));
        return { docs: docs.slice(0, n) };
      } }; }, async get() { return { docs: [] }; } }; },
    }),
  };
}

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra ?? null).slice(0, 240)}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, '127.0.0.1', async () => {
  const PORT = server.address().port;

  /* ══ 1. Scan du CODE : plus aucune config INFINIREACH lue ══ */
  const codeFiles = ['services/smsProvider.js', 'services/smsGateway.js', 'services/smsGateProvider.js',
    'services/smsQueueWorker.js', 'routes/sms.gateway.inbound.js'];
  const allowDeprecatedFallback = (src) =>
    // Fallback de transition documenté : var générique PUIS ancien nom (OR).
    src.split('\n').filter((l) => /process\.env\.INFINIREACH_/i.test(l))
      .every((l) => /process\.env\.SMS_GATEWAY_DEVICE_NUMBER \|\| process\.env\.INFINIREACH_FROM_NUMBER/.test(l));
  for (const f of codeFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    check(`${f} : aucune lecture INFINIREACH_* (fallback transition documenté toléré)`, allowDeprecatedFallback(src));
  }
  check('smsGateway.js : plus aucune URL api.infinireach.io ACTIVE (commentaires tolérés)',
    !/['"`]https:\/\/api\.infinireach\.io/.test(fs.readFileSync(path.join(ROOT, 'services/smsGateway.js'), 'utf8')));
  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  check('.env.example : plus aucune variable INFINIREACH_* définie', !/^INFINIREACH_/m.test(envExample));
  const mrSrc = fs.readFileSync(path.join(ROOT, 'services/messageRouter.js'), 'utf8');
  check('messageRouter.js : plus de transport sms_gateway/infobip actif',
    !mrSrc.includes("transport === 'sms_gateway'") && !mrSrc.includes("if (transport === 'infobip')"));
  check('smsQueueWorker.js : plus de branche INfiniReach',
    !fs.readFileSync(path.join(ROOT, 'services/smsQueueWorker.js'), 'utf8').includes("provider: 'sms_gateway'"));
  check('server.js : plus de défaut legacy (OFFLINE_SMS_PROVIDER défaut = smsgate)',
    !/OFFLINE_SMS_PROVIDER \|\| 'sms_gateway'/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')));

  /* ══ 2. Bannière de démarrage exigée ══ */
  const gwSrc = fs.readFileSync(path.join(ROOT, 'services/smsGateway.js'), 'utf8');
  check('démarrage annonce « SMS PROVIDER: SMSGATE »', gwSrc.includes('SMS PROVIDER: SMSGATE'));
  check('démarrage annonce « LEGACY PROVIDER: INFINIREACH DISABLED »', gwSrc.includes('LEGACY PROVIDER: INFINIREACH DISABLED'));

  /* ══ 3. Comportement : INFINIREACH_* posées → aucun effet ══ */
  process.env.INFINIREACH_API_KEY = 'fake-legacy-key';
  process.env.INFINIREACH_FROM_NUMBER = '+22600000000';
  process.env.INFINIREACH_ENABLED = 'true';
  process.env.OFFLINE_SMS_PROVIDER = 'sms_gateway'; // sélection legacy explicite

  const sp = require(path.join(ROOT, 'services', 'smsProvider.js'));
  const gw = require(path.join(ROOT, 'services', 'smsGateway.js'));
  check('isSmsGatewayProvider() → false (jamais sélectionnable)', gw.isSmsGatewayProvider() === false);
  check('getActiveProvider() → smsgate', gw.getActiveProvider() === 'smsgate');
  const st1 = sp.getProviderStatus();
  check("status : sélection legacy → activeProvider none (pas d'activation)", st1.activeProvider === 'none' && st1.legacy && st1.legacy.disabled === true, st1);
  const r1 = await sp.sendSMS('+22670000001', 'test legacy');
  check('sendSMS avec config legacy → provider none, AUCUN appel réseau', r1.provider === 'none' && r1.success === false && MOCK.posts.length === 0, r1);

  /* ══ 4. SMSGate configuré → actif même avec OFFLINE_SMS_PROVIDER=sms_gateway ══ */
  process.env.SMS_GATEWAY_LOGIN = 'login-app';
  process.env.SMS_GATEWAY_PASSWORD = 'pass-app';
  process.env.SMS_GATEWAY_DEVICE_ID = 'zfold2';
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${PORT}`;
  const st2 = sp.getProviderStatus();
  check('SMSGate configuré → activeProvider smsgate (malgré sélection legacy)', st2.activeProvider === 'smsgate', st2);
  const r2 = await sp.sendSMS('+22670000002', 'test smsgate');
  check('sendSMS → SMSGate appelé (POST effectué)', r2.success === true && r2.provider === 'smsgate' && MOCK.posts.length === 1, r2);

  /* ══ 5. Routage offline / sans compte toujours opérationnel ══ */
  delete process.env.INFINIREACH_API_KEY;
  delete process.env.INFINIREACH_FROM_NUMBER;
  delete process.env.INFINIREACH_ENABLED;
  process.env.ROUTE_OFFLINE_HOLD = 'true';
  require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: makeDb() };
  require.cache[path.join(ROOT, 'services', 'smsGateway.js')] = { id: 'gws', filename: path.join(ROOT, 'services/smsGateway.js'), loaded: true, exports: { isSmsGatewayProvider: () => false, isConfigured: () => false, sendSMS: async () => ({ success: false }), logStartupDiagnostic: () => {}, validateWebhookSignature: () => true } };
  require.cache[path.join(ROOT, 'services', 'socketService.js')] = { id: 'sk', filename: path.join(ROOT, 'services/socketService.js'), loaded: true, exports: {
    isUserOnline: async () => false, getIO: () => null, emitToUser: () => {}, deliverPendingMessages: async () => 0,
  } };
  require.cache[path.join(ROOT, 'services', 'userResolver.js')] = { id: 'ur', filename: path.join(ROOT, 'services/userResolver.js'), loaded: true, exports: {
    resolveUserByPhone: async () => ({ found: false }),
    resolveUserByUid: async (uid) => ({ found: true, uid }),
    normalizeEmail: (e) => String(e || '').toLowerCase(),
  } };

  const db = require(path.join(ROOT, 'config', 'firebase.js'));
  await db.collection('users').doc('uid-legacy-ir').set({ phone: '+22670000011', status: 'active' }); // legacy, sans champ
  const router = require(path.join(ROOT, 'services', 'messageRouter.js'));
  const base = { senderUid: 'uid-sender', content: 'Restauration legacy', type: 'text', senderName: 'Ali', db };
  const n = MOCK.posts.length;
  let r = await router.routeMessage({ ...base, targetUid: 'uid-legacy-ir', messageId: 'm-legacy-ir' });
  await sleep(200);
  check('routage offline (compte legacy) → hold + SMSGate appelé', r.held === true && MOCK.posts.length === n + 1, { held: r.held, posts: MOCK.posts.length });
  r = await router.routeMessage({ ...base, targetPhone: '+22670000099', messageId: 'm-ext-ir' });
  await sleep(200);
  check('routage sans compte → SMS_EXTERNE via SMSGate', r.route === 'SMS_EXTERNE' && MOCK.posts.length === n + 2, { route: r.route, posts: MOCK.posts.length });

  /* ══ 6. Webhook : signature générique (même sémantique, nouveaux noms) ══ */
  process.env.OFFLINE_SMS_PROVIDER = 'smsgate';
  const noSig = { headers: {}, rawBody: '{"a":1}' };
  check('webhook sans secret → permissif', gw.validateWebhookSignature(noSig) === true);
  process.env.SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE = 'true';
  check('webhook strict sans secret → rejeté (échec fermé)', gw.validateWebhookSignature(noSig) === false);
  process.env.SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE = '';
  process.env.SMS_GATEWAY_WEBHOOK_SECRET = 'sekret-test';
  const crypto = require('crypto');
  const body = '{"event":"message.inbound"}';
  const good = crypto.createHmac('sha256', 'sekret-test').update(body).digest('hex');
  check('webhook HMAC valide → accepté', gw.validateWebhookSignature({ headers: { 'x-signature': good }, rawBody: body }) === true);
  check('webhook HMAC invalide → rejeté', gw.validateWebhookSignature({ headers: { 'x-signature': 'deadbeef' }, rawBody: body }) === false);
  delete process.env.SMS_GATEWAY_WEBHOOK_SECRET;

  console.log(failures === 0 ? '\nSUPPRESSION INFINIREACH OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
});
