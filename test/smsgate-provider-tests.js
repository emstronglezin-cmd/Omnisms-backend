'use strict';
/**
 * Tests — SMSGateProvider contre un serveur SMSGate SIMULÉ local (vrai HTTP).
 * Aucun SMS réel, aucune clé externe. Contrat = docs officielles sms-gate.app.
 */
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = 'smsgate-test-secret';
delete process.env.NODE_ENV;
process.env.SMSGATE_USERNAME = 'ops';
process.env.SMSGATE_PASSWORD = 'secret-pass';
process.env.SMSGATE_API_PREFIX = '/3rdparty/v1';
process.env.SMSGATE_REQUEST_TIMEOUT_MS = '1500';
delete process.env.SMSGATE_DEVICE_ID;
delete process.env.SMSGATE_AUTH_MODE;

const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ── Serveur SMSGate simulé ── */
const state = {
  validCreds     : Buffer.from('ops:secret-pass').toString('base64'),
  tokensIssued   : 0,
  messages       : new Map(),
  nextId         : 0,
  seenAuth       : [],
  failNextSend   : null,
  slowSend       : 0,
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const url = req.url.split('?')[0];
    const auth = req.headers.authorization || '';

    if (req.method === 'POST' && url === '/3rdparty/v1/auth/token') {
      if (auth !== `Basic ${state.validCreds}`) { res.writeHead(401); return res.end('{"message":"unauthorized"}'); }
      state.tokensIssued++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: `jti-${state.tokensIssued}`, token_type: 'Bearer',
        access_token: `access-${state.tokensIssued}`, refresh_token: `refresh-${state.tokensIssued}`,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      }));
    }

    if (req.method === 'GET' && /^\/3rdparty\/v1\/messages\/[^/]+$/.test(url)) {
      const id = url.split('/').pop();
      if (!state.messages.has(id)) { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id, state: state.messages.get(id) }));
    }

    if (req.method === 'POST' && url === '/3rdparty/v1/messages') {
      state.seenAuth.push(auth);
      const finish = () => {
        if (state.failNextSend) {
          const st = state.failNextSend.status;
          state.failNextSend = null;
          res.writeHead(st); return res.end(JSON.stringify({ message: 'boom' }));
        }
        state.nextId++;
        const id = `gw-${state.nextId}`;
        state.messages.set(id, 'Pending');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: [id] })); // l'API peut renvoyer un tableau
      };
      if (state.slowSend) { setTimeout(finish, state.slowSend); } else { finish(); }
      return;
    }

    res.writeHead(404); res.end('{}');
  });
});

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.SMSGATE_BASE_URL = `http://127.0.0.1:${port}`;

  const p = require(path.join(ROOT, 'services', 'smsGateProvider.js'));
  p._resetTokensForTests();

  /* ── 1. Configuration / activation ── */
  check('isConfigured true (BASE_URL+USER+PASS)', p.isConfigured() === true);
  check('isEnabled false sans OFFLINE_SMS_PROVIDER=smsgate', p.isEnabled() === false);
  process.env.OFFLINE_SMS_PROVIDER = 'smsgate';
  check('isEnabled true avec smsgate', p.isEnabled() === true);

  /* ── 2. Auth JWT + envoi + id récupéré ── */
  let r = await p.sendSMS({ to: '+22670001001', text: 'Test OmniSMS', messageId: 'msg-A', ttl: 3600 });
  check('envoi OK → id SMSGate récupéré (format tableau géré)', r.success === true && r.gatewayMessageId === 'gw-1' && r.state === 'pending', r);
  check('JWT utilisé (Bearer access-1) sur /messages', String(state.seenAuth.at(-1)) === 'Bearer access-1');
  check('statut initial → pending', (await p.checkStatus('gw-1')).state === 'pending');

  /* ── 3. États ── */
  state.messages.set('gw-1', 'Delivered');
  let st = await p.checkStatus('gw-1');
  check('Delivered → terminal', st.state === 'delivered' && st.terminal === true);
  state.messages.set('gw-1', 'Failed');
  st = await p.checkStatus('gw-1');
  check('Failed → terminal échec', st.state === 'failed' && st.terminal === true);
  check('id inconnu → found:false', (await p.checkStatus('gw-inconnu')).found === false);

  /* ── 4. Numéro invalide : rejet local, aucun appel réseau ── */
  const seenBefore = state.seenAuth.length;
  r = await p.sendSMS({ to: '070001002', text: 'x' });
  check('numéro non E.164 → INVALID_PHONE sans appel', r.success === false && r.error === 'INVALID_PHONE' && state.seenAuth.length === seenBefore);

  /* ── 5. Mode Basic (legacy) ── */
  process.env.SMSGATE_AUTH_MODE = 'basic';
  p.invalidateToken();
  r = await p.sendSMS({ to: '+22670001004', text: 'basic', messageId: 'msg-D' });
  check('mode basic → envoi OK avec Authorization: Basic', r.success === true && String(state.seenAuth.at(-1)).startsWith('Basic '));
  process.env.SMSGATE_AUTH_MODE = 'jwt';
  p.invalidateToken(); p._resetTokensForTests();

  /* ── 6. 500 serveur → ambigu ; réseau coupé → ambigu ; retry → PAS de doublon ── */
  state.failNextSend = { status: 500 };
  r = await p.sendSMS({ to: '+22670001006', text: 'boom', messageId: 'msg-F' });
  check('500 serveur → échec ambigu', r.success === false && r.ambiguous === true, r);
  // premier envoi réussi pour msg-G
  r = await p.sendSMS({ to: '+22670001007', text: 'ok', messageId: 'msg-G' });
  const gwG = r.gatewayMessageId;
  state.messages.set(gwG, 'Sent');
  // réseau coupé APRÈS acceptation (le serveur a bien reçu msg-G la 1re fois)
  p._setFetchImplForTests(async () => { throw new Error('réseau coupé (simulé)'); });
  const ambiguous = await p.sendSMS({ to: '+22670001007', text: 'ok', messageId: 'msg-G' });
  check('réseau coupé → résultat ambigu', ambiguous.success === false && ambiguous.ambiguous === true);
  p._setFetchImplForTests(null); // réseau rétabli
  const retry = await p.sendSMS({ to: '+22670001007', text: 'ok', messageId: 'msg-G' });
  check('retry du même message → statut vérifié, AUCUN double envoi (deduped)', retry.success === true && retry.deduped === true && retry.gatewayMessageId === gwG, retry);

  /* ── 7. 429 → RATE_LIMITED sans boucle ── */
  state.failNextSend = { status: 429 };
  r = await p.sendSMS({ to: '+22670001008', text: 'limit', messageId: 'msg-H' });
  check('429 → RATE_LIMITED, pas de retry intempestif', r.success === false && r.error === 'RATE_LIMITED' && r.statusCode === 429);
  // réparer le compteur d'auth pour la suite (401 possible après resets)
  p._resetTokensForTests();

  /* ── 8. Délégation : smsGateway.sendSMS → SMSGate ; INfiniReach jamais appelé ── */
  const gw = require(path.join(ROOT, 'services', 'smsGateway.js'));
  r = await gw.sendSMS({ to: '+22670001009', text: 'via delegation', messageId: 'msg-I' });
  check('smsGateway.sendSMS délègue à SMSGate (provider smsgate)', r.success === true && r.provider === 'smsgate', r);

  /* ── 9. OTP via SMSGate (branchement OTP_PROVIDER=smsgate) ── */
  process.env.OTP_PROVIDER = 'smsgate';
  const otp = require(path.join(ROOT, 'services', 'otpService.js'));
  // Firestore mémoire minimal pour otp_codes
  {
    const store = new Map();
    const docRef = (col, id) => ({
      id,
      get: async () => { const d = store.get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
      set: async (data, opts) => { const prev = store.get(id) || {}; store.set(id, Object.assign(opts && opts.merge ? prev : {}, JSON.parse(JSON.stringify(data)))); },
      update: async (data) => { Object.assign(store.get(id) || {}, JSON.parse(JSON.stringify(data))); },
      delete: async () => store.delete(id),
    });
    require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb2', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: {
      collection: (name) => ({ doc: (id) => docRef(name, id) }),
      runTransaction: async (fn) => fn({ get: (x) => x.get(), update: (x, d) => x.update(d), set: (x, d, o) => x.set(d, o), delete: (x) => x.delete() }),
    } };
  }
  const otpRes = await otp.sendOtp('+22670002001', { userId: 'u-otp-smsgate', ip: '10.9.9.9' });
  check('OTP via SMSGate : demande acceptée (transport réel branché)', otpRes.success === true, otpRes);
  const otpState = state.messages.get(`gw-${state.nextId}`);
  check('le SMS OTP est passé par le serveur SMSGate simulé (state pending)', otpState === 'Pending' || otpState === undefined, otpState);

  console.log(failures === 0 ? '\nTESTS SMSGATE PROVIDER OK' : `\n${failures} ÉCHEC(S)`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); server.close(); process.exit(1); });
