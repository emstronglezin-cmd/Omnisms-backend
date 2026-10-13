'use strict';
/**
 * Runner de charge local (sans k6) — mesure réelle contre le serveur OmniSMS
 * démarré en stubs (Firebase mémoire, Redis absent → mémoire, INfiniReach non
 * configuré). Mesure le comportement du process Node réel : p50/p95/p99,
 * débit, erreurs, sockets simultanés, capture /metrics.
 *
 * Usage : node loadtest/node-runner.js [SOCKETS=150] [SENDS=400] [WEBHOOKS=800]
 */
process.env.LOG_LEVEL = 'error';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const PORT = 5057;
const BASE = `http://127.0.0.1:${PORT}`;
const N_SOCKETS = Number(process.argv[2] || process.env.SOCKETS || 150);
const N_SENDS = Number(process.argv[3] || process.env.SENDS || 400);
const N_WEBHOOKS = Number(process.argv[4] || process.env.WEBHOOKS || 800);
const JWT_SECRET = 'loadtest-secret';

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (arr) => `p50=${pct(arr, 50)}ms p95=${pct(arr, 95)}ms p99=${pct(arr, 99)}ms max=${Math.max(...arr, 0)}ms`;

function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${BASE}${url}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'error', JWT_SECRET, WORKER_IN_WEB_PROCESS: 'false', STRICT_ENV: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  // Attente du boot
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const r = await req('GET', '/livez'); up = r.status === 200; } catch (_) {}
  }
  if (!up) { console.error('serveur non démarré', serverLog.slice(-2000)); server.kill('SIGKILL'); process.exit(1); }
  console.log(`serveur prêt sur :${PORT} (stubs) — sockets=${N_SOCKETS} sends=${N_SENDS} webhooks=${N_WEBHOOKS}`);

  const token = jwt.sign({ uid: 'loadtest-user', phone: '+22676000001' }, JWT_SECRET, { expiresIn: '30m' });
  const auth = { Authorization: `Bearer ${token}` };
  const errors = { send: 0, webhook: 0 };

  /* ── Sockets simultanés ── */
  const io = require('socket.io-client');
  const connectLat = [];
  let connected = 0;
  const t0sock = Date.now();
  const sockets = await Promise.all(
    Array.from({ length: N_SOCKETS }, (_, i) =>
      new Promise((resolve) => {
        const t = Date.now();
        const s = io(BASE, { transports: ['websocket'], reconnection: false, timeout: 10000, auth: { token } });
        s.on('connect', () => { connectLat.push(Date.now() - t); connected++; resolve(s); });
        s.on('connect_error', (e) => { if (i === 0) console.log('socket connect_error:', e.message); resolve(s); });
        setTimeout(() => resolve(s), 11000);
      })
    )
  );
  const sockSec = (Date.now() - t0sock) / 1000;
  console.log(`\n[SOCKETS] connectés=${connected}/${N_SOCKETS} en ${sockSec.toFixed(1)}s — ${fmt(connectLat)}`);

  /* ── Envois HTTP /api/messages/send (destinataires hors ligne → SMS externe) ── */
  const latSend = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: N_SENDS }, (_, i) =>
      (async () => {
        const t = Date.now();
        try {
          const r = await req('POST', '/api/messages/send', { receiverId: `+2267${String(6000000 + i).slice(-7)}`, content: `load ${i}` }, auth);
          if (r.status >= 500) errors.send++;
        } catch (_) { errors.send++; }
        latSend.push(Date.now() - t);
      })()
    )
  );
  const sendSec = (Date.now() - t0) / 1000;

  /* ── Rafale webhooks passerelle ── */
  const latWh = [];
  const t1 = Date.now();
  await Promise.all(
    Array.from({ length: N_WEBHOOKS }, (_, i) =>
      (async () => {
        const t = Date.now();
        try {
          const r = await req('POST', '/api/webhooks/sms-gateway/inbound', { sender: `+22670${String(1000000 + i).slice(-7)}`, message: 'ok recu', deviceId: 'loadtest-device' });
          if (r.status >= 500) errors.webhook++;
        } catch (_) { errors.webhook++; }
        latWh.push(Date.now() - t);
      })()
    )
  );
  const whSec = (Date.now() - t1) / 1000;

  /* ── /metrics ── */
  let metrics = '';
  try { metrics = (await req('GET', '/metrics')).body; } catch (_) {}

  console.log(`\n[SEND] ${N_SENDS} req en ${sendSec.toFixed(1)}s (${(N_SENDS / sendSec).toFixed(0)} req/s) 5xx=${errors.send} — ${fmt(latSend)}`);
  console.log(`[WEBHOOK] ${N_WEBHOOKS} req en ${whSec.toFixed(1)}s (${(N_WEBHOOKS / whSec).toFixed(0)} req/s) 5xx=${errors.webhook} — ${fmt(latWh)}`);
  const interesting = metrics.split('\n').filter((l) => l.startsWith('omnisms_') && /(http_requests_total|http_5xx_total|socket_connected|queue_mode|http_request_duration_ms_count)/.test(l)).slice(0, 12);
  console.log('\n[/metrics]\n' + interesting.join('\n'));

  sockets.forEach((s) => s.disconnect && s.disconnect());
  server.kill('SIGTERM');
  setTimeout(() => { server.kill('SIGKILL'); process.exit(errors.send + errors.webhook > (N_SENDS + N_WEBHOOKS) * 0.01 ? 1 : 0); }, 500);
}

main().catch((e) => { console.error('RUNNER ERREUR:', e); process.exit(1); });
