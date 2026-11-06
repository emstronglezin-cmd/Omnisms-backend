'use strict';
/**
 * Tests — Passerelle Android propriétaire (stratégie SMS retenue) :
 * outbox persistante Firestore, appareils authentifiés, claim transactionnel
 * anti-doublons, résultats/rétries, reprise au redémarrage. AUCUN SMS réel.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const PHASES = path.join(__dirname, 'android-gateway-phases.js');

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra).slice(0, 250)}`);
  if (!cond) failures++;
};
function runPhase(phase, env = {}) {
  const r = spawnSync(process.execPath, [PHASES, phase], {
    env: { ...process.env, LOG_LEVEL: 'error', NODE_ENV: 'test', ...env },
    encoding: 'utf8', timeout: 45000,
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) { check(`phase ${phase} s'exécute`, false, { stderr: (r.stderr || '').slice(-300) }); return null; }
  return JSON.parse(line.slice(7));
}

(async () => {
  let p = runPhase('admin-key', { ADMIN_KEY: 'adm-key-1' });
  if (p) {
    check('register sans x-admin-key → 401', p.registerNoHeader === 401, p);
    check('register mauvaise clé → 401', p.registerBadHeader === 401, p);
    check('register bonne clé → 201 + deviceId + token 256 bits', p.registerOk === 201 && p.hasDeviceId && p.hasToken, p);
    check('jeton stocké HASHÉ (jamais en clair)', p.tokenHashed && p.tokenNotStoredPlain, p);
    check('révocation → 200', p.revokeOk === true, p);
    check('liste appareils : sans hash, statut revoked', p.listNoHash && p.listStatusRevoked, p);
    check('stats outbox accessibles (admin)', p.statsOk === true, p);
  }

  p = runPhase('flow');
  if (p) {
    check('claim sans auth → 401', p.claimNoAuth === 401, p);
    check('claim mauvais jeton → 401', p.claimBadToken === 401, p);
    check('appareil RÉVOQUÉ → 401', p.revokedDeviceClaim === 401, p);
    check('création SMS → 2 tâches en outbox (QUEUED_OUTBOX)', p.enqueueOk === true, p);
    check('re-enqueue même messageId → toujours 1 doc (idempotent)', p.noDupOnReenqueue === true, p);
    check('claim par passerelle autorisée → 2 tâches avec to/text', p.claimGot2 && p.taskFields, p);
    check('AUCUN double : 2e claim immédiat → 0 tâche', p.noDoubleClaim === true, p);
    check('résultat par un AUTRE appareil → 403', p.resultForeignDevice === 403, p);
    check('résultat OK → tâche sent', p.resultSentOk === true, p);
    check('message interne mis à jour (sent/SENT/android_gateway)', p.internalMessageSent === true, p);
    check('double résultat → idempotent (already)', p.resultIdempotent === true, p);
  }

  p = runPhase('retry');
  if (p) {
    check('échecs successifs : attempts incrémentés jusqu à 3', p.attemptsIncremented === true, p);
    check('après 3 échecs → échec DÉFINITIF (pas de boucle)', p.failedPermanentAfter3 === true, p);
    check('message interne failed/FAILED', p.internalFailed === true, p);
    check('tâche en échec définitif : plus récupérable', p.notReclaimedAfterFinal === true, p);
  }

  p = runPhase('stale');
  if (p) {
    check('tâche claimée abandonnée (30 min) → reprise automatique', p.staleReclaimed === true, p);
    check('reprise : attempts incrémentés (2)', p.attemptsIncremented === true, p);
  }

  p = runPhase('transport');
  if (p) {
    check('selectTransport → android_gateway (stratégie retenue)', p.transportSelected === true, p);
    check('file inline SANS Redis : tâche écrite en outbox', p.inlineEnqueueOk && p.outboxWritten, p);
    check('message interne HONNÊTE : pending + QUEUED_OUTBOX (pas « sent »)', p.messageHonestPending === true, p);
  }

  p = runPhase('restart');
  if (p) {
    check('APRÈS redémarrage (nouveau process) : la tâche en attente est récupérable', p.taskSurvivedRestart === true, p);
    check('résultat transmissible après redémarrage', p.resultAfterRestart === true, p);
  }

  console.log(failures === 0 ? '\nTESTS PASSERELLE ANDROID OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
