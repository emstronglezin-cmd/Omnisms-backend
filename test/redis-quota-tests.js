'use strict';
/**
 * Test — Quota Redis épuisé : arrêt contrôlé, inline honnête, sonde de
 * reprise, pas de boucles. Aucune vraie commande Redis (fakes ioredis/bullmq).
 */
const { spawnSync } = require('child_process');
const path = require('path');
const PHASES = path.join(__dirname, 'redis-quota-phases.js');

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra).slice(0, 300)}`);
  if (!cond) failures++;
};
function runPhase(phase, env = {}) {
  const r = spawnSync(process.execPath, [PHASES, phase], {
    env: { ...process.env, LOG_LEVEL: 'error', NODE_ENV: 'test', ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) {
    check(`phase ${phase} s'exécute`, false, { stderr: (r.stderr || '').slice(-400), stdout: (r.stdout || '').slice(-300) });
    return null;
  }
  return JSON.parse(line.slice(7));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ── 1. Boot normal : mode redis, add + dédup jobId + opts worker ── */
  let p = runPhase('boot');
  if (p) {
    check('boot : mode redis, quota intact', p.mode === 'redis' && p.quotaExhausted === false, p);
    check('addSmsJob → queued:true', p.queued === true, p);
    check('dédup BullMQ : jobId sms-{messageId} transmis', p.jobIdPassthrough === 'sms-m1', p);
    check('backoff par défaut : exponential ×3', p.attempts === 3 && p.backoffType === 'exponential' && p.backoffDelay === 3000, p);
    check('worker : skipStalledCheck actif + lockDuration 120s', p.skipStalledCheck === true && p.lockDuration === 120000, p);
  }

  /* ── 2. Quota épuisé : arrêt contrôlé + inline honnête + pas de boucle ── */
  p = runPhase('breaker', { QUEUE_AUTO_RECOVER: 'false' });
  if (p) {
    check('erreur quota → mode inline-quota', p.modeAfter === 'inline-quota' && p.quotaExhausted === true, p);
    check('workers arrêtés proprement (close)', p.closedWorkers >= 1, p);
    check('connexions Redis déconnectées (0 commande supplémentaire)', p.disconnects >= 2, p);
    check('retry du même job → exécution INLINE (le SMS part quand même)', p.inlineRetry === true && p.inlineResultOk === true, p);
    check('aucun nouveau job mis en file après quota (pas de tempête)', p.addedAfterQuota === p.addedBeforeQuota, p);
    check('job sans handler inline → échec HONNÊTE (pas de faux succès)', p.honestFail === true, p);
    check('erreur quota en plein addJob → inline', p.midFlightInline === true, p);
    check('AUCUNE boucle infinie : 0 ping, 0 commande en 400 ms', p.pingCount === 0 && p.stableAfter400 === true, p);
  }

  /* ── 3. Reprise après rétablissement (sonde PING) ── */
  p = runPhase('recovery', { QUEUE_AUTO_RECOVER: 'true', QUEUE_PROBE_INTERVAL_MS: '300', QUEUE_PROBE_MIN_MS: '100' });
  if (p) {
    check('sonde : Redis rétabli → mode redis restauré', p.modeAfter === 'redis' && p.quotaExhausted === false, p);
    check('workers re-créés automatiquement après reprise', p.workersAfter >= 1, p);
    check('sonde = 1 seul ping réussi (coût minimal)', p.pingCount >= 1 && p.pingCount <= 3, p);
  }

  /* ── 4. QUEUE_MODE=inline : 0 connexion Redis dès le boot ── */
  p = runPhase('forced-inline', { QUEUE_MODE: 'inline' });
  if (p) {
    check('QUEUE_MODE=inline : aucun client Redis créé', p.instances === 0 && p.mode === 'inline-forced', p);
    check('jobs exécutés inline en mode forcé', p.inlineOk === true, p);
  }

  console.log(failures === 0 ? '\nTESTS QUOTA REDIS OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
