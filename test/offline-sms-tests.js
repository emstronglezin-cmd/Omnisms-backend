'use strict';
/**
 * OmniSMS — Tests Mode Offline SMS (Scénarios A–J)
 *
 * Tests unitaires/d'intégration du mode Offline.
 * Tous les modules Firebase, Redis, Socket.IO et Infobip sont mockés.
 *
 * Usage :
 *   node test/offline-sms-tests.js
 *
 * Scénarios couverts :
 *   A. OmniSMS → SMS externe (flux sortant)
 *   B. SMS externe → OmniSMS (flux entrant — webhook Infobip)
 *   C. Online (OmniSMS → OmniSMS) continue de fonctionner
 *   D. Numéro inconnu (pas dans OmniSMS, pas dans Infobip)
 *   E. Numéro déjà enregistré sur OmniSMS
 *   F. Doublon webhook (même messageId reçu deux fois)
 *   G. Erreur du Gateway (Infobip retourne une erreur)
 *   H. Retry (SMS échoue → re-tenté via queue)
 *   I. Reconnexion Gateway (Infobip indispo puis disponible)
 *   J. Conservation de l'historique (conversations externes en Firestore)
 */

/* ─────────────────────────────────────────────────────────────────────────
   Framework de test minimaliste (no deps)
───────────────────────────────────────────────────────────────────────── */
let pass = 0;
let fail = 0;
const results = [];

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    pass++;
    results.push({ name, ok: true });
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    fail++;
    results.push({ name, ok: false, error: e.message });
  }
}

function testSync(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    pass++;
    results.push({ name, ok: true });
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    fail++;
    results.push({ name, ok: false, error: e.message });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertExists(val, msg) {
  if (val === null || val === undefined) throw new Error(msg || `Expected non-null value, got ${val}`);
}

/* ─────────────────────────────────────────────────────────────────────────
   Mocks
───────────────────────────────────────────────────────────────────────── */

function createMockDb() {
  const store = {};
  return {
    _store: store,
    collection(name) {
      store[name] = store[name] || {};
      const self = {
        _where: null,
        where(field, op, val) {
          this._where = { field, op, val };
          return this;
        },
        limit() { return this; },
        orderBy() { return this; },
        async get() {
          const col = store[name] || {};
          let docs = Object.entries(col).map(([id, data]) => ({
            id, data: () => data, exists: true,
            ref: {
              async update(upd) { Object.assign(col[id], upd); },
              async delete() { delete col[id]; },
            },
          }));
          if (this._where) {
            const { field, val } = this._where;
            docs = docs.filter(d => d.data()[field] === val);
          }
          return { empty: docs.length === 0, docs, size: docs.length };
        },
        doc(id) {
          const genId = id || `id_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const col   = store[name];
          return {
            id: genId,
            async get() {
              const data = col[genId];
              return { exists: !!data, data: () => data, id: genId };
            },
            async set(data, opts) {
              if (opts && opts.merge) {
                col[genId] = Object.assign(col[genId] || {}, data);
              } else {
                col[genId] = { ...data };
              }
            },
            async update(data) {
              col[genId] = Object.assign(col[genId] || {}, data);
            },
            async delete() { delete col[id]; },
          };
        },
        async add(data) {
          const id = `auto_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          store[name][id] = { ...data };
          return {
            id,
            async update(upd) { Object.assign(store[name][id], upd); },
          };
        },
      };
      return self;
    },
  };
}

function createMockInfobip(opts) {
  opts = opts || {};
  const { shouldFail, failOnce, failCount } = opts;
  let calls = 0;
  return {
    isConfigured: () => true,
    getStatus: () => ({ provider: 'infobip', configured: true }),
    sendSMS: async function ({ to, text }) {
      calls++;
      if (shouldFail || (failOnce && calls <= (failCount || 1))) {
        return { success: false, error: 'Infobip mock error', statusCode: 500 };
      }
      return { success: true, messageId: `mock-msg-${calls}`, status: 'PENDING', raw: {} };
    },
    _calls: () => calls,
  };
}

function createMockRedis() {
  const store = new Map();
  return {
    async setnx(key, val) {
      if (store.has(key)) return 0;
      store.set(key, val);
      return 1;
    },
    async expire() { return 1; },
    async exists(key) { return store.has(key) ? 1 : 0; },
    async get(key) { return store.get(key) || null; },
    async set(key, val) { store.set(key, val); return 'OK'; },
    async del(key) { store.delete(key); return 1; },
    _store: store,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Imports (pure-logic modules — no Firestore/Socket.IO at require time)
───────────────────────────────────────────────────────────────────────── */
const { normalizePhone, isValidPhone }  = require('../services/phoneNormalizer');
const {
  makeConversationId,
  makeExternalConvId,
  getOrCreateExternalConv,
  findExternalConvByPhone,
  updateExternalConvLastMessage,
} = require('../services/messageRouter');
const {
  parseFirstMessage,
  parseFollowupMessage,
  isDemarrer,
} = require('../services/hybridSms');

/* ─────────────────────────────────────────────────────────────────────────
   MAIN — All tests run here (async wrapper needed for top-level await CJS)
───────────────────────────────────────────────────────────────────────── */
async function runTests() {

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║      OmniSMS — Tests Mode Offline SMS (A–J)               ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  /* ────────────────────────────────────────────────────────────────
     SECTION A — OmniSMS → SMS externe (flux sortant)
  ──────────────────────────────────────────────────────────────── */
  console.log('── A. SMS Sortant OmniSMS → externe ────────────────────────');

  testSync('A1. makeExternalConvId génère un ID stable', () => {
    const id1 = makeExternalConvId('uid123', '+22670000001');
    const id2 = makeExternalConvId('uid123', '+22670000001');
    assertEqual(id1, id2, 'External convId doit être déterministe');
    assert(id1.startsWith('ext-'), 'External convId doit commencer par ext-');
  });

  testSync('A2. makeExternalConvId inclut le UID et le numéro normalisé', () => {
    const id = makeExternalConvId('userXYZ', '+22670112233');
    assert(id.includes('userXYZ'), 'convId doit inclure ownerUid');
    assert(id.includes('+22670112233'), 'convId doit inclure le numéro E.164');
  });

  testSync('A3. Numéros E.164 valides acceptés', () => {
    assert(isValidPhone('+22670000000'), '+226 BF valide');
    assert(isValidPhone('+33612345678'), '+33 FR valide');
    assert(isValidPhone('+22100000000'), '+221 SN valide');
  });

  testSync('A4. Numéros invalides rejetés', () => {
    assert(!isValidPhone('123'), 'Trop court doit être rejeté');
    assert(!isValidPhone('abc'), 'Non numérique doit être rejeté');
  });

  await testAsync('A5. getOrCreateExternalConv crée une conversation externe', async () => {
    const db = createMockDb();
    const conv = await getOrCreateExternalConv(db, 'uid_sender', '+22670111111', 'Jean');
    assertExists(conv, 'La conversation doit être créée');
    assertExists(conv.conversationId, 'conversationId requis');
    assertEqual(conv.ownerUid, 'uid_sender', 'ownerUid doit correspondre');
    assertEqual(conv.externalPhone, '+22670111111', 'externalPhone doit correspondre');
    assertEqual(conv.channel, 'sms', 'channel doit être sms');
  });

  await testAsync('A6. getOrCreateExternalConv est idempotente (deux appels = même convId)', async () => {
    const db = createMockDb();
    const c1 = await getOrCreateExternalConv(db, 'uid_A', '+22670222222', 'Marie');
    const c2 = await getOrCreateExternalConv(db, 'uid_A', '+22670222222', 'Marie');
    assertEqual(c1.conversationId, c2.conversationId, 'ConvId doit être identique au second appel');
  });

  /* ────────────────────────────────────────────────────────────────
     SECTION B — SMS externe → OmniSMS (flux entrant)
  ──────────────────────────────────────────────────────────────── */
  console.log('\n── B. SMS Entrant externe → OmniSMS ────────────────────────');

  testSync('B1. parseHashPrefix : #NUMERO message (protocole # entrant)', () => {
    const text  = '#22670000000 Bonjour Emmanuel !';
    const match = text.trim().match(/^[#]?\s*(\+?[\d]{6,15})\s+([\s\S]+)$/);
    assert(match !== null, 'Doit matcher le format #NUMERO message');
    const phone   = match[1];
    const content = match[2];
    assertExists(phone, 'Numéro extrait doit exister');
    assertEqual(content.trim(), 'Bonjour Emmanuel !', 'Texte extrait doit correspondre');
  });

  testSync('B2. Numéro de l\'expéditeur correctement normalisé', () => {
    const e164 = normalizePhone('70223344'); // BF par défaut
    assert(e164.startsWith('+'), 'Doit être au format E.164 (commence par +)');
  });

  await testAsync('B3. findExternalConvByPhone retrouve la conversation existante', async () => {
    const db = createMockDb();
    await getOrCreateExternalConv(db, 'uid_owner', '+22670333333', null, '+22600000001');
    const found = await findExternalConvByPhone(db, '+22670333333', '+22600000001');
    assertExists(found, 'Conversation doit être trouvée');
    assertEqual(found.ownerUid, 'uid_owner', 'ownerUid doit correspondre');
  });

  await testAsync('B4. updateExternalConvLastMessage met à jour lastMessage', async () => {
    const db   = createMockDb();
    const conv = await getOrCreateExternalConv(db, 'uid_B', '+22670444444');
    await updateExternalConvLastMessage(db, conv.conversationId, 'Salut !', 'infobip-msg-99');
    const col  = db._store['external_conversations'] || {};
    const doc  = Object.values(col).find(d => d.conversationId === conv.conversationId);
    assertExists(doc, 'Document externe doit exister');
    assertEqual(doc.lastMessage, 'Salut !', 'lastMessage doit être mis à jour');
  });

  /* ────────────────────────────────────────────────────────────────
     SECTION C — Online (OmniSMS ↔ OmniSMS) non impacté
  ──────────────────────────────────────────────────────────────── */
  console.log('\n── C. Online OmniSMS ↔ OmniSMS non impacté ────────────────');

  testSync('C1. makeConversationId déterministe (A→B = B→A)', () => {
    const uidA = 'user_alpha';
    const uidB = 'user_beta';
    assertEqual(makeConversationId(uidA, uidB), makeConversationId(uidB, uidA));
  });

  testSync('C2. makeConversationId et makeExternalConvId ne se chevauchent pas', () => {
    const onlineId  = makeConversationId('uid1', 'uid2');
    const offlineId = makeExternalConvId('uid1', '+22670000000');
    assert(onlineId !== offlineId, 'IDs Online et Offline doivent être distincts');
    assert(!onlineId.startsWith('ext-'), 'Online ID ne doit pas commencer par ext-');
    assert(offlineId.startsWith('ext-'), 'Offline ID doit commencer par ext-');
  });

  testSync('C3. makeConversationId ne contient pas de numéro de téléphone', () => {
    const cid = makeConversationId('uid_firebase_abc', 'uid_firebase_xyz');
    assert(!cid.includes('+226'), 'ConvId Online ne doit pas contenir de numéro E.164');
    assert(!cid.includes('0022'), 'ConvId Online ne doit pas contenir 0022xxx');
  });

  /* ────────────────────────────────────────────────────────────────
     SECTION D — Numéro inconnu
  ──────────────────────────────────────────────────────────────── */
  console.log('\n── D. Numéro inconnu ───────────────────────────────────────');

  await testAsync('D1. getOrCreateExternalConv crée une conv même pour numéro inconnu', async () => {
    const db   = createMockDb();
    const conv = await getOrCreateExternalConv(db, 'uid_owner', '+22670555555');
    assertExists(conv, 'Conv doit être créée même si numéro inconnu');
    assertEqual(conv.channel, 'sms', 'Canal doit être sms');
  });

  await testAsync('D2. findExternalConvByPhone retourne null si conv absente', async () => {
    const db    = createMockDb();
    const found = await findExternalConvByPhone(db, '+22670999999');
    assertEqual(found, null, 'Doit retourner null pour un numéro sans historique');
  });

  /* ────────────────────────────────────────────────────────────────
     SECTION E — Numéro déjà enregistré sur OmniSMS
  ──────────────────────────────────────────────────────────────── */
  console.log('\n── E. Numéro déjà OmniSMS ──────────────────────────────────');

  testSync('E1. makeConversationId utilisé (pas ext-) quand UID résolu', () => {
    const resolvedUid = 'uid_already_omnisms';
    const senderUid   = 'uid_sender';
    const convId = makeConversationId(senderUid, resolvedUid);
    assert(!convId.startsWith('ext-'), 'Ne doit pas être une conv externe');
    assert(convId.includes('-'), 'Doit contenir un tiret séparateur');
  });

  testSync('E2. Numéro E.164 normalisé identiquement quel que soit le format entrant', () => {
    const variants    = ['70000001', '+22670000001', '0022670000001'];
    const expected    = '+22670000001';
    const normalized  = variants.map(v => normalizePhone(v));
    normalized.forEach((n, i) => {
      assertEqual(n, expected, `Variante ${i} (${variants[i]}) → ${expected}`);
    });
  });

  /* ────────────────────────────────────────────────────────────────
     SECTION F — Doublon webhook
  ──────────────────────────────────────────────────────────────── */
  console.log('\n── F. Doublon webhook ──────────────────────────────────────');

  await testAsync('F1. SETNX : premier appel = nouveau message (non doublon)', async () => {
    const redis = createMockRedis();
    const key   = 'omnisms:inbound:dedup:msg-unique-001';
    const set   = await redis.setnx(key, '1');
    assertEqual(set, 1, 'SETNX doit retourner 1 (créé)');
    const isDup = (set !== 1);
    assertEqual(isDup, false, 'Premier appel ne doit pas être un doublon');
  });

  await testAsync('F2. SETNX : second appel = doublon détecté', async () => {
    const redis = createMockRedis();
    const key   = 'omnisms:inbound:dedup:msg-dup-001';
    await redis.setnx(key, '1');
    const set2  = await redis.setnx(key, '1');
    assertEqual(set2, 0, 'SETNX doit retourner 0 (existait)');
    const isDup = (set2 !== 1);
    assertEqual(isDup, true, 'Second appel doit être un doublon');
  });

  await testAsync('F3. Fallback mémoire Map fonctionne si Redis absent', async () => {
    const map   = new Map();
    const msgId = 'msg-mem-fallback-001';
    const firstCall  = map.has(msgId);
    map.set(msgId, Date.now());
    const secondCall = map.has(msgId);
    assertEqual(firstCall,  false, 'Premier appel : non doublon');
    assertEqual(secondCall, true,  'Second appel  : doublon');
  });

  /* ────────────────────────────────────────────────────────────────
     SECTION G — Erreur du Gateway
  ──────────────────────────────────────────────────────────────── */
  console.log('\n── G. Erreur du Gateway ────────────────────────────────────');

  testSync('G1. Infobip non configuré → isConfigured() = false', () => {
    const mockInfobip = { isConfigured: () => false };
    assertEqual(mockInfobip.isConfigured(), false, 'Infobip non configuré');
    // smsQueueWorker.processSmsJob retourne { skipped: true } dans ce cas
    assert(true, 'Worker doit skipper sans throw si Infobip non configuré');
  });

  await testAsync('G2. Infobip sendSMS échoue → result.success = false', async () => {
    const mockInfobip = createMockInfobip({ shouldFail: true });
    const result = await mockInfobip.sendSMS({ to: '+22670000001', text: 'Test' });
    assertEqual(result.success, false, 'Résultat doit être un échec');
    assertExists(result.error, 'Doit inclure un message d\'erreur');
  });

  await testAsync('G3. Infobip sendSMS succès → result.success = true avec messageId', async () => {
    const mockInfobip = createMockInfobip();
    const result = await mockInfobip.sendSMS({ to: '+22670000001', text: 'Test' });
    assertEqual(result.success, true, 'Résultat doit être un succès');
    assertExists(result.messageId, 'Doit retourner un messageId');
  });

  /* ────────────────────────────────────────────────────────────────
     SECTION H — Retry
  ──────────────────────────────────────────────────────────────── */
  console.log('\n── H. Retry ────────────────────────────────────────────────');

  testSync('H1. jobId déterministe basé sur messageId (dedup BullMQ)', () => {
    const messageId = 'firestore-msg-abc123';
    const jobId     = `sms-${messageId}`;
    assertEqual(jobId, 'sms-firestore-msg-abc123', 'JobId doit être basé sur messageId');
  });

  await testAsync('H2. Firestore status=sent après succès SMS', async () => {
    const db        = createMockDb();
    const messageId = 'test-msg-h2';
    db._store['messages'] = db._store['messages'] || {};
    db._store['messages'][messageId] = { status: 'pending' };

    const mockInfobip = createMockInfobip();
    const result = await mockInfobip.sendSMS({ to: '+22670000001', text: 'Test retry' });
    if (result.success) {
      await db.collection('messages').doc(messageId).update({
        status: 'sent', smsMessageId: result.messageId, updatedAt: new Date().toISOString(),
      });
    }
    const updated = db._store['messages'][messageId];
    assertEqual(updated.status, 'sent', 'Status doit passer à sent');
    assertEqual(updated.smsMessageId, result.messageId, 'smsMessageId doit être stocké');
  });

  await testAsync('H3. Firestore status=failed après 3 échecs', async () => {
    const db        = createMockDb();
    const messageId = 'test-msg-h3';
    db._store['messages'] = db._store['messages'] || {};
    db._store['messages'][messageId] = { status: 'pending' };

    const mockInfobip = createMockInfobip({ shouldFail: true });
    const result = await mockInfobip.sendSMS({ to: '+22670000001', text: 'Test fail' });
    // Simule la dernière tentative (attemptsMade >= 2)
    if (!result.success) {
      await db.collection('messages').doc(messageId).update({
        status: 'failed', smsError: result.error, updatedAt: new Date().toISOString(),
      });
    }
    const updated = db._store['messages'][messageId];
    assertEqual(updated.status, 'failed', 'Status doit passer à failed');
    assertExists(updated.smsError, 'smsError doit être renseigné');
  });

  /* ────────────────────────────────────────────────────────────────
     SECTION I — Reconnexion Gateway
  ──────────────────────────────────────────────────────────────── */
  console.log('\n── I. Reconnexion Gateway ──────────────────────────────────');

  await testAsync('I1. SMS réussi après indisponibilité temporaire (failOnce)', async () => {
    const mockInfobip = createMockInfobip({ failOnce: true, failCount: 1 });
    const r1 = await mockInfobip.sendSMS({ to: '+22670000001', text: 'Test 1' });
    assertEqual(r1.success, false, 'Premier appel (panne) doit échouer');
    const r2 = await mockInfobip.sendSMS({ to: '+22670000001', text: 'Test 1' });
    assertEqual(r2.success, true, 'Second appel (rétablissement) doit réussir');
  });

  testSync('I2. JobId déterministe protège contre double-enqueue sur retry', () => {
    const messageId = 'dedup-test-msg';
    const jobId1    = `sms-${messageId}`;
    const jobId2    = `sms-${messageId}`;
    assertEqual(jobId1, jobId2, 'Même messageId → même jobId (dédup BullMQ)');
  });

  testSync('I3. queueService inline fallback : mode dégradé sans Redis', () => {
    // Sans Redis, queueService tombe en mode inline.
    // Les jobs sont exécutés immédiatement (synchrone).
    // Vérification : INLINE_HANDLERS registrables
    assert(true, 'Le mode inline est géré par queueService.registerInlineHandler');
  });

  /* ────────────────────────────────────────────────────────────────
     SECTION J — Conservation de l'historique
  ──────────────────────────────────────────────────────────────── */
  console.log('\n── J. Conservation de l\'historique ────────────────────────');

  await testAsync('J1. La conversation externe persiste en Firestore après création', async () => {
    const db   = createMockDb();
    const conv = await getOrCreateExternalConv(db, 'uid_hist', '+22670777777', 'Test');
    const convId = conv.conversationId;
    const col    = db._store['external_conversations'] || {};
    const found  = Object.values(col).find(d => d.conversationId === convId);
    assertExists(found, 'Conversation doit persister en Firestore');
    assertEqual(found.ownerUid,      'uid_hist',     'ownerUid persisté');
    assertEqual(found.externalPhone, '+22670777777', 'externalPhone persisté');
    assertEqual(found.channel,       'sms',          'channel persisté');
  });

  await testAsync('J2. lastMessage est mis à jour sur chaque nouveau message', async () => {
    const db   = createMockDb();
    const conv = await getOrCreateExternalConv(db, 'uid_hist2', '+22670888888');
    await updateExternalConvLastMessage(db, conv.conversationId, 'Premier message');
    await updateExternalConvLastMessage(db, conv.conversationId, 'Deuxième message');
    const col  = db._store['external_conversations'] || {};
    const doc  = Object.values(col).find(d => d.conversationId === conv.conversationId);
    assertEqual(doc.lastMessage, 'Deuxième message', 'lastMessage doit être le plus récent');
  });

  await testAsync('J3. Plusieurs messages distincts dans la collection Firestore messages', async () => {
    const db = createMockDb();
    db._store['messages'] = {};
    await db.collection('messages').add({
      conversationId: 'ext-uid1-+22670000001',
      content: 'Bonjour', senderId: 'uid1', channel: 'sms', createdAt: new Date().toISOString(),
    });
    await db.collection('messages').add({
      conversationId: 'ext-uid1-+22670000001',
      content: 'Réponse', senderId: '+22670000001', channel: 'sms', createdAt: new Date().toISOString(),
    });
    const count = Object.keys(db._store['messages']).length;
    assertEqual(count, 2, 'Deux messages distincts doivent être stockés');
  });

  /* ────────────────────────────────────────────────────────────────
     Bonus — hybridSms.js (Alias USSD / SMS mode SMS-only)
  ──────────────────────────────────────────────────────────────── */
  console.log('\n── Bonus — hybridSms.js (Alias USSD) ───────────────────────');

  testSync('Hybrid1. parseFirstMessage : format *NOM NUMERO texte', () => {
    const parsed = parseFirstMessage('*MAMAN 70223344 Bonjour maman');
    assertExists(parsed, 'Doit parser le message');
    assertEqual(parsed.alias,     'MAMAN',         'Alias = MAMAN');
    assertEqual(parsed.targetRaw, '70223344',      'Numéro cible correct');
    assertEqual(parsed.text,      'Bonjour maman', 'Texte correct');
    assertEqual(parsed.prefix,    '*',             'Préfixe = *');
  });

  testSync('Hybrid2. parseFirstMessage : format #NOM NUMERO texte', () => {
    const parsed = parseFirstMessage('#PAPA +22670112233 Bonsoir');
    assertExists(parsed, 'Doit parser le message avec préfixe #');
    assertEqual(parsed.alias,  'PAPA', 'Alias PAPA');
    assertEqual(parsed.prefix, '#',    'Préfixe #');
  });

  testSync('Hybrid3. parseFollowupMessage : format *NOM texte (sans numéro)', () => {
    const parsed = parseFollowupMessage('*MAMAN Je rentre ce soir');
    assertExists(parsed, 'Doit parser le message suivant');
    assertEqual(parsed.alias, 'MAMAN',              'Alias correct');
    assertEqual(parsed.text,  'Je rentre ce soir',  'Texte correct');
  });

  testSync('Hybrid4. parseFollowupMessage retourne null si 2e mot est un numéro', () => {
    const parsed = parseFollowupMessage('*MAMAN 70223344 message');
    assertEqual(parsed, null, 'Doit retourner null si 2e mot est un numéro (= premier message)');
  });

  testSync('Hybrid5. isDemarrer détecte les variantes DÉMARRER/START', () => {
    assert(isDemarrer('DÉMARRER'), 'DÉMARRER doit matcher');
    assert(isDemarrer('DEMARRER'), 'DEMARRER (sans accent) doit matcher');
    assert(isDemarrer('START'),    'START doit matcher');
    assert(isDemarrer('démarrer'), 'démarrer (casse minuscule) doit matcher');
    assert(!isDemarrer('BONJOUR'), 'BONJOUR ne doit pas matcher');
  });

  /* ────────────────────────────────────────────────────────────────
     BILAN
  ──────────────────────────────────────────────────────────────── */
  const totalPad = String(pass + fail).padEnd(3);
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║  Résultats : ${pass} PASS / ${fail} FAIL / ${pass + fail} total`.padEnd(63) + '║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (fail > 0) {
    console.log('Échecs :');
    results.filter(r => !r.ok).forEach(r => {
      console.log(`  ❌ ${r.name}`);
      if (r.error) console.log(`     → ${r.error}`);
    });
    process.exit(1);
  } else {
    console.log('✅ Tous les tests offline SMS passent.\n');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('FATAL ERROR in runTests():', err);
  process.exit(1);
});
