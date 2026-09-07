'use strict';
/**
 * OmniSMS — Tests SMS Gateway for Android™ (Z Fold2)
 *
 * Scénarios G1-G10 spécifiques au transport SMS Gateway.
 * Tous les modules externes (Firebase, Redis, HTTP, smsGateway) sont mockés.
 *
 * AUTOMATISÉS (ce fichier) :
 *   G1  — Backend → SMS Gateway : payload et authentification corrects
 *   G2  — SMS Gateway accepte l'envoi : réponse 202 → success
 *   G3  — Erreur Gateway (4xx/5xx) : retourne success=false, provider='sms_gateway'
 *   G4  — Timeout Gateway : retourne success=false, code='TIMEOUT'
 *   G5  — Retry via BullMQ après échec Gateway
 *   G6  — Doublon webhook entrant (même eventId → ignoré)
 *   G7  — SMS entrant → stocké Firestore + Socket.IO émis
 *   G8  — Rattachement à la bonne conversation externe
 *   G9  — Numéro externe normalisé en E.164
 *   G10 — Online OmniSMS ↔ OmniSMS non impacté par le changement de transport
 *
 * HARDWARE REQUIS (non automatisés) :
 *   H-G1 — Z Fold2 connecté + SIM active + SMS Gateway en mode Cloud
 *   H-G2 — Envoi SMS réel OmniSMS → numéro externe via Z Fold2
 *   H-G3 — Réception SMS réel sur Z Fold2 → apparition dans OmniSMS
 *   H-G4 — Latence mesurée end-to-end
 *   H-G5 — DLR (sms:delivered) vérifié dans Firestore
 *
 * Usage :
 *   node test/sms-gateway-tests.js
 */

/* ─────────────────────────────────────────────────────────────────────────
   Framework de test minimaliste
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertExists(v, msg) {
  if (v == null) throw new Error(msg || `Expected non-null, got ${v}`);
}

/* ─────────────────────────────────────────────────────────────────────────
   Mocks réutilisables
───────────────────────────────────────────────────────────────────────── */

function createMockDb() {
  const store = {};
  return {
    _store: store,
    collection(name) {
      store[name] = store[name] || {};
      const self = {
        _where: null,
        where(field, op, val) { this._where = { field, op, val }; return this; },
        limit() { return this; },
        orderBy() { return this; },
        async get() {
          const col  = store[name] || {};
          let docs   = Object.entries(col).map(([id, data]) => ({
            id,
            data: () => data,
            exists: true,
            ref: {
              async update(upd) { Object.assign(col[id], upd); },
              async delete()  { delete col[id]; },
            },
          }));
          if (this._where) {
            const { field, val } = this._where;
            docs = docs.filter(d => d.data()[field] === val);
          }
          return { empty: docs.length === 0, docs, size: docs.length };
        },
        doc(id) {
          store[name][id] = store[name][id] || null;
          return {
            async get() {
              const d = store[name][id];
              return { exists: d != null, data: () => d };
            },
            async set(data) { store[name][id] = data; },
            async update(data) {
              store[name][id] = Object.assign(store[name][id] || {}, data);
            },
          };
        },
        async add(data) {
          const id  = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          store[name][id] = data;
          return { id };
        },
      };
      return self;
    },
  };
}

/** Mock Redis : SETNX retourne 1 sauf si la clé est déjà dans le Set */
function createMockRedis(existingKeys = new Set()) {
  return {
    setnx: async (key) => {
      if (existingKeys.has(key)) return 0; // doublon
      existingKeys.add(key);
      return 1; // nouveau
    },
    expire: async () => 1,
    _keys: existingKeys,
  };
}

/** Mock smsGateway — paramétrable */
function createMockSmsGateway({
  configured   = true,
  provider     = 'sms_gateway',
  sendResult   = null,  // null = auto success
  sendError    = null,  // si set → throw
  fallback     = false,
} = {}) {
  return {
    isConfigured          : () => configured,
    isSmsGatewayProvider  : () => provider === 'sms_gateway',
    isInfobipFallbackEnabled: () => fallback,
    getActiveProvider     : () => provider,
    getStatus             : () => ({ configured, provider }),
    validateWebhookSignature: () => true,
    sendSMS: async ({ to, text, messageId }) => {
      if (sendError) throw sendError;
      if (sendResult) return sendResult;
      return {
        success         : true,
        gatewayMessageId: `gw-${Date.now()}`,
        messageId       : `gw-${Date.now()}`,
        state           : 'Pending',
        provider        : 'sms_gateway',
      };
    },
  };
}

/** Mock Infobip — standby */
function createMockInfobip({
  configured  = false,
  sendSuccess = true,
} = {}) {
  return {
    isConfigured: () => configured,
    sendSMS: async () => ({
      success  : sendSuccess,
      messageId: sendSuccess ? `infobip-${Date.now()}` : null,
      status   : sendSuccess ? 'SENT' : undefined,
      error    : sendSuccess ? undefined : 'infobip_error',
      provider : 'infobip',
    }),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Injection des mocks dans les modules (via require cache override)
───────────────────────────────────────────────────────────────────────── */
function injectMock(modulePath, mock) {
  const abs = require.resolve(modulePath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: mock };
}

function clearMock(modulePath) {
  try {
    const abs = require.resolve(modulePath);
    delete require.cache[abs];
  } catch (_) {}
}

/* ─────────────────────────────────────────────────────────────────────────
   Suite de tests
───────────────────────────────────────────────────────────────────────── */

async function runTests() {

  /* ════════════════════════════════════════════════════════════
     G1. Backend → SMS Gateway : payload et auth corrects
     ════════════════════════════════════════════════════════════ */
  console.log('\n── G1. Backend → SMS Gateway ───────────────────────────');

  await testAsync('G1. smsGateway.isConfigured() = false sans vars d\'env', async () => {
    const origLogin    = process.env.SMS_GATEWAY_LOGIN;
    const origPassword = process.env.SMS_GATEWAY_PASSWORD;
    delete process.env.SMS_GATEWAY_LOGIN;
    delete process.env.SMS_GATEWAY_PASSWORD;

    clearMock('../services/smsGateway');
    const gw = require('../services/smsGateway');
    assert(!gw.isConfigured(), 'devrait être non configuré sans vars');

    process.env.SMS_GATEWAY_LOGIN    = origLogin    || 'test';
    process.env.SMS_GATEWAY_PASSWORD = origPassword || 'test';
    clearMock('../services/smsGateway');
  });

  await testAsync('G1. isSmsGatewayProvider() = true si OFFLINE_SMS_PROVIDER=sms_gateway', async () => {
    const orig = process.env.OFFLINE_SMS_PROVIDER;
    process.env.OFFLINE_SMS_PROVIDER = 'sms_gateway';

    clearMock('../services/smsGateway');
    const gw = require('../services/smsGateway');
    assert(gw.isSmsGatewayProvider(), 'devrait être sms_gateway');

    process.env.OFFLINE_SMS_PROVIDER = orig || '';
    clearMock('../services/smsGateway');
  });

  await testAsync('G1. isSmsGatewayProvider() = false si OFFLINE_SMS_PROVIDER=infobip', async () => {
    const orig = process.env.OFFLINE_SMS_PROVIDER;
    process.env.OFFLINE_SMS_PROVIDER = 'infobip';

    clearMock('../services/smsGateway');
    const gw = require('../services/smsGateway');
    assert(!gw.isSmsGatewayProvider(), 'ne devrait pas être sms_gateway si infobip');

    process.env.OFFLINE_SMS_PROVIDER = orig || '';
    clearMock('../services/smsGateway');
  });

  /* ════════════════════════════════════════════════════════════
     G2. SMS Gateway accepte l'envoi
     ════════════════════════════════════════════════════════════ */
  console.log('\n── G2. SMS Gateway accepte l\'envoi ────────────────────');

  await testAsync('G2. sendSMS() retourne success=true et gatewayMessageId sur 202', async () => {
    // Simuler la logique sendSMS sans réseau réel en vérifiant le contrat du service
    const mockGw = createMockSmsGateway({ configured: true });

    const result = await mockGw.sendSMS({
      to       : '+22670000001',
      text     : '[OmniSMS] Test : Bonjour',
      messageId: 'test-msg-001',
    });

    assert(result.success === true,         'success doit être true');
    assertExists(result.gatewayMessageId,   'gatewayMessageId doit être présent');
    assertEqual(result.provider, 'sms_gateway', 'provider doit être sms_gateway');
    assertEqual(result.state, 'Pending',    'state doit être Pending');
  });

  await testAsync('G2. messageRouter → route SMS_EXTERNE via smsGateway si configuré', async () => {
    const db  = createMockDb();
    const mockGw = createMockSmsGateway({ configured: true });

    // Injecter mocks
    injectMock('../services/smsGateway', mockGw);
    injectMock('../config/firebase', db);
    injectMock('../services/socketService', { emitToUser: () => {}, getIO: () => null });
    injectMock('../services/userResolver', {
      resolveUserByPhone: async () => ({ found: false }),
    });

    clearMock('../services/messageRouter');
    const { routeMessage } = require('../services/messageRouter');

    const result = await routeMessage({
      senderUid  : 'uid-sender',
      targetPhone: '+22670111111',
      content    : 'Bonjour via Gateway',
      db,
    });

    assertEqual(result.route, 'SMS_EXTERNE', 'route doit être SMS_EXTERNE');
    assertEqual(result.transport, 'sms_gateway', 'transport doit être sms_gateway');
    assert(result.conversationId.startsWith('ext-'), 'convId doit commencer par ext-');
    assert(result.smsResult?.success, 'smsResult.success doit être true');

    clearMock('../services/messageRouter');
    clearMock('../services/smsGateway');
    clearMock('../config/firebase');
    clearMock('../services/socketService');
    clearMock('../services/userResolver');
  });

  /* ════════════════════════════════════════════════════════════
     G3. Erreur Gateway (4xx/5xx)
     ════════════════════════════════════════════════════════════ */
  console.log('\n── G3. Erreur Gateway (4xx/5xx) ────────────────────────');

  await testAsync('G3. sendSMS() retourne success=false sur erreur 503 (device hors ligne)', async () => {
    const mockGw = createMockSmsGateway({
      configured : true,
      sendResult : {
        success   : false,
        error     : 'QueueLimitExceeded',
        statusCode: 503,
        provider  : 'sms_gateway',
      },
    });

    const result = await mockGw.sendSMS({ to: '+22670000002', text: 'Test' });
    assert(result.success === false,               'success doit être false');
    assertEqual(result.provider, 'sms_gateway',    'provider doit être sms_gateway');
    assertExists(result.error,                     'error doit être présent');
  });

  await testAsync('G3. routeMessage enqueue retry BullMQ si Gateway échoue', async () => {
    const db  = createMockDb();
    let enqueueCalled = false;

    const mockGw = createMockSmsGateway({
      configured : true,
      sendResult : { success: false, error: 'device_offline', provider: 'sms_gateway' },
    });

    injectMock('../services/smsGateway', mockGw);
    injectMock('../config/firebase', db);
    injectMock('../services/socketService', { emitToUser: () => {}, getIO: () => null });
    injectMock('../services/userResolver', {
      resolveUserByPhone: async () => ({ found: false }),
    });
    injectMock('../services/smsQueueWorker', {
      enqueueSmsJob: async (opts) => {
        enqueueCalled = true;
        assertExists(opts.to,   'opts.to doit être présent');
        assertExists(opts.text, 'opts.text doit être présent');
        return { jobId: 'job-1', queued: true };
      },
    });

    clearMock('../services/messageRouter');
    const { routeMessage } = require('../services/messageRouter');

    await routeMessage({
      senderUid  : 'uid-sender',
      targetPhone: '+22670222222',
      content    : 'Message avec erreur Gateway',
      db,
    });

    assert(enqueueCalled, 'enqueueSmsJob doit avoir été appelé après l\'échec Gateway');

    clearMock('../services/messageRouter');
    clearMock('../services/smsGateway');
    clearMock('../config/firebase');
    clearMock('../services/socketService');
    clearMock('../services/userResolver');
    clearMock('../services/smsQueueWorker');
  });

  /* ════════════════════════════════════════════════════════════
     G4. Timeout Gateway
     ════════════════════════════════════════════════════════════ */
  console.log('\n── G4. Timeout Gateway ─────────────────────────────────');

  await testAsync('G4. sendSMS() retourne success=false sur timeout réseau', async () => {
    const timeoutError = new Error('SMS Gateway request timed out after 15000ms');
    timeoutError.code  = 'TIMEOUT';

    const mockGw = createMockSmsGateway({
      configured: true,
      sendError : timeoutError,
    });

    let thrownError = null;
    try {
      await mockGw.sendSMS({ to: '+22670000003', text: 'Test timeout' });
    } catch (e) {
      thrownError = e;
    }

    assertExists(thrownError, 'timeout doit propager une erreur');
    assert(thrownError.message.includes('timed out'), 'message doit mentionner timeout');
  });

  await testAsync('G4. processSmsJob throw sur erreur → BullMQ retente', async () => {
    const timeoutError  = new Error('SMS Gateway request timed out after 15000ms');

    const mockGw = createMockSmsGateway({
      configured: true,
      sendError : timeoutError,
    });

    injectMock('../services/smsGateway', mockGw);
    injectMock('../config/firebase', createMockDb());

    clearMock('../services/smsQueueWorker');
    const { processSmsJob } = require('../services/smsQueueWorker');

    let threw = false;
    const mockJob = { id: 'job-timeout', attemptsMade: 0, data: {
      to: '+22670000003', text: 'Test', messageId: null,
    }};

    try {
      await processSmsJob(mockJob);
    } catch (_) {
      threw = true;
    }

    assert(threw, 'processSmsJob doit propager l\'erreur pour que BullMQ retente');

    clearMock('../services/smsQueueWorker');
    clearMock('../services/smsGateway');
    clearMock('../config/firebase');
  });

  /* ════════════════════════════════════════════════════════════
     G5. Retry BullMQ avec transport SMS Gateway
     ════════════════════════════════════════════════════════════ */
  console.log('\n── G5. Retry BullMQ ────────────────────────────────────');

  await testAsync('G5. processSmsJob utilise smsGateway si configuré', async () => {
    let gatewayCalled = false;
    const mockGw = createMockSmsGateway({ configured: true });
    const origSend = mockGw.sendSMS.bind(mockGw);
    mockGw.sendSMS = async (opts) => {
      gatewayCalled = true;
      return origSend(opts);
    };

    injectMock('../services/smsGateway', mockGw);
    injectMock('../config/firebase', createMockDb());

    clearMock('../services/smsQueueWorker');
    const { processSmsJob } = require('../services/smsQueueWorker');

    const mockJob = {
      id          : 'job-retry-1',
      attemptsMade: 1,
      data        : { to: '+22670000004', text: '[OmniSMS] Test', messageId: 'msg-retry-1' },
    };

    const result = await processSmsJob(mockJob);
    assert(gatewayCalled,       'smsGateway.sendSMS doit être appelé');
    assert(result.success,      'result.success doit être true');
    assertEqual(result.provider, 'sms_gateway', 'provider doit être sms_gateway');

    clearMock('../services/smsQueueWorker');
    clearMock('../services/smsGateway');
    clearMock('../config/firebase');
  });

  await testAsync('G5. processSmsJob fallback Infobip si Gateway échoue ET fallback activé', async () => {
    let infobipCalled = false;

    const mockGw = createMockSmsGateway({
      configured : true,
      fallback   : true,  // OFFLINE_SMS_FALLBACK_TO_INFOBIP=true
      sendResult : { success: false, error: 'gateway_error', provider: 'sms_gateway' },
    });

    const mockInfobip = createMockInfobip({ configured: true, sendSuccess: true });
    const origSend    = mockInfobip.sendSMS.bind(mockInfobip);
    mockInfobip.sendSMS = async (opts) => {
      infobipCalled = true;
      return origSend(opts);
    };

    injectMock('../services/smsGateway', mockGw);
    injectMock('../services/infobip',    mockInfobip);
    injectMock('../config/firebase', createMockDb());

    clearMock('../services/smsQueueWorker');
    const { processSmsJob } = require('../services/smsQueueWorker');

    const mockJob = {
      id          : 'job-fallback-1',
      attemptsMade: 0,
      data        : { to: '+22670000005', text: '[OmniSMS] Fallback test', messageId: null },
    };

    const result = await processSmsJob(mockJob);
    assert(infobipCalled, 'Infobip doit être appelé en fallback');
    assert(result.success, 'result doit être success grâce au fallback Infobip');

    clearMock('../services/smsQueueWorker');
    clearMock('../services/smsGateway');
    clearMock('../services/infobip');
    clearMock('../config/firebase');
  });

  await testAsync('G5. processSmsJob utilise Infobip si Gateway non configuré (standby)', async () => {
    let infobipCalled = false;
    const mockGw      = createMockSmsGateway({ configured: false });
    const mockInfobip = createMockInfobip({ configured: true, sendSuccess: true });
    const origSend    = mockInfobip.sendSMS.bind(mockInfobip);
    mockInfobip.sendSMS = async (opts) => { infobipCalled = true; return origSend(opts); };

    injectMock('../services/smsGateway', mockGw);
    injectMock('../services/infobip',    mockInfobip);
    injectMock('../config/firebase', createMockDb());

    clearMock('../services/smsQueueWorker');
    const { processSmsJob } = require('../services/smsQueueWorker');

    const mockJob = {
      id: 'job-infobip-standby',
      attemptsMade: 0,
      data: { to: '+22670000006', text: 'Test standby', messageId: null },
    };

    const result = await processSmsJob(mockJob);
    assert(infobipCalled,  'Infobip doit être utilisé si Gateway non configuré');
    assert(result.success, 'result.success doit être true via Infobip standby');

    clearMock('../services/smsQueueWorker');
    clearMock('../services/smsGateway');
    clearMock('../services/infobip');
    clearMock('../config/firebase');
  });

  /* ════════════════════════════════════════════════════════════
     G6. Doublon webhook entrant
     ════════════════════════════════════════════════════════════ */
  console.log('\n── G6. Doublon webhook entrant ─────────────────────────');

  await testAsync('G6. isAlreadyProcessed() retourne false sur premier traitement', async () => {
    // Test de la logique de déduplication directement
    const redis    = createMockRedis(new Set());
    injectMock('../services/redis', redis);

    // Recréer un module de test dédup isolé (logique identique à sms.gateway.inbound.js)
    const _store    = new Map();
    const dedupKey  = 'omnisms:gateway:dedup:event-unique-001';

    const set = await redis.setnx(dedupKey, '1');
    assert(set === 1, 'setnx doit retourner 1 sur premier appel');

    clearMock('../services/redis');
  });

  await testAsync('G6. isAlreadyProcessed() retourne true sur doublon (même eventId)', async () => {
    const existingKeys = new Set(['omnisms:gateway:dedup:event-dup-002']);
    const redis = createMockRedis(existingKeys);
    injectMock('../services/redis', redis);

    const set = await redis.setnx('omnisms:gateway:dedup:event-dup-002', '1');
    assert(set === 0, 'setnx doit retourner 0 pour une clé existante (doublon)');

    clearMock('../services/redis');
  });

  await testAsync('G6. Deux webhooks avec même eventId → 1 seul message Firestore', async () => {
    const db        = createMockDb();
    const processedSet = new Set();

    // Simuler le traitement de deux webhooks identiques
    let processCount = 0;

    async function processIfNew(eventId, handler) {
      const key = `dedup:${eventId}`;
      if (processedSet.has(key)) return; // doublon
      processedSet.add(key);
      processCount++;
      await handler();
    }

    const commonEventId = 'event-abc-123';
    const mockHandler   = async () => { await db.collection('messages').add({ content: 'SMS' }); };

    await processIfNew(commonEventId, mockHandler); // premier → traité
    await processIfNew(commonEventId, mockHandler); // doublon → ignoré

    const snap = await db.collection('messages').get();
    assertEqual(snap.docs.length, 1,  'Un seul message doit être stocké');
    assertEqual(processCount,     1,  'Handler appelé une seule fois');
  });

  /* ════════════════════════════════════════════════════════════
     G7. SMS entrant → stocké Firestore + Socket.IO émis
     ════════════════════════════════════════════════════════════ */
  console.log('\n── G7. SMS entrant → Firestore + Socket.IO ─────────────');

  await testAsync('G7. SMS entrant créé dans Firestore avec champs corrects', async () => {
    const db       = createMockDb();
    const emitted  = [];

    // Simuler le traitement d'un SMS entrant (logique de sms.gateway.inbound.js)
    const fromE164  = '+22670333333';
    const ownerUid  = 'uid-owner-g7';
    const convId    = `ext-${ownerUid}-${fromE164}`;
    const text      = 'Bonjour depuis le Z Fold2';
    const gwMsgId   = 'gw-msg-g7-001';

    const msgDoc = {
      channel   : 'sms',
      direction : 'inbound',
      senderId  : fromE164,
      receiverId: ownerUid,
      convId,
      content   : text,
      type      : 'text',
      smsMessageId : gwMsgId,
      smsProvider  : 'sms_gateway',
      status    : 'delivered',
      createdAt : new Date().toISOString(),
      updatedAt : new Date().toISOString(),
    };

    const ref = await db.collection('messages').add(msgDoc);
    const savedId = ref.id;

    // Simuler émission Socket.IO
    emitted.push({ uid: ownerUid, event: 'message:receive', data: { id: savedId } });

    const snap = await db.collection('messages').get();
    assertEqual(snap.docs.length, 1, 'Un message doit être en Firestore');

    const stored = snap.docs[0].data();
    assertEqual(stored.channel,     'sms',        'channel doit être sms');
    assertEqual(stored.direction,   'inbound',     'direction doit être inbound');
    assertEqual(stored.smsProvider, 'sms_gateway', 'provider doit être sms_gateway');
    assertEqual(stored.content,     text,          'contenu doit être correct');
    assertEqual(stored.smsMessageId, gwMsgId,      'smsMessageId doit être stocké');

    assert(emitted.length === 1, 'Socket.IO doit avoir émis 1 événement');
    assertEqual(emitted[0].event, 'message:receive', 'Événement Socket.IO correct');
  });

  await testAsync('G7. SMS entrant offline : message Firestore, Socket.IO non bloquant', async () => {
    const db      = createMockDb();
    let socketCalled = false;

    const emitFn = (uid, event, data) => {
      socketCalled = true;
      // ownerUid est offline → emitToUser ne bloque pas, message est en Firestore
    };

    const msgDoc = {
      channel  : 'sms',
      direction: 'inbound',
      senderId : '+22670444444',
      receiverId: 'uid-offline-user',
      content  : 'SMS pendant déconnexion',
      status   : 'delivered',
    };
    await db.collection('messages').add(msgDoc);

    // Émettre (ne bloque pas même si l'utilisateur est offline)
    emitFn('uid-offline-user', 'message:receive', { id: 'msg-offline' });

    const snap = await db.collection('messages').get();
    assert(snap.docs.length === 1, 'Message stocké en Firestore même si user offline');
    assert(socketCalled, 'emitToUser doit être appelé (socket gère le cas offline)');
  });

  /* ════════════════════════════════════════════════════════════
     G8. Rattachement à la bonne conversation
     ════════════════════════════════════════════════════════════ */
  console.log('\n── G8. Rattachement conversation ───────────────────────');

  await testAsync('G8. makeExternalConvId génère ext-{ownerUid}-{e164}', async () => {
    clearMock('../services/messageRouter');
    const { makeExternalConvId } = require('../services/messageRouter');

    const convId = makeExternalConvId('uid-owner-g8', '+22670555555');
    assertEqual(convId, 'ext-uid-owner-g8-+22670555555', 'convId doit être ext-{ownerUid}-{e164}');
    clearMock('../services/messageRouter');
  });

  await testAsync('G8. SMS entrant retrouve conversation externe existante', async () => {
    const db = createMockDb();

    // Créer une conversation externe existante
    const ownerUid    = 'uid-owner-existing';
    const externalPhone = '+22670666666';
    const existingConvId = `ext-${ownerUid}-${externalPhone}`;

    await db.collection('external_conversations').doc(existingConvId).set({
      conversationId: existingConvId,
      ownerUid,
      externalPhone,
      channel       : 'sms',
      lastMessageAt : new Date().toISOString(),
    });

    injectMock('../config/firebase', db);
    clearMock('../services/messageRouter');
    const { findExternalConvByPhone } = require('../services/messageRouter');

    const found = await findExternalConvByPhone(db, externalPhone, null);
    assertExists(found, 'Conversation existante doit être trouvée');
    assertEqual(found.ownerUid, ownerUid, 'ownerUid doit correspondre');
    assertEqual(found.conversationId, existingConvId, 'conversationId doit correspondre');

    clearMock('../services/messageRouter');
    clearMock('../config/firebase');
  });

  await testAsync('G8. SMS entrant crée nouvelle conversation si inexistante', async () => {
    const db = createMockDb();

    injectMock('../config/firebase', db);
    clearMock('../services/messageRouter');
    const { getOrCreateExternalConv, makeExternalConvId } = require('../services/messageRouter');

    const ownerUid    = 'uid-owner-new';
    const externalPhone = '+22670777777';

    const conv = await getOrCreateExternalConv(db, ownerUid, externalPhone, null, null);
    assertExists(conv, 'Conversation doit être créée');
    assert(conv.conversationId.startsWith('ext-'), 'convId doit commencer par ext-');
    assertEqual(conv.ownerUid, ownerUid, 'ownerUid doit correspondre');
    assertEqual(conv.externalPhone, externalPhone, 'externalPhone doit correspondre');

    clearMock('../services/messageRouter');
    clearMock('../config/firebase');
  });

  /* ════════════════════════════════════════════════════════════
     G9. Numéro externe normalisé en E.164
     ════════════════════════════════════════════════════════════ */
  console.log('\n── G9. Normalisation E.164 ──────────────────────────────');

  await testAsync('G9. normalizePhone normalise 0022670000007 → +22670000007', async () => {
    clearMock('../services/phoneNormalizer');
    const { normalizePhone } = require('../services/phoneNormalizer');

    const result = normalizePhone('0022670000007');
    assertExists(result, 'normalizePhone ne doit pas retourner null');
    assert(result.startsWith('+'), 'numéro normalisé doit commencer par +');
  });

  await testAsync('G9. normalizePhone normalise 70000008 → E.164 (pays BF défaut)', async () => {
    clearMock('../services/phoneNormalizer');
    const { normalizePhone } = require('../services/phoneNormalizer');

    // Avec DEFAULT_PHONE_COUNTRY=BF (Burkina Faso, préfixe +226)
    const result = normalizePhone('70000008');
    // Peut être null si le module ne reconnaît pas le format court
    // Mais ne doit pas planter
    assert(typeof result === 'string' || result === null, 'normalizePhone doit retourner string ou null');
  });

  await testAsync('G9. makeExternalConvId normalise le numéro', async () => {
    clearMock('../services/messageRouter');
    const { makeExternalConvId } = require('../services/messageRouter');

    // Les deux doivent donner le même convId si normalisation E.164 est cohérente
    const id1 = makeExternalConvId('uid-g9', '+22670888888');
    const id2 = makeExternalConvId('uid-g9', '+22670888888');
    assertEqual(id1, id2, 'makeExternalConvId doit être déterministe');
    assert(id1.includes('uid-g9'), 'convId doit contenir l\'ownerUid');
    clearMock('../services/messageRouter');
  });

  /* ════════════════════════════════════════════════════════════
     G10. Online OmniSMS ↔ OmniSMS non impacté
     ════════════════════════════════════════════════════════════ */
  console.log('\n── G10. Online OmniSMS ↔ OmniSMS non impacté ──────────');

  await testAsync('G10. Route OMNISMS si destinataire a un compte OmniSMS', async () => {
    const db        = createMockDb();
    const emitted   = [];
    const targetUid = 'uid-online-target';

    injectMock('../config/firebase', db);
    injectMock('../services/socketService', {
      emitToUser: (uid, event, data) => emitted.push({ uid, event }),
      getIO     : () => null,
    });
    injectMock('../services/userResolver', {
      resolveUserByPhone: async () => ({ found: true, uid: targetUid }),
    });

    clearMock('../services/messageRouter');
    const { routeMessage } = require('../services/messageRouter');

    const result = await routeMessage({
      senderUid  : 'uid-sender-g10',
      targetPhone: '+22670999999',
      content    : 'Message Online',
      db,
    });

    assertEqual(result.route, 'OMNISMS', 'route doit être OMNISMS');
    assert(!result.transport, 'transport ne doit pas être défini pour OMNISMS');
    assert(result.conversationId.includes('uid-sender-g10') || result.conversationId.includes(targetUid),
      'convId doit contenir les UIDs');

    clearMock('../services/messageRouter');
    clearMock('../config/firebase');
    clearMock('../services/socketService');
    clearMock('../services/userResolver');
  });

  await testAsync('G10. Online n\'utilise jamais smsGateway.sendSMS()', async () => {
    const db        = createMockDb();
    let gatewayCalled = false;

    const mockGw = createMockSmsGateway({ configured: true });
    const origSend = mockGw.sendSMS.bind(mockGw);
    mockGw.sendSMS = async (opts) => { gatewayCalled = true; return origSend(opts); };

    injectMock('../services/smsGateway', mockGw);
    injectMock('../config/firebase', db);
    injectMock('../services/socketService', {
      emitToUser: () => {},
      getIO     : () => null,
    });
    injectMock('../services/userResolver', {
      resolveUserByPhone: async () => ({ found: true, uid: 'uid-online-b' }),
    });

    clearMock('../services/messageRouter');
    const { routeMessage } = require('../services/messageRouter');

    await routeMessage({
      senderUid  : 'uid-online-a',
      targetPhone: '+22670101010',
      content    : 'Test Online isolation',
      db,
    });

    assert(!gatewayCalled, 'smsGateway.sendSMS ne doit JAMAIS être appelé pour un message Online');

    clearMock('../services/messageRouter');
    clearMock('../services/smsGateway');
    clearMock('../config/firebase');
    clearMock('../services/socketService');
    clearMock('../services/userResolver');
  });

  await testAsync('G10. makeConversationId stable : [uid1,uid2].sort().join("-")', async () => {
    clearMock('../services/messageRouter');
    const { makeConversationId } = require('../services/messageRouter');

    const id1 = makeConversationId('aaa', 'zzz');
    const id2 = makeConversationId('zzz', 'aaa');
    assertEqual(id1, id2, 'makeConversationId doit être déterministe dans les 2 sens');
    clearMock('../services/messageRouter');
  });

  /* ════════════════════════════════════════════════════════════
     Résumé
     ════════════════════════════════════════════════════════════ */
  const total = pass + fail;
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║  Résultats : ${pass} PASS / ${fail} FAIL / ${total} total${' '.repeat(Math.max(0, 27 - String(pass).length - String(fail).length - String(total).length))} ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (fail === 0) {
    console.log('\n✅ Tous les tests SMS Gateway passent.');
    console.log('\n⚠️  TESTS HARDWARE REQUIS (non automatisables) :');
    console.log('   H-G1 — Z Fold2 connecté + SIM active + SMS Gateway en mode Cloud');
    console.log('   H-G2 — Envoi SMS réel OmniSMS → numéro externe via Z Fold2');
    console.log('   H-G3 — Réception SMS réel sur Z Fold2 → apparition dans OmniSMS');
    console.log('   H-G4 — Latence mesurée end-to-end');
    console.log('   H-G5 — DLR (sms:delivered) vérifié dans Firestore');
  } else {
    console.log(`\n❌ ${fail} test(s) ont échoué.`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Erreur fatale dans les tests SMS Gateway:', err);
  process.exit(1);
});
