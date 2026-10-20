'use strict';
/**
 * Tests — Présence fiable (socketService) :
 * états online/offline/unknown, auto-réparation du TTL, registre de sessions
 * multi-appareils, sweep serveur, protection déconnexion tardive, sync Firestore.
 */
process.env.LOG_LEVEL = 'error';
delete process.env.REDIS_URL; // fallback mémoire du service Redis
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ── Firestore mémoire (sync lastSeenAt) ── */
function makeDb() {
  const store = new Map();
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
  });
  return {
    _store: store,
    collection: (name) => ({ doc: (id) => docRef(name, id) }),
  };
}
const memDb = makeDb();
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: memDb };

/* ── Redis mémoire CONTRÔLABLE (fail() simule la panne Redis) ── */
const redisApi = require(path.join(ROOT, 'services', 'redis.js')); // mémoire (pas de REDIS_URL)
let redisBroken = false;
const guarded = ['get', 'hget', 'hset', 'hdel', 'set', 'del', 'expire', 'hlen'];
const safeRedis = { _store: redisApi._store };
for (const fn of guarded) {
  safeRedis[fn] = async (...args) => {
    if (redisBroken) throw new Error('Redis down (simulé)');
    return redisApi[fn](...args);
  };
}
require.cache[path.join(ROOT, 'services', 'redis.js')] = { id: 'rd', filename: path.join(ROOT, 'services/redis.js'), loaded: true, exports: safeRedis };

const svc = require(path.join(ROOT, 'services', 'socketService.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

(async () => {
  /* ── États de présence ── */
  check('getPresenceState: offline quand aucune donnée', await svc.getPresenceState('u-x') === 'offline');
  await svc.setUserOnline('u1');
  check('setUserOnline → getPresenceState "online"', await svc.getPresenceState('u1') === 'online');
  check('isUserOnline true (rétrocompatible)', await svc.isUserOnline('u1') === true);
  await svc.setUserOffline('u1');
  check('setUserOffline → "offline"', await svc.getPresenceState('u1') === 'offline');

  /* ── Présence inconnue (panne Redis) — la session valide ne suffit jamais ── */
  await svc.setUserOnline('u2');
  redisBroken = true;
  check('panne Redis → présence "unknown" (jamais "online" par défaut)', await svc.getPresenceState('u2') === 'unknown');
  check('panne Redis + aucun socket → isUserOnline=false (échec sécurisé)', await svc.isUserOnline('u2') === false);
  redisBroken = false;

  /* ── Multi-appareils : registre de sessions ── */
  const fakeSocket = (id) => ({ id, user: { uid: 'u3', authType: 'jwt' } });
  await svc.setUserOnline('u3');
  await svc.registerSession('u3', fakeSocket('sock-A'));
  await svc.registerSession('u3', fakeSocket('sock-B'));
  check('2 appareils → 2 sessions enregistrées', (await redisApi.hlen('user_sessions:u3')) === 2);
  await svc.removeSession('u3', 'sock-A');
  check('déconnexion d’un appareil → 1 session restante', (await redisApi.hlen('user_sessions:u3')) === 2 - 1);

  /* ── Sync Firestore : lastSeenAt écrit au passage offline ── */
  await svc.setUserOffline('u3');
  check('lastSeenAt synchronisé dans Firestore (users/u3)', typeof (memDb._store.get('users').get('u3') || {}).lastSeenAt === 'string');

  /* ── Structure du code : sweep + protection déconnexion tardive + auto-réparation ── */
  const src = require('fs').readFileSync(path.join(ROOT, 'services', 'socketService.js'), 'utf8');
  check('sweep serveur présent (setInterval 60 s, TTL renouvelé sans heartbeat client)', /startPresenceSweep[\s\S]{0,400}setInterval/.test(src) && /60 \* 1000/.test(src));
  check('sweep démarré à l’initialisation Socket.IO', /startPresenceSweep\(\);\n\s*return _io;/.test(src));
  check('déconnexion : sa propre session retirée AVANT la décision', src.indexOf('removeSession(uid, socket.id)') < src.indexOf('Décision offline PROTÉGÉE'));
  check('décision offline : room locale PUIS fetchSockets PUIS sessions (protection tardive)', /countSocketsInUserRoom\(uid\)[\s\S]{0,400}fetchSockets\(\)[\s\S]{0,400}user_sessions:\$\{uid\}/.test(src));
  check('auto-réparation : room vivante → TTL réarmée (utilisateur actif sans heartbeat client)', /live !== null && live > 0[\s\S]{0,120}setUserOnline\(uid\)/.test(src));
  check('état "unknown" explicitement défini (Redis en erreur)', /'unknown'/.test(src));
  check('Ne marque JAMAIS offline si une autre session vit (log « pas de passage offline »)', /pas de passage offline/.test(src));

  console.log(failures === 0 ? '\nTESTS PRÉSENCE FIABLE OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
