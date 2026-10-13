'use strict';
/** Tests — rateStore (fallback mémoire, sémantique fenêtre) + non-régression intégration. */
process.env.LOG_LEVEL = 'error';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const rateStore = require(path.join(ROOT, 'services', 'rateStore.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

(async () => {
  await rateStore.reset('k1');
  const r1 = await rateStore.hit('k1', 60000, 3);
  const r2 = await rateStore.hit('k1', 60000, 3);
  const r3 = await rateStore.hit('k1', 60000, 3);
  const r4 = await rateStore.hit('k1', 60000, 3);
  check('3 premiers hits autorisés, 4e refusé', r1.allowed && r2.allowed && r3.allowed && !r4.allowed, [r1, r4].map((r) => r.allowed));
  check('compteur cumulé + remaining', r4.count === 4 && r4.remaining === 0, r4);
  await rateStore.reset('k1');
  const r5 = await rateStore.hit('k1', 60000, 3);
  check('reset → à nouveau autorisé', r5.allowed && r5.count === 1);

  // fenêtres indépendantes par clé
  await rateStore.reset('A'); await rateStore.reset('B');
  await rateStore.hit('A', 60000, 1);
  const b1 = await rateStore.hit('B', 60000, 1);
  check('clés indépendantes', b1.allowed);
  const a2 = await rateStore.hit('A', 60000, 1);
  check('même clé 2e hit refusé (max=1)', !a2.allowed);

  // fenêtre courte qui expire
  await rateStore.reset('T');
  await rateStore.hit('T', 50, 1);
  const t2 = await rateStore.hit('T', 50, 1);
  check('2e hit dans la fenêtre refusé', !t2.allowed);
  await new Promise((r) => setTimeout(r, 80));
  const t3 = await rateStore.hit('T', 50, 1);
  check('après expiration de fenêtre → autorisé', t3.allowed, t3);

  // intégration : commande SMS toujours limitée via le store partagé (sans Redis → mémoire)
  const db = new Proxy({}, { get: () => null });
  require.cache[path.join(ROOT, 'config/firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: db };
  const recharge = require(path.join(ROOT, 'services', 'rechargeService.js'));
  process.env.SMS_COMMANDS_PER_HOUR = '2';
  const phone = '+22679977' + Date.now().toString().slice(-4);
  await rateStore.reset(`omcmds:${phone}`);
  const c1 = await recharge.handleSmsCommand({ db: null, phoneE164: phone, text: 'AIDE' });
  const c2 = await recharge.handleSmsCommand({ db: null, phoneE164: phone, text: 'AIDE' });
  const c3 = await recharge.handleSmsCommand({ db: null, phoneE164: phone, text: 'AIDE' });
  check('commandes SMS : 2 ok puis refus anti-spam', c1.handled && c2.handled && /trop de commandes/.test(c3.reply || ''), c3.reply);

  console.log(failures === 0 ? '\nTESTS RATESTORE OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
