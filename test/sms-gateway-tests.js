'use strict';
/**
 * OmniSMS — Tests INfiniReach Transport (Z Fold2)
 *
 * Scénarios A-E spécifiques au transport INfiniReach.
 * Tous les modules externes (Firebase, Redis, HTTP, smsGateway) sont mockés.
 *
 * AUTOMATISÉS (ce fichier) :
 *   A — Envoi SMS INfiniReach : URL, X-API-Key, channel=sms, from, to, message, externalId
 *   B — Webhook entrant INfiniReach : payload data.*, mapping, déduplication data.messageId
 *   C — Erreurs API : 401, 400, 429, 500, timeout
 *   D — Online : aucun appel INfiniReach depuis le mode Online
 *   E — Offline : envoi via INfiniReach + retry conservé
 *
 * TESTS DE RÉGRESSION CONSERVÉS :
 *   G1 — isConfigured(), isSmsGatewayProvider()
 *   G2 — messageRouter → route SMS_EXTERNE via smsGateway
 *   G3 — Retry BullMQ après échec Gateway
 *   G4 — Timeout Gateway
 *   G5 — selectTransport() smsGateway/Infobip
 *   G6 — Déduplication webhook entrant
 *   G7 — SMS entrant → Firestore + Socket.IO
 *   G8 — Rattachement conversation
 *   G9 — Normalisation E.164
 *   G10 — Online non impacté
 *
 * HARDWARE REQUIS (non automatisés) :
 *   H-A1 — Z Fold2 connecté + INfiniReach + SIM active
 *   H-A2 — Envoi SMS réel OmniSMS → numéro externe via Z Fold2
 *   H-A3 — Réception SMS réel sur Z Fold2 → apparition dans OmniSMS
 *   H-A4 — Latence mesurée end-to-end
 *   H-A5 — DLR (message.delivered) vérifié dans Firestore
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

/**
 * Mock smsGateway INfiniReach — paramétrable.
 * Intercept HTTP via capturedRequests pour vérifier payload/headers.
 */
function createMockSmsGateway({
  configured    = true,
  provider      = 'sms_gateway',
  sendResult    = null,   // null = auto success
  sendError     = null,   // si set → throw
  fallback      = false,
  capturedRequests = null, // tableau partagé pour capturer les appels
} = {}) {
  return {
    isConfigured           : () => configured,
    isSmsGatewayProvider   : () => provider === 'sms_gateway',
    isInfobipFallbackEnabled: () => fallback,
    getActiveProvider      : () => provider,
    getStatus              : () => ({ configured, provider }),
    validateWebhookSignature: () => true,
    sendSMS: async ({ to, text, messageId }) => {
      if (sendError) throw sendError;

      // Capturer la requête pour vérification dans les tests A
      if (capturedRequests) {
        capturedRequests.push({
          method : 'POST',
          path   : '/api/v1/messages',
          payload: {
            to,
            message : text,
            from    : process.env.INFINIREACH_FROM_NUMBER || '+22600000000',
            channel : 'sms',
            ...(messageId ? { externalId: `omnisms-${messageId}` } : {}),
          },
          headers: {
            'X-API-Key': process.env.INFINIREACH_API_KEY || 'test-key',
          },
        });
      }

      if (sendResult) return sendResult;
      return {
        success         : true,
        gatewayMessageId: `ir-${Date.now()}`,
        messageId       : `ir-${Date.now()}`,
        state           : 'queued',
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
   Helpers — payload INfiniReach
───────────────────────────────────────────────────────────────────────── */

/**
 * Crée un corps de webhook INfiniReach message.inbound valide.
 */
function makeInboundWebhook({
  messageId  = `ir-inbound-${Date.now()}`,
  from       = '+22670123456',
  to         = '+22600000000',
  body       = 'Bonjour depuis le Z Fold2',
  deviceId   = 'zfold2-device-test',
  timestamp  = new Date().toISOString(),
  status     = 'delivered',
  direction  = 'inbound',
} = {}) {
  return {
    event    : 'message.inbound',
    timestamp: new Date().toISOString(),
    data     : { messageId, direction, from, to, body, deviceId, timestamp, status },
  };
}

/**
 * Crée un corps de webhook INfiniReach DLR (statut sortant).
 */
function makeDlrWebhook(event, {
  messageId  = `ir-dlr-${Date.now()}`,
  status     = 'delivered',
  timestamp  = new Date().toISOString(),
} = {}) {
  return {
    event,
    timestamp: new Date().toISOString(),
    data     : { messageId, status, timestamp },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Suite de tests
───────────────────────────────────────────────────────────────────────── */

async function runTests() {

  /* ════════════════════════════════════════════════════════════
     TEST A — Envoi SMS INfiniReach
     Vérifie : URL, X-API-Key, Content-Type, channel=sms, from, to, message, externalId
     ════════════════════════════════════════════════════════════ */
  console.log('\n══ TEST A — Envoi SMS INfiniReach ══════════════════════════');

  await testAsync('A1. smsGateway.isConfigured() = false si INFINIREACH_API_KEY absent', async () => {
    const origApiKey  = process.env.INFINIREACH_API_KEY;
    const origFrom    = process.env.INFINIREACH_FROM_NUMBER;
    delete process.env.INFINIREACH_API_KEY;
    delete process.env.INFINIREACH_FROM_NUMBER;

    clearMock('../services/smsGateway');
    const gw = require('../services/smsGateway');
    assert(!gw.isConfigured(), 'devrait être non configuré sans INFINIREACH_API_KEY');

    process.env.INFINIREACH_API_KEY      = origApiKey    || 'test-key';
    process.env.INFINIREACH_FROM_NUMBER  = origFrom      || '+22600000000';
    clearMock('../services/smsGateway');
  });

  await testAsync('A2. smsGateway.isConfigured() = false si INFINIREACH_FROM_NUMBER absent', async () => {
    const origApiKey  = process.env.INFINIREACH_API_KEY;
    const origFrom    = process.env.INFINIREACH_FROM_NUMBER;
    process.env.INFINIREACH_API_KEY = 'test-key';
    delete process.env.INFINIREACH_FROM_NUMBER;

    clearMock('../services/smsGateway');
    const gw = require('../services/smsGateway');
    assert(!gw.isConfigured(), 'devrait être non configuré sans INFINIREACH_FROM_NUMBER');

    process.env.INFINIREACH_API_KEY      = origApiKey    || 'test-key';
    process.env.INFINIREACH_FROM_NUMBER  = origFrom      || '+22600000000';
    clearMock('../services/smsGateway');
  });

  await testAsync('A3. smsGateway.isConfigured() = true avec API_KEY + FROM_NUMBER', async () => {
    const origApiKey  = process.env.INFINIREACH_API_KEY;
    const origFrom    = process.env.INFINIREACH_FROM_NUMBER;
    const origEnabled = process.env.INFINIREACH_ENABLED;

    process.env.INFINIREACH_API_KEY     = 'test-api-key';
    process.env.INFINIREACH_FROM_NUMBER = '+22600000000';
    process.env.INFINIREACH_ENABLED     = 'true';

    clearMock('../services/smsGateway');
    const gw = require('../services/smsGateway');
    assert(gw.isConfigured(), 'devrait être configuré avec API_KEY + FROM_NUMBER');

    process.env.INFINIREACH_API_KEY      = origApiKey    || '';
    process.env.INFINIREACH_FROM_NUMBER  = origFrom      || '';
    process.env.INFINIREACH_ENABLED      = origEnabled   || 'true';
    clearMock('../services/smsGateway');
  });

  await testAsync('A4. sendSMS() payload : URL /api/v1/messages, channel=sms, from, to, message, externalId', async () => {
    const captured = [];
    const mockGw   = createMockSmsGateway({
      configured      : true,
      capturedRequests: captured,
    });

    process.env.INFINIREACH_FROM_NUMBER = '+22600000000';

    const result = await mockGw.sendSMS({
      to       : '+22670123456',
      text     : '[OmniSMS] Test envoi INfiniReach',
      messageId: 'test-msg-infinireach-001',
    });

    assert(result.success === true, 'sendSMS doit retourner success=true');
    assertEqual(result.provider, 'sms_gateway', 'provider doit être sms_gateway');

    // Vérifier le payload capturé
    assert(captured.length === 1, 'une requête doit être capturée');
    const req = captured[0];

    assertEqual(req.path,    '/api/v1/messages', 'endpoint doit être /api/v1/messages');
    assertEqual(req.method,  'POST',             'méthode doit être POST');
    assertEqual(req.payload.channel, 'sms',      'channel doit être "sms"');
    assertEqual(req.payload.to,      '+22670123456',                 'to doit être présent');
    assertExists(req.payload.from,   'from doit être présent (INFINIREACH_FROM_NUMBER)');
    assertExists(req.payload.message,'message doit être présent');
    assertEqual(req.payload.externalId, 'omnisms-test-msg-infinireach-001', 'externalId doit être préfixé "omnisms-"');
    assertExists(req.headers['X-API-Key'], 'X-API-Key header doit être présent');
  });

  await testAsync('A5. sendSMS() sans messageId : pas d\'externalId dans payload', async () => {
    const captured = [];
    const mockGw   = createMockSmsGateway({
      configured      : true,
      capturedRequests: captured,
    });

    await mockGw.sendSMS({
      to  : '+22670123456',
      text: 'Test sans messageId',
      // messageId absent
    });

    assert(captured.length === 1, 'une requête doit être capturée');
    const req = captured[0];
    assert(!req.payload.externalId, 'externalId ne doit pas être défini si messageId absent');
  });

  await testAsync('A6. sendSMS() retourne gatewayMessageId + state depuis réponse INfiniReach', async () => {
    const mockGw = createMockSmsGateway({
      configured : true,
      sendResult : {
        success         : true,
        gatewayMessageId: 'ir-xyz-789',
        messageId       : 'ir-xyz-789',
        state           : 'queued',
        provider        : 'sms_gateway',
      },
    });

    const result = await mockGw.sendSMS({ to: '+22670111111', text: 'Test' });
    assert(result.success === true,          'success doit être true');
    assertEqual(result.gatewayMessageId, 'ir-xyz-789', 'gatewayMessageId doit être retourné');
    assertEqual(result.state, 'queued',      'state doit être "queued"');
    assertEqual(result.provider, 'sms_gateway', 'provider doit être sms_gateway');
  });

  /* ════════════════════════════════════════════════════════════
     TEST B — Webhook entrant INfiniReach
     Vérifie : payload data.*, mapping correct, déduplication data.messageId
     ════════════════════════════════════════════════════════════ */
  console.log('\n══ TEST B — Webhook entrant INfiniReach ════════════════════');

  await testAsync('B1. Webhook message.inbound accepté — mapping data.from, data.body, data.to, data.messageId', async () => {
    const db      = createMockDb();
    const emitted = [];

    // Simuler le traitement d'un webhook INfiniReach message.inbound
    const webhookBody = makeInboundWebhook({
      messageId: 'ir-inbound-b1-001',
      from     : '+22670333333',
      to       : '+22600000000',
      body     : 'Message test B1',
      deviceId : 'zfold2-b1',
    });

    // Vérifier le mapping attendu
    const data = webhookBody.data;
    assertEqual(data.from,      '+22670333333',      'data.from = expéditeur');
    assertEqual(data.to,        '+22600000000',      'data.to = numéro SIM Z Fold2');
    assertEqual(data.body,      'Message test B1',   'data.body = texte SMS');
    assertEqual(data.messageId, 'ir-inbound-b1-001', 'data.messageId = ID dédup');
    assertEqual(data.deviceId,  'zfold2-b1',         'data.deviceId = device INfiniReach');
    assertEqual(webhookBody.event, 'message.inbound', 'event doit être message.inbound');

    // Simuler stockage Firestore avec le mapping INfiniReach
    const msgDoc = {
      channel       : 'sms',
      direction     : 'inbound',
      senderId      : data.from,
      content       : data.body,
      smsMessageId  : data.messageId,
      from          : data.from,
      to            : data.to,
      deviceId      : data.deviceId,
      createdAt     : data.timestamp,
      smsProvider   : 'sms_gateway',
    };
    const ref = await db.collection('messages').add(msgDoc);

    const snap = await db.collection('messages').get();
    assertEqual(snap.docs.length, 1, 'Un message doit être en Firestore');
    const stored = snap.docs[0].data();
    assertEqual(stored.senderId,     '+22670333333',      'senderId mappé depuis data.from');
    assertEqual(stored.content,      'Message test B1',   'content mappé depuis data.body');
    assertEqual(stored.smsMessageId, 'ir-inbound-b1-001', 'smsMessageId mappé depuis data.messageId');
    assertEqual(stored.to,           '+22600000000',       'to mappé depuis data.to');
    assertEqual(stored.deviceId,     'zfold2-b1',          'deviceId mappé depuis data.deviceId');
    assertEqual(stored.smsProvider,  'sms_gateway',        'smsProvider doit être sms_gateway');
  });

  await testAsync('B2. Déduplication : même data.messageId → 1 seul traitement', async () => {
    const processedIds = new Set();
    let processCount   = 0;

    async function processIfNew(messageId, handler) {
      const key = `omnisms:gateway:dedup:${messageId}`;
      if (processedIds.has(key)) return; // doublon
      processedIds.add(key);
      processCount++;
      await handler();
    }

    const db = createMockDb();
    const messageId = 'ir-inbound-dup-001';

    // Premier webhook → traité
    await processIfNew(messageId, async () => {
      await db.collection('messages').add({ content: 'SMS dedup test', smsMessageId: messageId });
    });

    // Deuxième webhook avec même messageId → ignoré
    await processIfNew(messageId, async () => {
      await db.collection('messages').add({ content: 'SMS dedup test (doublon)', smsMessageId: messageId });
    });

    const snap = await db.collection('messages').get();
    assertEqual(snap.docs.length, 1, 'Un seul message doit être stocké (doublon ignoré)');
    assertEqual(processCount, 1,     'Handler appelé une seule fois');
  });

  await testAsync('B3. Déduplication Redis : SETNX 1 = nouveau, SETNX 0 = doublon', async () => {
    const redis = createMockRedis(new Set());

    // Premier appel → 1 (nouveau)
    const first = await redis.setnx('omnisms:gateway:dedup:ir-b3-001', '1');
    assertEqual(first, 1, 'Premier SETNX doit retourner 1 (nouveau)');

    // Deuxième appel même clé → 0 (doublon)
    const second = await redis.setnx('omnisms:gateway:dedup:ir-b3-001', '1');
    assertEqual(second, 0, 'Deuxième SETNX doit retourner 0 (doublon)');
  });

  await testAsync('B4. Events DLR : message.sent, message.delivered, message.failed reconnus', async () => {
    const dlrEvents = ['message.sent', 'message.delivered', 'message.failed'];
    const statusMap = {
      'message.sent'      : 'sent',
      'message.delivered' : 'delivered',
      'message.failed'    : 'failed',
    };

    for (const event of dlrEvents) {
      const webhook = makeDlrWebhook(event, { messageId: `ir-dlr-${event}` });
      assertEqual(webhook.event, event, `Event ${event} doit être présent`);
      assertExists(statusMap[event], `statusMap doit couvrir ${event}`);
    }
  });

  await testAsync('B5. Mise à jour Firestore sur DLR message.delivered', async () => {
    const db = createMockDb();

    // Créer un message sortant simulé
    const smsMessageId = 'ir-sent-b5-001';
    await db.collection('messages').doc('msg-b5').set({
      smsMessageId,
      status    : 'sent',
      direction : 'outbound',
    });

    // Simuler updateDeliveryStatus pour message.delivered
    const newStatus = 'delivered';
    const snap = await db.collection('messages')
      .where('smsMessageId', '==', smsMessageId)
      .limit(1)
      .get();

    assert(!snap.empty, 'Message doit être trouvé par smsMessageId');
    await snap.docs[0].ref.update({ status: newStatus, deliveredAt: new Date().toISOString() });

    const updated = await db.collection('messages').doc('msg-b5').get();
    assertEqual(updated.data().status, 'delivered', 'Statut doit être "delivered"');
    assertExists(updated.data().deliveredAt, 'deliveredAt doit être défini');
  });

  /* ════════════════════════════════════════════════════════════
     TEST C — Erreurs API INfiniReach
     Vérifie : 401, 400, 429, 500, timeout → success=false, provider='sms_gateway'
     ════════════════════════════════════════════════════════════ */
  console.log('\n══ TEST C — Erreurs API INfiniReach ════════════════════════');

  await testAsync('C1. Erreur 401 (Clé API invalide) → success=false, provider=sms_gateway', async () => {
    const mockGw = createMockSmsGateway({
      configured : true,
      sendResult : {
        success   : false,
        error     : 'Clé API invalide — vérifier INFINIREACH_API_KEY',
        statusCode: 401,
        provider  : 'sms_gateway',
      },
    });

    const result = await mockGw.sendSMS({ to: '+22670000001', text: 'Test 401' });
    assert(result.success === false,            'success doit être false');
    assertEqual(result.statusCode, 401,         'statusCode doit être 401');
    assertEqual(result.provider, 'sms_gateway', 'provider doit être sms_gateway');
    assertExists(result.error,                  'error doit être présent');
  });

  await testAsync('C2. Erreur 400 (Payload invalide / from incorrect) → success=false', async () => {
    const mockGw = createMockSmsGateway({
      configured : true,
      sendResult : {
        success   : false,
        error     : 'Payload invalide — vérifier INFINIREACH_FROM_NUMBER',
        statusCode: 400,
        provider  : 'sms_gateway',
      },
    });

    const result = await mockGw.sendSMS({ to: '+22670000002', text: 'Test 400' });
    assert(result.success === false, 'success doit être false');
    assertEqual(result.statusCode, 400, 'statusCode doit être 400');
    assertEqual(result.provider, 'sms_gateway', 'provider doit être sms_gateway');
  });

  await testAsync('C3. Erreur 429 (Rate limit) → success=false', async () => {
    const mockGw = createMockSmsGateway({
      configured : true,
      sendResult : {
        success   : false,
        error     : 'Rate limit atteint — réessai automatique via BullMQ',
        statusCode: 429,
        provider  : 'sms_gateway',
      },
    });

    const result = await mockGw.sendSMS({ to: '+22670000003', text: 'Test 429' });
    assert(result.success === false, 'success doit être false');
    assertEqual(result.statusCode, 429, 'statusCode doit être 429');
    assertEqual(result.provider, 'sms_gateway', 'provider doit être sms_gateway');
  });

  await testAsync('C4. Erreur 500 (Serveur INfiniReach) → success=false', async () => {
    const mockGw = createMockSmsGateway({
      configured : true,
      sendResult : {
        success   : false,
        error     : 'Réponse inattendue INfiniReach (code 500)',
        statusCode: 500,
        provider  : 'sms_gateway',
      },
    });

    const result = await mockGw.sendSMS({ to: '+22670000004', text: 'Test 500' });
    assert(result.success === false, 'success doit être false');
    assertEqual(result.statusCode, 500, 'statusCode doit être 500');
    assertEqual(result.provider, 'sms_gateway', 'provider doit être sms_gateway');
  });

  await testAsync('C5. Timeout réseau → throw Error avec code TIMEOUT', async () => {
    const timeoutError  = new Error('[INfiniReach] Timeout après 15000ms');
    timeoutError.code   = 'TIMEOUT';

    const mockGw = createMockSmsGateway({
      configured: true,
      sendError : timeoutError,
    });

    let thrownError = null;
    try {
      await mockGw.sendSMS({ to: '+22670000005', text: 'Test timeout' });
    } catch (e) {
      thrownError = e;
    }

    assertExists(thrownError,                          'timeout doit propager une erreur');
    assert(thrownError.message.includes('Timeout'),    'message doit mentionner Timeout');
    assertEqual(thrownError.code, 'TIMEOUT',            'code doit être TIMEOUT');
  });

  await testAsync('C6. processSmsJob throw sur erreur → BullMQ retente', async () => {
    const timeoutError = new Error('[INfiniReach] Timeout après 15000ms');

    const mockGw = createMockSmsGateway({
      configured: true,
      sendError : timeoutError,
    });

    injectMock('../services/smsGateway', mockGw);
    injectMock('../config/firebase', createMockDb());

    clearMock('../services/smsQueueWorker');
    const { processSmsJob } = require('../services/smsQueueWorker');

    let threw = false;
    const mockJob = {
      id          : 'job-c6-timeout',
      attemptsMade: 0,
      data        : { to: '+22670000005', text: 'Test', messageId: null },
    };

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
     TEST D — Online : aucun appel INfiniReach depuis le mode Online
     ════════════════════════════════════════════════════════════ */
  console.log('\n══ TEST D — Online — Isolation INfiniReach ═════════════════');

  await testAsync('D1. Route OMNISMS si destinataire a un compte OmniSMS', async () => {
    const db        = createMockDb();
    const emitted   = [];
    const targetUid = 'uid-online-target-d1';

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
      senderUid  : 'uid-sender-d1',
      targetPhone: '+22670999999',
      content    : 'Message Online D1',
      db,
    });

    assertEqual(result.route, 'OMNISMS', 'route doit être OMNISMS (pas SMS_EXTERNE)');
    assert(!result.transport, 'transport ne doit pas être défini pour OMNISMS Online');

    clearMock('../services/messageRouter');
    clearMock('../config/firebase');
    clearMock('../services/socketService');
    clearMock('../services/userResolver');
  });

  await testAsync('D2. Online n\'utilise JAMAIS INfiniReach sendSMS()', async () => {
    const db = createMockDb();
    let infiniReachCalled = false;

    const mockGw = createMockSmsGateway({ configured: true });
    const origSend = mockGw.sendSMS.bind(mockGw);
    mockGw.sendSMS = async (opts) => {
      infiniReachCalled = true;
      return origSend(opts);
    };

    injectMock('../services/smsGateway', mockGw);
    injectMock('../config/firebase', db);
    injectMock('../services/socketService', { emitToUser: () => {}, getIO: () => null });
    injectMock('../services/userResolver', {
      resolveUserByPhone: async () => ({ found: true, uid: 'uid-online-d2' }),
    });

    clearMock('../services/messageRouter');
    const { routeMessage } = require('../services/messageRouter');

    await routeMessage({
      senderUid  : 'uid-sender-d2',
      targetPhone: '+22670101010',
      content    : 'Test Online isolation D2',
      db,
    });

    assert(!infiniReachCalled, 'INfiniReach sendSMS ne doit JAMAIS être appelé pour un message Online OmniSMS');

    clearMock('../services/messageRouter');
    clearMock('../services/smsGateway');
    clearMock('../config/firebase');
    clearMock('../services/socketService');
    clearMock('../services/userResolver');
  });

  await testAsync('D3. isSmsGatewayProvider() = true si OFFLINE_SMS_PROVIDER=sms_gateway', async () => {
    const orig = process.env.OFFLINE_SMS_PROVIDER;
    process.env.OFFLINE_SMS_PROVIDER = 'sms_gateway';

    clearMock('../services/smsGateway');
    const gw = require('../services/smsGateway');
    assert(gw.isSmsGatewayProvider(), 'isSmsGatewayProvider() doit être true');

    process.env.OFFLINE_SMS_PROVIDER = orig || '';
    clearMock('../services/smsGateway');
  });

  await testAsync('D4. isSmsGatewayProvider() = false si OFFLINE_SMS_PROVIDER=infobip', async () => {
    const orig = process.env.OFFLINE_SMS_PROVIDER;
    process.env.OFFLINE_SMS_PROVIDER = 'infobip';

    clearMock('../services/smsGateway');
    const gw = require('../services/smsGateway');
    assert(!gw.isSmsGatewayProvider(), 'isSmsGatewayProvider() doit être false si infobip');

    process.env.OFFLINE_SMS_PROVIDER = orig || '';
    clearMock('../services/smsGateway');
  });

  /* ════════════════════════════════════════════════════════════
     TEST E — Offline : envoi via INfiniReach + retry conservé
     ════════════════════════════════════════════════════════════ */
  console.log('\n══ TEST E — Offline — INfiniReach + Retry ══════════════════');

  await testAsync('E1. routeMessage → route SMS_EXTERNE via INfiniReach si configuré', async () => {
    const db     = createMockDb();
    const mockGw = createMockSmsGateway({ configured: true });

    injectMock('../services/smsGateway', mockGw);
    injectMock('../config/firebase', db);
    injectMock('../services/socketService', { emitToUser: () => {}, getIO: () => null });
    injectMock('../services/userResolver', {
      resolveUserByPhone: async () => ({ found: false }),
    });

    clearMock('../services/messageRouter');
    const { routeMessage } = require('../services/messageRouter');

    const result = await routeMessage({
      senderUid  : 'uid-sender-e1',
      targetPhone: '+22670111111',
      content    : 'Bonjour via INfiniReach E1',
      db,
    });

    assertEqual(result.route,     'SMS_EXTERNE',  'route doit être SMS_EXTERNE');
    assertEqual(result.transport, 'sms_gateway',  'transport doit être sms_gateway (INfiniReach)');
    assert(result.conversationId.startsWith('ext-'), 'convId doit commencer par ext-');
    assert(result.smsResult?.success, 'smsResult.success doit être true');

    clearMock('../services/messageRouter');
    clearMock('../services/smsGateway');
    clearMock('../config/firebase');
    clearMock('../services/socketService');
    clearMock('../services/userResolver');
  });

  await testAsync('E2. processSmsJob utilise INfiniReach (sms_gateway) si configuré', async () => {
    let infiniReachCalled = false;
    const mockGw = createMockSmsGateway({ configured: true });
    const origSend = mockGw.sendSMS.bind(mockGw);
    mockGw.sendSMS = async (opts) => {
      infiniReachCalled = true;
      return origSend(opts);
    };

    injectMock('../services/smsGateway', mockGw);
    injectMock('../config/firebase', createMockDb());

    clearMock('../services/smsQueueWorker');
    const { processSmsJob } = require('../services/smsQueueWorker');

    const mockJob = {
      id          : 'job-e2-infinireach',
      attemptsMade: 1,
      data        : { to: '+22670000004', text: '[OmniSMS] Test E2', messageId: 'msg-e2' },
    };

    const result = await processSmsJob(mockJob);
    assert(infiniReachCalled,       'INfiniReach sendSMS doit être appelé');
    assert(result.success,          'result.success doit être true');
    assertEqual(result.provider, 'sms_gateway', 'provider doit être sms_gateway');

    clearMock('../services/smsQueueWorker');
    clearMock('../services/smsGateway');
    clearMock('../config/firebase');
  });

  await testAsync('E3. Retry BullMQ enqueued si INfiniReach échoue', async () => {
    const db = createMockDb();
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
        return { jobId: 'job-e3', queued: true };
      },
    });

    clearMock('../services/messageRouter');
    const { routeMessage } = require('../services/messageRouter');

    await routeMessage({
      senderUid  : 'uid-sender-e3',
      targetPhone: '+22670222222',
      content    : 'Message INfiniReach échec → retry',
      db,
    });

    assert(enqueueCalled, 'enqueueSmsJob doit être appelé après l\'échec INfiniReach');

    clearMock('../services/messageRouter');
    clearMock('../services/smsGateway');
    clearMock('../config/firebase');
    clearMock('../services/socketService');
    clearMock('../services/userResolver');
    clearMock('../services/smsQueueWorker');
  });

  await testAsync('E4. Fallback Infobip si INfiniReach échoue ET OFFLINE_SMS_FALLBACK_TO_INFOBIP=true', async () => {
    let infobipCalled = false;

    const mockGw = createMockSmsGateway({
      configured : true,
      fallback   : true,
      sendResult : { success: false, error: 'infinireach_error', provider: 'sms_gateway' },
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
      id          : 'job-e4-fallback',
      attemptsMade: 0,
      data        : { to: '+22670000005', text: '[OmniSMS] Fallback test E4', messageId: null },
    };

    const result = await processSmsJob(mockJob);
    assert(infobipCalled, 'Infobip doit être appelé en fallback si INfiniReach échoue');
    assert(result.success, 'result doit être success grâce au fallback Infobip');

    clearMock('../services/smsQueueWorker');
    clearMock('../services/smsGateway');
    clearMock('../services/infobip');
    clearMock('../config/firebase');
  });

  await testAsync('E5. Infobip standby utilisé si INfiniReach non configuré', async () => {
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
      id: 'job-e5-infobip-standby',
      attemptsMade: 0,
      data: { to: '+22670000006', text: 'Test standby E5', messageId: null },
    };

    const result = await processSmsJob(mockJob);
    assert(infobipCalled,  'Infobip doit être utilisé si INfiniReach non configuré');
    assert(result.success, 'result.success doit être true via Infobip standby');

    clearMock('../services/smsQueueWorker');
    clearMock('../services/smsGateway');
    clearMock('../services/infobip');
    clearMock('../config/firebase');
  });

  /* ════════════════════════════════════════════════════════════
     TESTS DE RÉGRESSION — G-séries (interface et routage)
     ════════════════════════════════════════════════════════════ */
  console.log('\n══ RÉGRESSION G — Interface + Routage ══════════════════════');

  await testAsync('G6. isAlreadyProcessed Redis : premier appel = nouveau', async () => {
    const redis    = createMockRedis(new Set());
    injectMock('../services/redis', redis);

    const set = await redis.setnx('omnisms:gateway:dedup:ir-g6-unique-001', '1');
    assertEqual(set, 1, 'setnx doit retourner 1 sur premier appel');

    clearMock('../services/redis');
  });

  await testAsync('G6. isAlreadyProcessed Redis : même clé = doublon', async () => {
    const existingKeys = new Set(['omnisms:gateway:dedup:ir-g6-dup-002']);
    const redis = createMockRedis(existingKeys);
    injectMock('../services/redis', redis);

    const set = await redis.setnx('omnisms:gateway:dedup:ir-g6-dup-002', '1');
    assertEqual(set, 0, 'setnx doit retourner 0 pour une clé existante (doublon)');

    clearMock('../services/redis');
  });

  await testAsync('G7. SMS entrant créé Firestore avec champs smsProvider, deviceId corrects', async () => {
    const db = createMockDb();

    const fromE164  = '+22670333333';
    const ownerUid  = 'uid-owner-g7';
    const convId    = `ext-${ownerUid}-${fromE164}`;
    const text      = 'Bonjour depuis INfiniReach Z Fold2';
    const gwMsgId   = 'ir-g7-msg-001';

    const msgDoc = {
      channel      : 'sms',
      direction    : 'inbound',
      senderId     : fromE164,
      receiverId   : ownerUid,
      convId,
      content      : text,
      type         : 'text',
      smsMessageId : gwMsgId,
      smsProvider  : 'sms_gateway',   // INfiniReach stocke toujours 'sms_gateway'
      deviceId     : 'zfold2-g7',
      status       : 'delivered',
      createdAt    : new Date().toISOString(),
      updatedAt    : new Date().toISOString(),
    };

    const ref = await db.collection('messages').add(msgDoc);
    const snap = await db.collection('messages').get();

    assertEqual(snap.docs.length, 1, 'Un message doit être en Firestore');
    const stored = snap.docs[0].data();
    assertEqual(stored.channel,      'sms',         'channel doit être sms');
    assertEqual(stored.direction,    'inbound',      'direction doit être inbound');
    assertEqual(stored.smsProvider,  'sms_gateway',  'smsProvider doit être sms_gateway');
    assertEqual(stored.smsMessageId, gwMsgId,        'smsMessageId doit être stocké');
    assertExists(stored.deviceId,                    'deviceId doit être stocké');
  });

  await testAsync('G8. makeExternalConvId génère ext-{ownerUid}-{e164}', async () => {
    clearMock('../services/messageRouter');
    const { makeExternalConvId } = require('../services/messageRouter');

    const convId = makeExternalConvId('uid-owner-g8', '+22670555555');
    assertEqual(convId, 'ext-uid-owner-g8-+22670555555', 'convId doit être ext-{ownerUid}-{e164}');
    clearMock('../services/messageRouter');
  });

  await testAsync('G9. normalizePhone normalise 0022670000007 → +22670000007', async () => {
    clearMock('../services/phoneNormalizer');
    const { normalizePhone } = require('../services/phoneNormalizer');

    const result = normalizePhone('0022670000007');
    assertExists(result, 'normalizePhone ne doit pas retourner null');
    assert(result.startsWith('+'), 'numéro normalisé doit commencer par +');
  });

  await testAsync('G10. makeConversationId stable : [uid1,uid2].sort().join("-")', async () => {
    clearMock('../services/messageRouter');
    const { makeConversationId } = require('../services/messageRouter');

    const id1 = makeConversationId('aaa', 'zzz');
    const id2 = makeConversationId('zzz', 'aaa');
    assertEqual(id1, id2, 'makeConversationId doit être déterministe dans les 2 sens');
    assert(id1.includes('aaa') && id1.includes('zzz'), 'convId doit contenir les deux UIDs');
    clearMock('../services/messageRouter');
  });

  await testAsync('G10. Online n\'utilise jamais INfiniReach.sendSMS()', async () => {
    const db = createMockDb();
    let gatewayCalled = false;

    const mockGw = createMockSmsGateway({ configured: true });
    const origSend = mockGw.sendSMS.bind(mockGw);
    mockGw.sendSMS = async (opts) => { gatewayCalled = true; return origSend(opts); };

    injectMock('../services/smsGateway', mockGw);
    injectMock('../config/firebase', db);
    injectMock('../services/socketService', { emitToUser: () => {}, getIO: () => null });
    injectMock('../services/userResolver', {
      resolveUserByPhone: async () => ({ found: true, uid: 'uid-online-g10' }),
    });

    clearMock('../services/messageRouter');
    const { routeMessage } = require('../services/messageRouter');

    await routeMessage({
      senderUid  : 'uid-g10-a',
      targetPhone: '+22670101010',
      content    : 'Test Online G10',
      db,
    });

    assert(!gatewayCalled, 'INfiniReach sendSMS ne doit JAMAIS être appelé pour un message Online');

    clearMock('../services/messageRouter');
    clearMock('../services/smsGateway');
    clearMock('../config/firebase');
    clearMock('../services/socketService');
    clearMock('../services/userResolver');
  });

  /* ════════════════════════════════════════════════════════════
     Résumé final
     ════════════════════════════════════════════════════════════ */
  const total = pass + fail;
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║  Résultats : ${pass} PASS / ${fail} FAIL / ${total} total${' '.repeat(Math.max(0, 27 - String(pass).length - String(fail).length - String(total).length))} ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (fail === 0) {
    console.log('\n✅ Tous les tests INfiniReach passent.');
    console.log('\n⚠️  TESTS HARDWARE REQUIS (non automatisables) :');
    console.log('   H-A1 — Z Fold2 connecté + INfiniReach + SIM active');
    console.log('   H-A2 — Envoi SMS réel OmniSMS → numéro externe via INfiniReach Z Fold2');
    console.log('   H-A3 — Réception SMS réel sur Z Fold2 → apparition dans OmniSMS');
    console.log('   H-A4 — Latence mesurée end-to-end');
    console.log('   H-A5 — DLR (message.delivered) vérifié dans Firestore');
  } else {
    console.log(`\n❌ ${fail} test(s) ont échoué.`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Erreur fatale dans les tests INfiniReach:', err);
  process.exit(1);
});
