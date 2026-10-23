'use strict';
/** Tests — Service OTP durci (empreinte HMAC, limites, transporteur injecté). */
process.env.LOG_LEVEL = 'error';
delete process.env.NODE_ENV; // pas 'production' → injection tests autorisée
process.env.JWT_SECRET = 'otp-test-secret';
delete process.env.OTP_PROVIDER;
delete process.env.OTP_ALLOW_GATEWAY_TRANSPORT;
process.env.OTP_RESEND_COOLDOWN_SECONDS = '15'; // cooldown minimal pour tester les limites rapidement
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ── Firestore mémoire (avec runTransaction réel) ── */
function makeDb() {
  const store = new Map();
  const colMap = (n) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n); };
  const docRef = (col, id) => ({
    id,
    get: async () => { const d = colMap(col).get(id); return { exists: !!d, id, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), ref: docRef(col, id) }; },
    set: async (data, opts) => { const p = colMap(col).get(id) || {}; colMap(col).set(id, Object.assign(opts && opts.merge ? p : {}, JSON.parse(JSON.stringify(data)))); },
    update: async (data) => { if (!colMap(col).has(id)) throw new Error('NOT_FOUND'); Object.assign(colMap(col).get(id), JSON.parse(JSON.stringify(data))); },
    delete: async () => colMap(col).delete(id),
  });
  return {
    _store: store,
    collection: (name) => ({ doc: (id) => docRef(name, id) }),
    runTransaction: async (fn) => fn({
      get: (r) => r.get(),
      update: (r, d) => r.update(d),
      set: (r, d, o) => r.set(d, o),
      delete: (r) => r.delete(),
    }),
  };
}
const db = makeDb();
require.cache[path.join(ROOT, 'config', 'firebase.js')] = { id: 'fb', filename: path.join(ROOT, 'config/firebase.js'), loaded: true, exports: db };
// pas d'Infobip dispo → transporteur = none (on n'enregistre PAS de stub infobip :
// le vrai module existe mais isConfigured() false sans clés → auto → none)
const otp = require(path.join(ROOT, 'services', 'otpService.js'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

(async () => {
  const PHONE = '+22670001111';

  /* ── Transporteur absent : jamais de faux succès ── */
  let r = await otp.sendOtp(PHONE, { userId: 'u-otp' });
  check('aucun transporteur → success:false + OTP_PROVIDER_UNAVAILABLE (pas de simulation)', r.success === false && r.code === 'OTP_PROVIDER_UNAVAILABLE');
  check('aucun doc OTP écrit quand le transporteur manque', ![...db._store.get('otp_codes')?.values() || []].length);

  /* ── Transporteur injecté (tests) : parcours complet ── */
  let sent = [];
  otp._setTransportForTests(async (phone, text) => { sent.push({ phone, text }); return { success: true, messageId: 'stub-msg-1' }; });
  r = await otp.sendOtp(PHONE, { userId: 'u-otp', ip: '10.0.0.1' });
  check('envoi OK via transporteur injecté', r.success === true && sent.length === 1);
  check('réponse SANS code ni devCode (jamais exposé)', r.code === undefined && r.devCode === undefined);
  const doc = [...db._store.get('otp_codes').values()][0];
  check('code stocké en EMPREINTE HMAC (jamais en clair)', doc && doc.codeHmac && !JSON.stringify(doc).includes(doc.codeHmac.replace(/./g, 'x')) && !/\b\d{6}\b/.test(JSON.stringify(doc)));
  check('numéro non stocké en clair (phoneHmac)', !!doc.phoneHmac && !JSON.stringify(doc).includes(PHONE));

  /* ── Extraction du code : seul le stub le connaît → on le régénère via hmac ? Non :
         le transporteur injecté capte le texte → on parse le code du texte capté. ── */
  const code = (sent[0].text.match(/(\d{6})/) || [])[1];
  check('code à 6 chiffres présent dans le SMS (vu par le transporteur seulement)', /^\d{6}$/.test(code));

  /* ── Vérification ── */
  let v = await otp.verifyOtp(PHONE, '000000');
  check('code incorrect → OTP_INVALID + triesRemaining', v.success === false && v.code === 'OTP_INVALID' && v.triesRemaining === 4);
  v = await otp.verifyOtp(PHONE, code);
  check('code correct → success + userId du doc', v.success === true && v.userId === 'u-otp');
  v = await otp.verifyOtp(PHONE, code);
  check('réutilisation du code consommé → OTP_CONSUMED', v.success === false && v.code === 'OTP_CONSUMED');

  /* ── Expiration (numéro frais) ── */
  sent = [];
  const PH_EXP = '+22670005555';
  await otp.sendOtp(PH_EXP, { userId: 'u-otp' });
  const [expId] = [...db._store.get('otp_codes').entries()].find(([id, d]) => d.phoneHmac && !d.consumed && d.tries === 0) || [];
  await db.collection('otp_codes').doc(expId).set({ ...(await db.collection('otp_codes').doc(expId).get()).data(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  v = await otp.verifyOtp(PH_EXP, '123456');
  check('code expiré → OTP_EXPIRED + doc supprimé', v.success === false && v.code === 'OTP_EXPIRED' && !db._store.get('otp_codes').has(expId));

  /* ── Trop de tentatives (numéro frais) ── */
  const PH_MAX = '+22670006666';
  await otp.sendOtp(PH_MAX, { userId: 'u-otp' });
  for (let i = 0; i < 5; i++) await otp.verifyOtp(PH_MAX, '999999');
  v = await otp.verifyOtp(PH_MAX, '999999');
  check('5 mauvais codes → blocage OTP_MAX_TRIES', v.success === false && v.code === 'OTP_MAX_TRIES');

  /* ── Limite par numéro/heure (le rateStore compte chaque demande) ── */
  const PH_RL = '+22670007777';
  let last;
  for (let i = 0; i < 6; i++) last = await otp.sendOtp(PH_RL, { ip: '10.2.0.9' });
  check('6ᵉ demande sur le même numéro → OTP_RATE_LIMITED (5/h)', last.success === false && last.code === 'OTP_RATE_LIMITED', last.code);

  /* ── Renvoi trop rapide (cooldown) ── */
  sent = [];
  await otp.sendOtp(PHONE, { userId: 'u-otp', ip: '10.0.0.2' });
  const before = sent.length;
  r = await otp.sendOtp(PHONE, { userId: 'u-otp', ip: '10.0.0.2' });
  check('renvoi immédiat → OTP_COOLDOWN + aucun nouvel envoi', r.success === false && r.code === 'OTP_COOLDOWN' && sent.length === before);

  /* ── Limite par numéro/heure ── */
  const cfg = otp._config();
  check('limites par défaut documentées (5/h/numéro, 20/h/IP, 5 essais, TTL 5 min)', cfg.OTP_PER_PHONE_H === 5 && cfg.OTP_PER_IP_H === 20 && cfg.OTP_MAX_TRIES === 5 && cfg.OTP_TTL_MS === 5 * 60 * 1000);

  /* ── Fournisseur en erreur → jamais marqué vérifié ── */
  const now = Date.now();
  otp._setTransportForTests(async () => { throw new Error('provider down'); });
  // attendre la fin du cooldown en changeant de numéro
  r = await otp.sendOtp('+22670002222', { userId: 'u-x', ip: '10.0.0.3' });
  check('transporteur en erreur → success:false SMS_ERROR (pas de succès simulé)', r.success === false && r.code === 'SMS_ERROR');

  /* ── Codes distincts par demande (pas de code fixe) ── */
  otp._setTransportForTests(async (phone, text) => { sent.push({ phone, text }); return { success: true }; });
  sent = [];
  await otp.sendOtp('+22670003333', { ip: '10.0.1.1' });
  await new Promise((res) => setTimeout(res, 5));
  // 2e numéro (pas de cooldown entre numéros)
  await otp.sendOtp('+22670004444', { ip: '10.0.1.2' });
  const c1 = (sent[0].text.match(/(\d{6})/) || [])[1];
  const c2 = (sent[1].text.match(/(\d{6})/) || [])[1];
  check('deux demandes → codes différents (aléatoire sûr)', c1 !== c2, `${c1} vs ${c2}`);

  console.log(failures === 0 ? '\nTESTS SERVICE OTP OK' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERREUR TEST:', e); process.exit(1); });
