'use strict';
/**
 * OmniSMS — Tests du système de monétisation OFFLINE (sans API externe)
 *
 * Couvre :
 *   - smsHandler.js   (moteur de commandes SMS)
 *   - creditSystem.js (barème recharge/premium)
 *   - antifraud.js    (logs de paiement)
 *   - UserSms.js      (quota, contacts, premium)
 *
 * Principe : Firestore et le provider SMS sont remplacés par des
 * mocks EN MÉMOIRE injectés dans le cache require AVANT tout chargement.
 * Aucune API, aucun réseau, aucune credential nécessaire.
 *
 * Usage : node test/offline-monetization-tests.js
 */

/* ════════════════════════════════════════════════════════════
   1. MOCKS — injectés avant les requires métier
   ════════════════════════════════════════════════════════════ */
const assert = require('assert');

// ── Mock Firestore (in-memory) ────────────────────────────────
const usersStore  = new Map(); // phone → user object
const paymentLogs = [];

function mockDb() {
  const reject = () => Promise.reject(new Error('mock: opération non supportée'));
  function docRef(collection, id) {
    if (collection === 'users') {
      return {
        async get() {
          const u = usersStore.get(id);
          return u
            ? { exists: true, id, data: () => ({ ...u }) }
            : { exists: false, id, data: () => ({}) };
        },
        async set(data, opts) {
          if (opts && opts.merge) {
            usersStore.set(id, { ...(usersStore.get(id) || {}), ...data });
          } else {
            usersStore.set(id, { ...data });
          }
        },
        async update(data) {
          const cur = usersStore.get(id);
          if (!cur) throw new Error('mock: document inexistant');
          usersStore.set(id, { ...cur, ...data });
        },
      };
    }
    return { get: reject, set: reject, update: reject, delete: reject };
  }
  return {
    _stub: true,
    collection(name) {
      if (name === 'payment_logs') {
        return { add: async (entry) => { paymentLogs.push(entry); return { id: 'log-' + paymentLogs.length }; } };
      }
      return {
        doc: (id) => docRef(name, id),
        where: () => { throw new Error('mock: where non supporté'); },
      };
    },
  };
}

function injectMock(modulePath, exportsObj) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id       : resolved,
    filename : resolved,
    loaded   : true,
    exports  : exportsObj,
  };
}

injectMock(require.resolve('../config/firebase'), mockDb());

// ── Mock provider SMS ────────────────────────────────────────
let PROVIDER_MODE = 'ok'; // 'ok' | 'fail' | 'none'
let lastSent      = null;
injectMock(require.resolve('../services/smsProvider'), {
  sendSMS: async (to, message) => {
    lastSent = { to, message };
    if (PROVIDER_MODE === 'ok')   return { success: true,  provider: 'mock', messageId: 'm-' + Date.now() };
    if (PROVIDER_MODE === 'fail') return { success: false, provider: 'mock', error: 'Erreur simulée' };
    return { success: false, provider: 'none', error: 'non configuré' };
  },
});

/* ════════════════════════════════════════════════════════════
   2. Chargement des modules réels (avec mocks injectés)
   ════════════════════════════════════════════════════════════ */
const { handleSMS }          = require('../services/smsHandler');
const creditSystem           = require('../services/creditSystem');
const { paymentLogCount }    = { paymentLogCount: () => paymentLogs.length };

/* ════════════════════════════════════════════════════════════
   3. Harness
   ════════════════════════════════════════════════════════════ */
let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err: err.message });
    console.log(`  ❌ ${name}\n     ↳ ${err.message}`);
  }
}

function expectContains(label, actual, expected) {
  assert.ok(
    String(actual).toLowerCase().includes(String(expected).toLowerCase()),
    `${label}\n       attendu (contient) : "${expected}"\n       reçu : "${String(actual).substring(0, 120)}"`,
  );
}

const PHONE = '+22670000001';

/* ════════════════════════════════════════════════════════════
   4. Tests
   ════════════════════════════════════════════════════════════ */
(async () => {
  console.log('\n═══ MONETISATION OFFLINE — TESTS SANS API ═══\n');

  // ── Inscription ────────────────────────────────────────────
  console.log('▸ Inscription & compte');

  await test('START sans compte → instructions inscription', async () => {
    const r = await handleSMS(PHONE, 'START');
    expectContains('START', r, 'NOM VotrePrenom');
  });

  await test('NOM Jean → compte créé avec 5 SMS gratuits', async () => {
    const r = await handleSMS(PHONE, 'NOM Jean');
    expectContains('NOM', r, '5 SMS gratuits');
    const u = usersStore.get(PHONE);
    assert.strictEqual(u.name, 'Jean');
    assert.strictEqual(u.smsQuota, 5);
    assert.strictEqual(u.isSubscribed, false);
  });

  await test('NOM Jean (existant) → mise à jour du nom', async () => {
    const r = await handleSMS(PHONE, 'NOM Jean-Paul');
    expectContains('NOM update', r, 'Jean-Paul');
  });

  // ── Contacts ───────────────────────────────────────────────
  console.log('▸ Contacts');

  await test('ADD Marie 71000000 → contact ajouté (normalisé)', async () => {
    const r = await handleSMS(PHONE, 'ADD Marie 71000000');
    expectContains('ADD', r, 'ajouté');
    const u = usersStore.get(PHONE);
    assert.strictEqual(u.contacts.length, 1);
    assert.strictEqual(u.contacts[0].phone, '+22671000000');
  });

  await test('ADD doublon → "existe déjà"', async () => {
    const r = await handleSMS(PHONE, 'ADD Marie 71000000');
    expectContains('ADD dupliqué', r, 'existe déjà');
  });

  await test('CONTACTS → liste avec Marie', async () => {
    const r = await handleSMS(PHONE, 'CONTACTS');
    expectContains('CONTACTS', r, 'Marie');
  });

  // ── Envoi SMS + quota ──────────────────────────────────────
  console.log('▸ Envoi SMS & quota gratuit');

  PROVIDER_MODE = 'ok';
  await test('*Marie\\nSalut → envoyé via provider, quota décrémenté', async () => {
    const r = await handleSMS(PHONE, '*Marie\nSalut !');
    expectContains('envoi', r, 'envoyé à Marie');
    assert.strictEqual(usersStore.get(PHONE).smsQuota, 4);
    assert.strictEqual(lastSent.to, '+22671000000');
  });

  await test('Épuisement du quota → message blocage + upsell Premium', async () => {
    // vider le quota manuellement
    const u = usersStore.get(PHONE); u.smsQuota = 0;
    PROVIDER_MODE = 'ok';
    const r = await handleSMS(PHONE, '*Marie\nEncore un test');
    expectContains('quota épuisé', r, 'Quota SMS épuisé');
    expectContains('upsell', r, 'Premium');
    // le message n'a PAS été envoyé
    assert.notStrictEqual(lastSent.message, 'Encore un test');
  });

  await test('Envoi avec provider indisponible → message "enregistré" (pas de crash)', async () => {
    const u = usersStore.get(PHONE); u.smsQuota = 3;
    PROVIDER_MODE = 'none';
    const r = await handleSMS(PHONE, '*+22676000099\nMessage hors-ligne');
    expectContains('provider none', r, 'temporairement indisponible');
    PROVIDER_MODE = 'ok';
  });

  // ── Solde ──────────────────────────────────────────────────
  console.log('▸ Solde');

  await test('SOLDE → affiche le solde restant', async () => {
    const r = await handleSMS(PHONE, 'SOLDE');
    expectContains('SOLDE', r, 'restant');
    expectContains('SOLDE nom', r, 'Jean-Paul');
  });

  // ── Recharge ───────────────────────────────────────────────
  console.log('▸ Recharge (barème créditSystem)');

  await test('RECHARGE 500 → instructions avec numéro de paiement', async () => {
    const logsBefore = paymentLogs.length;
    const r = await handleSMS(PHONE, 'RECHARGE 500');
    expectContains('RECHARGE', r, creditSystem.PAYMENT_NUMBER);
    expectContains('RECHARGE confirm', r, 'CONFIRM 500');
    assert.strictEqual(paymentLogs.length, logsBefore + 1, 'log anti-fraude attendu');
  });

  await test('RECHARGE 999 → montant non reconnu + barème', async () => {
    const r = await handleSMS(PHONE, 'RECHARGE 999');
    expectContains('RECHARGE invalide', r, 'non reconnu');
  });

  await test('CONFIRM 500 → +600 crédits (bonus +20%)', async () => {
    const before = usersStore.get(PHONE).smsQuota;
    const r = await handleSMS(PHONE, 'CONFIRM 500');
    expectContains('CONFIRM', r, '+600 crédit');
    const after = usersStore.get(PHONE).smsQuota;
    assert.strictEqual(after, before + 600);
    assert.ok(usersStore.get(PHONE).lastPaymentAt, 'lastPaymentAt attendu');
  });

  await test('Barème complet : 150→150, 500→600, 1000→1300', () => {
    assert.strictEqual(creditSystem.resolveCredits(150), 150);
    assert.strictEqual(creditSystem.resolveCredits(500), 600);
    assert.strictEqual(creditSystem.resolveCredits(1000), 1300);
    assert.strictEqual(creditSystem.resolveCredits(777), null);
  });

  // ── Premium ────────────────────────────────────────────────
  console.log('▸ Premium');

  await test('PREMIUM → instructions (2000F + lien + numéro)', async () => {
    const logsBefore = paymentLogs.length;
    const r = await handleSMS(PHONE, 'PREMIUM');
    expectContains('PREMIUM montant', r, String(creditSystem.PREMIUM_AMOUNT));
    expectContains('PREMIUM numéro', r, creditSystem.PAYMENT_NUMBER);
    assert.strictEqual(paymentLogs.length, logsBefore + 1);
  });

  await test('CONFIRM PREMIUM → activation illimité', async () => {
    const r = await handleSMS(PHONE, 'CONFIRM PREMIUM');
    expectContains('CONFIRM PREMIUM', r, 'Premium activé');
    assert.strictEqual(usersStore.get(PHONE).isSubscribed, true);
  });

  await test('SOLDE après activation → "Premium actif"', async () => {
    const r = await handleSMS(PHONE, 'SOLDE');
    expectContains('SOLDE premium', r, 'Premium actif');
  });

  await test('Envoi en Premium → quota NON décrémenté (illimité)', async () => {
    PROVIDER_MODE = 'ok';
    const before = usersStore.get(PHONE).smsQuota;
    const r = await handleSMS(PHONE, '*Marie\nMessage premium');
    expectContains('envoi premium', r, 'envoyé à Marie');
    assert.strictEqual(usersStore.get(PHONE).smsQuota, before, 'le quota ne doit pas bouger en Premium');
  });

  await test('PREMIUM déjà actif → déjà Premium', async () => {
    const r = await handleSMS(PHONE, 'CONFIRM PREMIUM');
    expectContains('double premium', r, 'déjà actif');
  });

  // ── Divers ─────────────────────────────────────────────────
  console.log('▸ Commandes diverses');

  await test('AIDE → contient le barème complet', async () => {
    const r = await handleSMS(PHONE, 'AIDE');
    expectContains('AIDE recharge', r, 'RECHARGE');
    expectContains('AIDE barème', r, '500F');
  });

  await test('Commande inconnue (utilisateur inscrit) → aide suggérée', async () => {
    const r = await handleSMS(PHONE, 'BONJOUR C EST MARIE');
    expectContains('inconnue', r, 'Commande non reconnue');
  });

  await test('Inconnu total (pas de compte) → invitation START', async () => {
    const r = await handleSMS('+22678887777', 'Coucou');
    expectContains('inconnu', r, 'START');
  });

  /* ══════════════════════════════════════════════════════════
     Webhook universel (routes/sms.webhook.js) via Express réel
     ══════════════════════════════════════════════════════════ */
  console.log('▸ Webhook universel /sms/incoming (formats providers)');

  const express = require('express');
  const webhookRouter = require('../routes/sms.webhook');
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/sms', webhookRouter);
  const server = app.listen(0);
  server.unref();

  async function post(path, body, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body   : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, text, json };
  }

  await test('Format générique {phone,message} → réponse JSON', async () => {
    const res = await post('/sms/incoming', { phone: '+22675554444', message: 'AIDE' });
    assert.strictEqual(res.status, 200);
    expectContains('webhook generic', res.json.reply, 'RECHARGE');
  });

  await test("Format Africa's Talking {from,text} → format recipients", async () => {
    const res = await post('/sms/incoming', { from: '+22675554445', text: 'SOLDE' });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.json.recipients));
    expectContains('webhook AT', res.json.recipients[0].message, 'gratuit');
  });

  await test('Format Twilio {From,Body} → TwiML XML', async () => {
    const res = await post('/sms/incoming', 'From=%2B22675554446&Body=AIDE', {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent'  : 'TwilioProxy/1.1',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('<Response>'), 'TwiML attendu');
    assert.ok(res.text.includes('<Message>'), 'Message TwiML attendu');
  });

  await test('Format inconnu → 400 explicite', async () => {
    const res = await post('/sms/incoming', { foo: 'bar' });
    assert.strictEqual(res.status, 400);
  });

  server.close();

  /* ══════════════════════════════════════════════════════════
     Résumé
     ══════════════════════════════════════════════════════════ */
  console.log('\n══════════════════════════════════════════════');
  console.log(`RÉSULTAT : ${passed} ✅  /  ${failed} ❌`);
  if (failed > 0) {
    failures.forEach(f => console.log(`   ❌ ${f.name} — ${f.err}`));
    process.exit(1);
  }
  process.exit(0);
})().catch(err => {
  console.error('ERREUR FATALE TESTS:', err);
  process.exit(1);
});
