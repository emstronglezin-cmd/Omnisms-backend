/**
 * k6 — OmniSMS : scénario de charge reproductible (staging).
 *
 * Usage :
 *   k6 run -e BASE_URL=https://staging.example.com -e JWT=xxx -e SENDS=500 -e SOCKETS=200 loadtest/k6-omnisms.js
 *
 * Scénarios :
 *   1. envois en ligne/hors ligne  POST /api/messages/send (JWT)
 *   2. rafale de webhooks          POST /api/webhooks/sms-gateway/inbound
 *   3. sonde continue              GET /livez
 *
 * Le rapport k6 donne p50/p90/p95/p99 par endpoint (tags name).
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:5057';
const JWT = __ENV.JWT || '';
const SENDS = Number(__ENV.SENDS || 500);
const SOCKETS = Number(__ENV.SOCKETS || 0); // k6/http ne fait pas de WS natif ici : comptabilisé à part (ws module ou runner node)

export const options = {
  scenarios: {
    sends: {
      executor: 'per-vu-iterations',
      vus: 25,
      iterations: Math.ceil(SENDS / 25),
      maxDuration: '3m',
      exec: 'sendOne',
    },
    webhooks: {
      executor: 'constant-arrival-rate',
      rate: 50, // webhooks/s
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      exec: 'webhookBurst',
      startTime: '5s',
    },
    liveness: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 5,
      exec: 'liveness',
      startTime: '0s',
    },
  },
  thresholds: {
    'http_req_duration{name:send}': ['p(95)<800'],
    'http_req_duration{name:webhook}': ['p(95)<300'],
    'http_req_failed': ['rate<0.01'],
  },
};

const uniq = () => `k6-${__VU}-${__ITER}-${Date.now()}`;

export function sendOne() {
  const res = http.post(
    `${BASE}/api/messages/send`,
    JSON.stringify({ to: '+22676001001', message: `load ${uniq()}`, channel: 'auto' }),
    {
      name: 'send',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` },
    }
  );
  check(res, { 'send 2xx/4xx métier (pas 5xx)': (r) => r.status < 500 });
  sleep(0.2);
}

export function webhookBurst() {
  const res = http.post(
    `${BASE}/api/webhooks/sms-gateway/inbound`,
    JSON.stringify({ sender: '+2267000' + String(10000 + Math.floor(Math.random() * 89999)), message: 'ok recu', deviceId: 'k6-device' }),
    { name: 'webhook', headers: { 'Content-Type': 'application/json' } }
  );
  check(res, { 'webhook 2xx': (r) => r.status >= 200 && r.status < 300 });
}

export function liveness() {
  const res = http.get(`${BASE}/livez`, { name: 'liveness' });
  check(res, { 'livez 200': (r) => r.status === 200 });
}
