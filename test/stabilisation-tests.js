'use strict';
/**
 * Tests stabilisation lancement : webhook signé (strict/permissif), gate
 * /api/diag, flags workers (économie Redis), drainDelay, fallback URLs photos.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PHASES = path.join(__dirname, 'stabilisation-phases.js');

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra).slice(0, 250)}`);
  if (!cond) failures++;
};
function runPhase(phase, env = {}) {
  const r = spawnSync(process.execPath, [PHASES, phase], {
    env: { ...process.env, LOG_LEVEL: 'error', NODE_ENV: 'test', ...env },
    encoding: 'utf8', timeout: 40000,
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) { check(`phase ${phase} s'exécute`, false, { stderr: (r.stderr || '').slice(-300) }); return null; }
  return JSON.parse(line.slice(7));
}

/* ── Fallback URLs photos (unitaire, sans serveur) ── */
delete process.env.BACKEND_URL;
delete process.env.RENDER_EXTERNAL_URL;
delete require.cache[require.resolve('../services/profileSerializer')];
const { absolutize } = require('../services/profileSerializer');
check('avatar relatif sans BACKEND_URL → URL canonique (prod APK)', absolutize('/uploads/x.jpg') === 'https://omnisms-backend.onrender.com/uploads/x.jpg', absolutize('/uploads/x.jpg'));
process.env.BACKEND_URL = 'https://api.exemple.test';
check('BACKEND_URL prioritaire quand défini', absolutize('/uploads/y.jpg') === 'https://api.exemple.test/uploads/y.jpg', absolutize('/uploads/y.jpg'));
delete process.env.BACKEND_URL;

(async () => {
  /* ── Webhook SMS entrant ── */
  let p = runPhase('webhook');
  if (p) {
    check('webhook sans secret, mode permissif → accepté (compat)', p.r1_permissiveNoSecret === true, p);
    check('webhook sans secret + REQUIRE_SIGNATURE=true → REJETÉ (fail-closed, corrigé)', p.r2_strictNoSecretRejected === true, p);
    check('webhook HMAC valide → accepté', p.r3_validHmacAccepted === true, p);
    check('webhook HMAC invalide → rejeté', p.r4_badHmacRejected === true, p);
    check('webhook sig manquante + secret, défaut → permissif (transition documentée)', p.r5_missingSigPermissiveByDefault === true, p);
    check('webhook sig manquante + secret + REQUIRE=true → rejeté', p.r6_missingSigStrictRejected === true, p);
  }

  /* ── drainDelay ── */
  p = runPhase('drain');
  if (p) {
    check('QUEUE_DRAIN_DELAY_MS=10 → drainDelay 10 (coût idle ÷2)', p.withEnv === 10, p);
    check('sans env → défaut BullMQ (5) inchangé', p.withoutEnv === undefined, p);
  }

  /* ── Gate /api/diag ── */
  p = runPhase('diag-gate');
  if (p) {
    check('/api/diag sans en-tête + ADMIN_KEY → 401', p.noHeader === 401, p);
    check('/api/diag mauvais x-admin-key → 401', p.badHeader === 401, p);
    check('/api/diag bon x-admin-key → 200', p.goodHeader === 200, p);
  }
  p = runPhase('diag-open');
  if (p) check('/api/diag sans ADMIN_KEY → 200 (compat conservée)', p.noHeader === 200, p);

  /* ── Flags workers ── */
  p = runPhase('sms-worker-off');
  if (p) check('QUEUE_SMS_WORKER=false → 0 worker BullMQ créé', p.bullmqWorkers === 0 && p.statusWorkers === 0, p);
  p = runPhase('sms-worker-on');
  if (p) check('défaut → worker SMS créé (1)', p.bullmqWorkers === 1 && p.statusWorkers === 1, p);
  p = runPhase('tx-worker-off');
  if (p) check('QUEUE_TRANSCRIPTION_WORKER=false → startWorker null, 0 worker', p.result === null && p.bullmqWorkers === 0, p);

  console.log(failures === 0 ? '\nTESTS STABILISATION OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
