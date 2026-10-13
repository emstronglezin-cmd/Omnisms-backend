'use strict';
/** Tests unitaires — métriques & validation d'environnement. */
process.env.LOG_LEVEL = 'error';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { metrics, metricsService } = require(path.join(ROOT, 'services', 'metrics.js'));
const { validateEnv } = require(path.join(ROOT, 'config', 'envValidation.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

(async () => {
  /* ── Métriques ── */
  const m1 = metrics.render();
  metricsService.httpRequest('POST', '/api/messages/send?x=1', 200, 42);
  metricsService.httpRequest('POST', '/api/messages/send?x=1', 500, 900);
  metricsService.smsSend('sms_gateway', true, 320);
  metricsService.smsDelivery('delivered');
  metricsService.queueDepth('sms', 12);
  metricsService.sockets(150);
  metricsService.payment('matched');
  const out = metrics.render();
  check('compteur HTTP avec labels (sans query string)', /omnisms_http_requests_total\{method="POST",route="\/api\/messages\/send",status="200"\} 1/.test(out));
  check('5xx compté séparément', /omnisms_http_5xx_total\{route="\/api\/messages\/send"\} 1/.test(out));
  check('histogramme cumulatif p50/p95 lisibles', /omnisms_http_request_duration_ms_bucket\{le="50"\} 1/.test(out) && /omnisms_http_request_duration_ms_bucket\{le="\+Inf"\} 2/.test(out));
  check('jauges file/sockets', /omnisms_gauge\{name="queue_depth_sms"\} 12/.test(out) && /omnisms_gauge\{name="socket_connected"\} 150/.test(out));
  check('statuts SMS et paiements', /omnisms_sms_delivery_total\{status="delivered"\} 1/.test(out) && /omnisms_om_payment_total\{status="matched"\} 1/.test(out));
  check('cardinalité bornée (pas d’explosion de séries)', (() => {
    for (let i = 0; i < 200; i++) metrics.inc('omnisms_test_card', { user: `u${i}` });
    return metrics.render().split('\n').length < 500;
  })());

  /* ── Validation d'env ── */
  const bad = validateEnv({ NODE_ENV: 'production', JWT_SECRET: 'court', CREDITS_ENABLED: 'true' });
  check('prod sans FIREBASE/ADMIN_KEY/CORS → erreurs listées',
    !bad.ok && bad.errors.length >= 3 && bad.errors.some((e) => e.includes('JWT_SECRET')) === false
    && bad.errors.some((e) => e.includes('FIREBASE_SERVICE_ACCOUNT_JSON')) && bad.errors.some((e) => e.includes('ADMIN_KEY')), bad.errors);
  const creditsOn = validateEnv({ NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(40), FIREBASE_SERVICE_ACCOUNT_JSON: '{}', CREDITS_ENABLED: 'true' });
  check('crédits activés sans OM_SENDER_IDS → erreur', !creditsOn.ok && creditsOn.errors.some((e) => e.includes('OM_SENDER_IDS')), creditsOn.errors);
  const noRedis = validateEnv({ NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(40), FIREBASE_SERVICE_ACCOUNT_JSON: '{}', BACKEND_URL: 'https://b', REDIS_REQUIRED: 'true' });
  check('REDIS_REQUIRED sans REDIS_URL → erreur bloquante', !noRedis.ok && noRedis.errors.some((e) => e.includes('REDIS_URL')));
  const warnOnly = validateEnv({ NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(40), FIREBASE_SERVICE_ACCOUNT_JSON: '{}', BACKEND_URL: 'https://b' });
  check('config minimale dev → ok avec warning Redis', warnOnly.ok && warnOnly.warnings.some((w) => w.includes('REDIS_URL')), warnOnly.warnings);
  const weakJwt = validateEnv({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(20), FIREBASE_SERVICE_ACCOUNT_JSON: '{}', BACKEND_URL: 'https://b', ADMIN_KEY: 'k', CORS_ORIGIN: '*' });
  check('JWT court en prod → warning (pas erreur)', weakJwt.ok && weakJwt.warnings.some((w) => w.includes('JWT_SECRET')), weakJwt.warnings);

  console.log(failures === 0 ? '\nTESTS METRIQUES/ENV OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
