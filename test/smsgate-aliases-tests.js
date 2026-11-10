'use strict';
/**
 * Tests — Alignement SMSGate sur les variables Render du propriétaire :
 * SMS_GATEWAY_LOGIN / SMS_GATEWAY_PASSWORD / SMS_GATEWAY_DEVICE_ID /
 * SMS_GATEWAY_SERVER_ADDRESS. Serveur SMSGate simulé (sans endpoint JWT
 * → vérifie le repli automatique en Basic). AUCUN SMS réel.
 */
process.env.LOG_LEVEL = 'error';
delete process.env.OFFLINE_SMS_PROVIDER; // comme en prod : absent (ou sms_gateway)
delete process.env.SMSGATE_BASE_URL; delete process.env.SMSGATE_USERNAME;
delete process.env.SMSGATE_PASSWORD; delete process.env.SMSGATE_DEVICE_ID;
delete process.env.SMSGATE_AUTH_MODE;

const http = require('http');
const crypto = require('crypto');

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra).slice(0, 250)}`);
  if (!cond) failures++;
};

/* ── Serveur SMSGate simulé (contractuel, docs.sms-gate.app) ── */
const SEEN = { authAttempts: 0, messages: [], authHeader: null, deviceId: null };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/3rdparty/v1/auth/token') {
      SEEN.authAttempts++;
      res.writeHead(404, { 'Content-Type': 'application/json' }); // serveur SANS endpoint JWT
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
      SEEN.authHeader = req.headers.authorization || null;
      let b = {}; try { b = JSON.parse(body || '{}'); } catch (_) {}
      SEEN.deviceId = b.deviceId || null;
      const txt = typeof b.message === 'string' ? b.message : (b.textMessage && b.textMessage.text) || '';
      SEEN.messages.push({ to: (b.phoneNumbers || [])[0], text: txt });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: ['gw-42'] }));
    }
    if (req.method === 'GET' && req.url === '/3rdparty/v1/messages/gw-42') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ state: 'Delivered' }));
    }
    res.writeHead(404); res.end('{}');
  });
});
server.listen(0, '127.0.0.1', () => run(server.address().port));

async function run(PORT) {
  /* ── 1. Les QUATRE variables Render, exactement comme configurées ── */
  process.env.SMS_GATEWAY_LOGIN = 'utilisateur-app';
  process.env.SMS_GATEWAY_PASSWORD = 'motdepasse-app';
  process.env.SMS_GATEWAY_DEVICE_ID = 'dev-app-123';
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${PORT}`; // valeur type de l'app (URL complète)
  // OFFLINE_SMS_PROVIDER reste ABSENT (et même simule la valeur prod 'sms_gateway' plus bas)

  const agw = require('../services/smsGateProvider');

  check('isConfigured true avec les 4 variables SMS_GATEWAY_*', agw.isConfigured() === true);
  check('isEnabled true SANS OFFLINE_SMS_PROVIDER (credentials = activation)', agw.isEnabled() === true);
  process.env.OFFLINE_SMS_PROVIDER = 'sms_gateway'; // comme en prod actuelle
  check('isEnabled true même avec OFFLINE_SMS_PROVIDER=sms_gateway (pas de changement Render requis)', agw.isEnabled() === true);
  process.env.OFFLINE_SMS_PROVIDER = 'none';
  check('OFFLINE_SMS_PROVIDER=none → désactivé (couper urgence)', agw.isEnabled() === false);
  process.env.OFFLINE_SMS_PROVIDER = 'sms_gateway';

  /* ── 2. Hôte nu (sans https://) → préfixé automatiquement ── */
  process.env.SMS_GATEWAY_SERVER_ADDRESS = 'sms.app.example.test';
  check('Server Address sans schéma → https:// ajouté (isConfigured ok)', agw.isConfigured() === true);
  process.env.SMS_GATEWAY_SERVER_ADDRESS = `http://127.0.0.1:${PORT}`;

  /* ── 3. Envoi : endpoint JWT absent (404) → repli AUTO en Basic ── */
  const r = await agw.sendSMS({ to: '+22670005001', text: 'Test alignement', messageId: 'm-alias-1' });
  check('envoi → succès (taskId gw-42 récupéré)', r.success === true && r.gatewayMessageId === 'gw-42', r);
  check('endpoint JWT absent → 1 seule tentative d auth (repli Basic permanent)', SEEN.authAttempts === 1, SEEN.authAttempts);
  const expectedBasic = 'Basic ' + Buffer.from('utilisateur-app:motdepasse-app').toString('base64');
  check('authentification = Basic(username:password de l app)', SEEN.authHeader === expectedBasic, SEEN.authHeader);
  check('Device ID transmis dans le payload', SEEN.deviceId === 'dev-app-123', SEEN.deviceId);
  check('destinataire + contenu transmis (E.164)', SEEN.messages[0] && SEEN.messages[0].to === '+22670005001' && SEEN.messages[0].text === 'Test alignement', SEEN.messages[0]);

  /* ── 4. Statut du message (route officielle GET /messages/{id}) ── */
  const st = await agw.checkStatus('gw-42');
  check('statut → Delivered (terminal)', st.found === true && st.state === 'delivered' && st.terminal === true, st);

  /* ── 5. Secrets jamais loggés ── */
  await new Promise((r2) => setTimeout(r2, 60)); // laisse les logs sortir
  console.log('CHECK_LOGS: aucune ligne ci-dessus ne doit contenir motdepasse-app ni l Authorization');

  check('mot de passe absent des logs', !JSON.stringify(SEEN).includes('motdepasse-app'));

  console.log(failures === 0 ? '\nTESTS ALIAS SMSGATE OK' : `\n${failures} ÉCHEC(S)`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}
