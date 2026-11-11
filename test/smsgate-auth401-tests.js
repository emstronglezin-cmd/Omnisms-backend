'use strict';
/**
 * Tests — HTTP 401 sur l'envoi SMSGate (cause prod : JWT délivré puis rejeté
 * sur /messages ; en mode 'auto' le repli Basic n'était DÉCLENCHE que sur
 * l'échec de /auth/token, jamais sur le rejet du jeton → 401 persistant).
 * Vérifie : URL appelée, mode d'auth (Basic/JWT), identifiants encodés,
 * réponses du service. SMSGate simulé (HTTP local) + sonde réelle /health.
 */
process.env.LOG_LEVEL = 'error';
delete process.env.REDIS_URL;

const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra ?? null).slice(0, 240)}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadProvider = () => {
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'smsGateProvider.js'))];
  return require(path.join(ROOT, 'services', 'smsGateProvider.js'));
};

/* ══ VARIANTE A — serveur qui DÉLIVRE un JWT mais le REJETTE sur /messages ══ */
const A = { tokenCalls: 0, messageCalls: 0, statusCalls: 0, auth: [] };
const serverA = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    const auth = String(req.headers.authorization || '');
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') {
      A.tokenCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'jwt-rejected-by-server', refresh_token: 'r-1', expires_at: new Date(Date.now() + 3600e3).toISOString() }));
    }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
      A.messageCalls++;
      A.auth.push(auth);
      if (auth.startsWith('Bearer ')) { res.writeHead(401); return res.end('{"error":"invalid token"}'); } // JWT refusé
      if (auth.startsWith('Basic ')) {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: [`gw-a-${A.messageCalls}`] })); // Basic accepté
      }
      res.writeHead(401); return res.end('{}');
    }
    if (req.method === 'GET' && /^\/3rdparty\/v1\/messages\//.test(req.url)) {
      A.statusCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ state: 'delivered' }));
    }
    res.writeHead(404); res.end('{}');
  });
});

/* ══ VARIANTE B — /auth/token inexistant (401) → repli Basic au token (comportement v1) ══ */
const B = { tokenCalls: 0, messageCalls: 0 };
const serverB = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') { B.tokenCalls++; res.writeHead(401); return res.end('{}'); }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
      B.messageCalls++;
      if (!String(req.headers.authorization || '').startsWith('Basic ')) { res.writeHead(401); return res.end('{}'); }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: ['gw-b-1'] }));
    }
    res.writeHead(404); res.end('{}');
  });
});

/* ══ VARIANTE C — identifiants réellement INVALIDES (Basic refusé partout) ══ */
const C = { messageCalls: 0 };
const serverC = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') { res.writeHead(200); return res.end(JSON.stringify({ access_token: 'jwt-ok-but', expires_at: new Date(Date.now() + 3600e3).toISOString() })); }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') { C.messageCalls++; res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    res.writeHead(404); res.end('{}');
  });
});

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
  /* ══ A. Le cas prod : JWT délivré puis rejeté → le repli Basic doit sauver l'envoi ══ */
  const portA = await listen(serverA);
  process.env.SMS_GATEWAY_LOGIN = 'login-app';
  process.env.SMS_GATEWAY_PASSWORD = 'pass-app';
  process.env.SMS_GATEWAY_DEVICE_ID = 'zfold2';
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${portA}`;

  let p = loadProvider();
  const expectedBasic = 'Basic ' + Buffer.from('login-app:pass-app').toString('base64');
  const r1 = await p.sendSMS({ to: '+22670000001', text: 'Test 401', messageId: 'm-401-1' });
  await sleep(100);
  check('URL réellement appelée = {SERVER}/3rdparty/v1/messages', A.messageCalls >= 1);
  check('1ʳᵉ tentative = JWT (Bearer), comme en prod', (A.auth[0] || '').startsWith('Bearer '), A.auth[0]);
  check('401 JWT → REPLI BASIC automatique (même envoi) → 202 accepté', r1.success === true && r1.statusCode === 202, r1);
  check('identifiants encodés = SMS_GATEWAY_LOGIN:PASSWORD (Base64, jamais loggés)', A.auth.includes(expectedBasic), A.auth);
  check('diagnostic : plus AUCUN 401 renvoyé au routeur', r1.error === null || r1.error === undefined, r1);

  const tokBefore = A.tokenCalls;
  const r2 = await p.sendSMS({ to: '+22670000002', text: 'Test 401 #2', messageId: 'm-401-2' });
  check('mode mémorisé → envois suivants en Basic DIRECT (plus de JWT rejeté)', r2.success === true && A.tokenCalls === tokBefore, { r2, tokens: [tokBefore, A.tokenCalls] });

  const st = await p.checkStatus('gw-a-1');
  check('checkStatus fonctionne après repli (delivered)', st.found === true && st.state === 'delivered', st);
  serverA.close();

  /* ══ B. /auth/token absent (401) → repli Basic au token (régression v1) ══ */
  const portB = await listen(serverB);
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${portB}`;
  p = loadProvider();
  const rb = await p.sendSMS({ to: '+22670000003', text: 'Token 404/401', messageId: 'm-401-b' });
  check('repli Basic sur échec /auth/token INTACT', rb.success === true && B.tokenCalls === 1 && B.messageCalls === 1, { rb, B });
  serverB.close();

  /* ══ C. Identifiants INVALIDES → échec honnête, borné, message clair (pas de boucle) ══ */
  const portC = await listen(serverC);
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${portC}`;
  p = loadProvider();
  const rc = await p.sendSMS({ to: '+22670000004', text: 'Bad creds', messageId: 'm-401-c' });
  await sleep(100);
  check('Basic refusé aussi → échec HONNÊTE (jamais « envoyé »)', rc.success === false && rc.statusCode === 401, rc);
  check('tentatives bornées (4 POST /messages — auto-réparation plafonnée, pas de boucle)', C.messageCalls === 4, C);
  check("message d'erreur actionnable (AUTH_REJECTED + vars à vérifier, sans secret)", /AUTH_REJECTED/.test(String(rc.error)) && /SMS_GATEWAY_LOGIN/.test(String(rc.error)) && /SMSGate « /.test(String(rc.error)), rc.error);
  serverC.close();

  /* ══ Sonde RÉELLE (contrat du service public — aucun identifiant réel) ══ */
  try {
    const h = await fetch('https://api.sms-gate.app/3rdparty/v1/health', { signal: AbortSignal.timeout(8000) });
    check('réel api.sms-gate.app /3rdparty/v1/health → 200 (contrat service réel)', h.status === 200, h.status);
    const t = await fetch('https://api.sms-gate.app/3rdparty/v1/auth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from('sonde-fake:sonde-fake').toString('base64') },
      body: JSON.stringify({ ttl: 3600, scopes: ['messages:send'] }), signal: AbortSignal.timeout(8000),
    });
    check('réel /auth/token avec FAUX identifiants → 401 (contrat confirmé)', t.status === 401, t.status);
  } catch (e) {
    console.log('SKIP  sonde réelle (réseau sandbox indisponible) :', String(e.message).slice(0, 80));
  }

  console.log(failures === 0 ? '\nFIX 401 SMSGATE OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
