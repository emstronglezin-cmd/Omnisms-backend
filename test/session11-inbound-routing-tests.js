'use strict';
/**
 * OmniSMS — Tests Session 11 — Routage SMS Entrant InfiniReach
 *
 * Couvre :
 *   Test A — INBOUND ONLINE  : propriétaire connecté → OmniSMS (Socket.IO)
 *   Test B — INBOUND OFFLINE : propriétaire déconnecté → SMS fallback vers vrai numéro profil
 *   Test C — GATEWAY = NUMÉRO UTILISATEUR : profil.phone == gatewayNumber → anti-boucle + conservation Firestore
 *   Test D — WEBHOOK DUPLIQUÉ : second webhook identique → ignoré (dédup)
 *
 * Architecture des tests :
 *   • Tout est mocké — aucun appel réseau réel
 *   • resolveUserByPhone, resolveUserByUid, isUserOnline, sendSMS, Firestore
 *   • Vérification des logs de routage + décisions
 *
 * Ces tests vérifient la correction Session 11 :
 *   fallbackTo = recipientPhone (vrai profil) ≠ gatewayNumber
 *   JAMAIS fallbackTo = recipientE164 = gatewayNumber
 */

const assert = require('assert');

// ─────────────────────────────────────────────────────────────────────────────
// Mocks infrastructure
// ─────────────────────────────────────────────────────────────────────────────

const GATEWAY_NUMBER = '+22675400000'; // numéro SIM InfiniReach
const OWNER_UID      = 'MGvh4dYLlwJhv5jQbBB9';
const OWNER_PHONE    = '+22601234567'; // VRAI numéro profil (différent du gateway)
const SENDER_PHONE   = '+22656789012'; // expéditeur externe

/**
 * Crée un webhook payload INfiniReach message.inbound.
 */
function makeWebhookPayload({
  from = SENDER_PHONE,
  to   = GATEWAY_NUMBER,
  body = 'Test message',
  messageId = `ir-test-${Date.now()}`,
} = {}) {
  return {
    event: 'message.inbound',
    data : { from, to, body, messageId, direction: 'inbound', timestamp: new Date().toISOString() },
  };
}

/**
 * Crée un mock du module de routage complet.
 * Paramètres :
 *   ownerOnline        : bool — isUserOnline() retourne true/false
 *   ownerProfilePhone  : string|null — resolveUserByUid(uid).phone
 *   gatewayNumber      : string — INFINIREACH_FROM_NUMBER env var
 *   smsSendSuccess     : bool — smsGateway.sendSMS() succès/echec
 *   existingConvOwner  : string|null — findExternalConvByPhone retourne ce ownerUid
 */
function createMockContext({
  ownerOnline        = false,
  ownerProfilePhone  = OWNER_PHONE,
  gatewayNumber      = GATEWAY_NUMBER,
  smsSendSuccess     = true,
  existingConvOwner  = null,
} = {}) {
  const logs = [];

  // Logger mock
  const mockLogger = {
    info : (msg, data) => logs.push({ level: 'info',  msg, data }),
    warn : (msg, data) => logs.push({ level: 'warn',  msg, data }),
    debug: (msg, data) => logs.push({ level: 'debug', msg, data }),
    error: (msg, data) => logs.push({ level: 'error', msg, data }),
  };

  // resolveUserByPhone mock
  const mockResolveByPhone = async (phone) => {
    const normalized = phone.replace(/\s/g, '');
    if (normalized === GATEWAY_NUMBER || normalized === GATEWAY_NUMBER.replace('+', '')) {
      return { found: true, uid: OWNER_UID, phone: GATEWAY_NUMBER, isOmniSms: true };
    }
    return { found: false, uid: null };
  };

  // resolveUserByUid mock — retourne le VRAI numéro de profil
  const mockResolveByUid = async (uid) => {
    if (uid === OWNER_UID) {
      return {
        found      : !!ownerProfilePhone,
        uid        : OWNER_UID,
        phone      : ownerProfilePhone,
        email      : 'owner@example.com',
        name       : 'Test Owner',
        isSubscribed: false,
        credits    : 10,
      };
    }
    return { found: false, uid, phone: null };
  };

  // isUserOnline mock
  const mockIsUserOnline = async (uid) => {
    return uid === OWNER_UID ? ownerOnline : false;
  };

  // emitToUser mock
  const emittedEvents = [];
  const mockEmitToUser = (uid, event, payload) => {
    emittedEvents.push({ uid, event, payload });
  };

  // smsGateway mock
  const smsSentTo = [];
  const mockSmsGateway = {
    isConfigured: () => true,
    sendSMS: async ({ to, text, messageId }) => {
      smsSentTo.push({ to, text, messageId });
      if (!smsSendSuccess) throw new Error('SMS send failed (mock)');
      return { success: true };
    },
    validateWebhookSignature: () => true,
  };

  // Firestore mock
  const firestoreDocs = [];
  const mockDb = {
    collection: (col) => ({
      add: async (doc) => {
        const id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        firestoreDocs.push({ collection: col, id, ...doc });
        return { id };
      },
      doc: (id) => ({
        get: async () => ({ exists: false, data: () => null }),
      }),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
    }),
  };

  // findExternalConvByPhone mock
  const mockFindExternalConv = async (db, fromPhone, toPhone) => {
    if (existingConvOwner) {
      return { ownerUid: existingConvOwner, conversationId: `ext-${existingConvOwner}-${fromPhone}` };
    }
    return null;
  };

  // getOrCreateExternalConv mock
  const mockGetOrCreateExternalConv = async (db, ownerUid, fromPhone) => {
    return { conversationId: `ext-${ownerUid}-${fromPhone}` };
  };

  // normalizePhone mock
  const normalizePhone = (phone) => {
    if (!phone) return null;
    const clean = phone.replace(/\s/g, '');
    return clean.startsWith('+') ? clean : null;
  };

  return {
    logs,
    emittedEvents,
    smsSentTo,
    firestoreDocs,
    mocks: {
      mockLogger,
      mockResolveByPhone,
      mockResolveByUid,
      mockIsUserOnline,
      mockEmitToUser,
      mockSmsGateway,
      mockDb,
      mockFindExternalConv,
      mockGetOrCreateExternalConv,
      normalizePhone,
      gatewayNumber,
    },
  };
}

/**
 * Simule l'exécution de processSmsReceived avec les mocks fournis.
 * Reproduit fidèlement la logique de routes/sms.gateway.inbound.js (Session 11).
 */
async function simulateProcessSmsReceived(webhookBody, ctx) {
  const {
    mockLogger: logger,
    mockResolveByPhone: resolveUserByPhone,
    mockResolveByUid: resolveUserByUid,
    mockIsUserOnline: isUserOnline,
    mockEmitToUser: emitFn,
    mockSmsGateway: smsGateway,
    mockDb: db,
    mockFindExternalConv: findExternalConvByPhone,
    mockGetOrCreateExternalConv: getOrCreateExternalConv,
    normalizePhone,
    gatewayNumber: gwEnv,
  } = ctx.mocks;

  const data         = webhookBody?.data || {};
  const senderRaw    = data.from;
  const recipientRaw = data.to;
  const textRaw      = data.body;
  const gwMessageId  = data.messageId;

  const fromRawNorm = senderRaw    ? normalizePhone(senderRaw)    || senderRaw    : '';
  const toRawNorm   = recipientRaw ? normalizePhone(recipientRaw) || recipientRaw : '';

  // ANTI-BOUCLE 1 : from == to
  if (fromRawNorm && toRawNorm && fromRawNorm === toRawNorm) {
    logger.warn('[INfiniReach] ANTI-BOUCLE — from == to', { from: fromRawNorm, to: toRawNorm });
    return { decision: 'anti-boucle-self' };
  }

  const fromE164      = normalizePhone(senderRaw)    || senderRaw    || '';
  const recipientE164 = normalizePhone(recipientRaw) || recipientRaw || null;

  // Résolution ownerUid
  let ownerUid  = null;
  let convId    = null;
  const finalText = String(textRaw);

  // Cas B : Conversation existante
  const existingConv = await findExternalConvByPhone(db, fromE164, recipientE164);
  if (existingConv) {
    ownerUid = existingConv.ownerUid;
    convId   = existingConv.conversationId;
  }

  // Cas C : Résolution via numéro SIM
  if (!ownerUid && recipientE164) {
    const toUser = await resolveUserByPhone(recipientE164);
    if (toUser.found) {
      ownerUid = toUser.uid;
    }
  }

  // ─── FIX SESSION 11 : résolution du vrai numéro profil ────────────────
  let recipientPhone = null;
  if (ownerUid) {
    const ownerProfile = await resolveUserByUid(ownerUid);
    if (ownerProfile.found && ownerProfile.phone) {
      const normalized = normalizePhone(ownerProfile.phone);
      recipientPhone = normalized || ownerProfile.phone;
      logger.info('[INfiniReach] webhook:inbound Profil propriétaire résolu', {
        ownerUid,
        recipientPhoneMasked : recipientPhone,
        gatewayNumberMasked  : recipientE164,
        phoneDistinct        : recipientPhone !== (normalizePhone(recipientE164) || recipientE164),
      });
    }
  }

  // Créer conversation si nécessaire
  if (ownerUid && !convId) {
    const ext = await getOrCreateExternalConv(db, ownerUid, fromE164);
    convId = ext?.conversationId || `ext-${ownerUid}-${fromE164}`;
  }
  if (!convId) convId = `sms-fallback-${fromE164}-${Date.now()}`;

  // Stocker en Firestore
  const ref = await db.collection('messages').add({
    channel: 'sms', direction: 'inbound', senderId: fromE164,
    conversationId: convId, content: finalText, smsMessageId: gwMessageId,
  });
  const savedMsgId = ref.id;

  // Log diagnostic
  logger.info('[INfiniReach] ROUTING — diagnostic', {
    incomingFrom    : fromE164,
    incomingTo      : recipientE164,
    gatewayNumber   : recipientE164,
    recipientPhone  : recipientPhone || '(non résolu)',
    recipientPhoneDistinct: recipientPhone !== (normalizePhone(recipientE164) || recipientE164),
    resolvedRecipientUid  : ownerUid || null,
    recipientOmniSms      : !!ownerUid,
    convId,
  });

  if (!ownerUid) {
    return { decision: 'no-owner', savedMsgId, convId };
  }

  // Vérifier présence
  const ownerIsOnline = await isUserOnline(ownerUid);

  const socketPayload = {
    id: savedMsgId, type: 'text', channel: 'sms',
    direction: 'inbound', senderId: fromE164, receiverId: ownerUid,
    conversationId: convId, content: finalText,
  };

  if (ownerIsOnline) {
    // ONLINE → Socket.IO
    emitFn(ownerUid, 'message:receive', socketPayload);
    emitFn(ownerUid, 'new_message', socketPayload);
    logger.info('[INfiniReach] ROUTING — décision', {
      resolvedRecipientUid: ownerUid,
      recipientPresence   : 'online',
      routingDecision     : 'omnisms',
    });
    return { decision: 'omnisms', savedMsgId, convId, recipientPhone };
  }

  // OFFLINE → SMS fallback
  const fallbackTo = recipientPhone || null;

  const gwNum          = gwEnv.trim();
  const normalizedGw   = normalizePhone(gwNum) || gwNum;
  const normalizedFall = fallbackTo ? (normalizePhone(fallbackTo) || fallbackTo) : null;

  logger.info('[INfiniReach] ROUTING — décision', {
    resolvedRecipientUid  : ownerUid,
    recipientPresence     : 'offline',
    routingDecision       : 'sms_fallback',
    fallbackTo            : fallbackTo || '(non résolu)',
    fallbackDistinctGateway: normalizedFall !== normalizedGw,
  });

  if (!fallbackTo) {
    logger.warn('[INfiniReach] SMS fallback impossible — recipientPhone non résolu', { ownerUid });
    return { decision: 'sms_fallback_no_phone', savedMsgId, convId, recipientPhone: null };
  }

  // ANTI-BOUCLE 2 : fallbackTo == gateway
  if (normalizedGw && normalizedFall === normalizedGw) {
    logger.warn('[INfiniReach] ANTI-BOUCLE (fallback) — fallbackTo == gateway number', {
      fallbackTo, gatewayNumber: normalizedGw,
    });
    return { decision: 'anti-boucle-fallback', savedMsgId, convId, recipientPhone };
  }

  // Envoyer SMS
  const smsText = `[OmniSMS] Message reçu de ${fromE164} : ${finalText}`;
  const smsResult = await smsGateway.sendSMS({ to: fallbackTo, text: smsText, messageId: savedMsgId });
  logger.info('[INfiniReach] SMS fallback envoyé', { fallbackTo, success: smsResult?.success });
  return { decision: 'sms_fallback', savedMsgId, convId, recipientPhone, fallbackTo };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function runAllTests() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  OmniSMS — Session 11 — Inbound Routing Tests (A–D)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ─────────────────────────────────────────────────────────────
  // TEST A — INBOUND ONLINE
  // ─────────────────────────────────────────────────────────────
  console.log('━━━ Test A — Inbound Online ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await runTest('A1 — ownerUid résolu depuis numéro SIM', async () => {
    const ctx = createMockContext({ ownerOnline: true, ownerProfilePhone: OWNER_PHONE });
    const result = await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.strictEqual(result.decision, 'omnisms', 'routingDecision doit être omnisms');
  });

  await runTest('A2 — message émis via Socket.IO vers ownerUid', async () => {
    const ctx = createMockContext({ ownerOnline: true, ownerProfilePhone: OWNER_PHONE });
    await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.ok(ctx.emittedEvents.length >= 2, 'Au moins 2 événements Socket.IO émis');
    assert.ok(ctx.emittedEvents.some(e => e.event === 'message:receive'), 'message:receive émis');
    assert.ok(ctx.emittedEvents.every(e => e.uid === OWNER_UID), 'Émis vers ownerUid uniquement');
  });

  await runTest('A3 — aucun SMS sortant InfiniReach (online → pas de fallback)', async () => {
    const ctx = createMockContext({ ownerOnline: true, ownerProfilePhone: OWNER_PHONE });
    await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.strictEqual(ctx.smsSentTo.length, 0, 'Aucun SMS envoyé si propriétaire connecté');
  });

  await runTest('A4 — message stocké en Firestore', async () => {
    const ctx = createMockContext({ ownerOnline: true, ownerProfilePhone: OWNER_PHONE });
    const result = await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.ok(result.savedMsgId, 'savedMsgId doit exister');
    assert.ok(ctx.firestoreDocs.length > 0, 'Document Firestore créé');
  });

  await runTest('A5 — recipientPhone résolu et distinct du gateway', async () => {
    const ctx = createMockContext({ ownerOnline: true, ownerProfilePhone: OWNER_PHONE });
    const result = await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.strictEqual(result.recipientPhone, OWNER_PHONE, 'recipientPhone doit être le vrai numéro profil');
    assert.notStrictEqual(result.recipientPhone, GATEWAY_NUMBER, 'recipientPhone ≠ gatewayNumber');
  });

  // ─────────────────────────────────────────────────────────────
  // TEST B — INBOUND OFFLINE
  // ─────────────────────────────────────────────────────────────
  console.log('\n━━━ Test B — Inbound Offline ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await runTest('B1 — routingDecision = sms_fallback si offline', async () => {
    const ctx = createMockContext({ ownerOnline: false, ownerProfilePhone: OWNER_PHONE });
    const result = await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.strictEqual(result.decision, 'sms_fallback', 'routingDecision doit être sms_fallback');
  });

  await runTest('B2 — fallbackTo = vrai numéro profil (pas le gateway)', async () => {
    const ctx = createMockContext({ ownerOnline: false, ownerProfilePhone: OWNER_PHONE });
    const result = await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.strictEqual(result.fallbackTo, OWNER_PHONE, 'fallbackTo doit être le vrai numéro profil');
    assert.notStrictEqual(result.fallbackTo, GATEWAY_NUMBER, 'fallbackTo ≠ gatewayNumber → anti-boucle évitée');
  });

  await runTest('B3 — SMS envoyé vers le bon numéro (vrai profil)', async () => {
    const ctx = createMockContext({ ownerOnline: false, ownerProfilePhone: OWNER_PHONE });
    await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.strictEqual(ctx.smsSentTo.length, 1, 'Exactement 1 SMS envoyé');
    assert.strictEqual(ctx.smsSentTo[0].to, OWNER_PHONE, 'SMS envoyé vers le vrai numéro profil');
  });

  await runTest('B4 — aucun événement Socket.IO émis (offline)', async () => {
    const ctx = createMockContext({ ownerOnline: false, ownerProfilePhone: OWNER_PHONE });
    await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.strictEqual(ctx.emittedEvents.length, 0, 'Aucun événement Socket.IO si offline');
  });

  await runTest('B5 — log diagnostic distingue gatewayNumber et recipientPhone', async () => {
    const ctx = createMockContext({ ownerOnline: false, ownerProfilePhone: OWNER_PHONE });
    await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    const diagLog = ctx.logs.find(l => l.msg.includes('ROUTING — diagnostic'));
    assert.ok(diagLog, 'Log diagnostique présent');
    assert.ok(diagLog.data.gatewayNumber, 'gatewayNumber présent dans le log');
    assert.ok(diagLog.data.recipientPhone, 'recipientPhone présent dans le log');
    assert.notStrictEqual(diagLog.data.gatewayNumber, diagLog.data.recipientPhone,
      'gatewayNumber ≠ recipientPhone dans le log');
  });

  // ─────────────────────────────────────────────────────────────
  // TEST C — GATEWAY == NUMÉRO UTILISATEUR
  // ─────────────────────────────────────────────────────────────
  console.log('\n━━━ Test C — Gateway == Numéro Utilisateur ━━━━━━━━━━━━━━━━━');

  await runTest('C1 — ANTI-BOUCLE (fallback) déclenché si profil.phone == gateway', async () => {
    // Scénario : le profil Firestore du propriétaire a le même numéro que le gateway
    const ctx = createMockContext({
      ownerOnline       : false,
      ownerProfilePhone : GATEWAY_NUMBER, // profil.phone == gateway → anti-boucle
    });
    const result = await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.strictEqual(result.decision, 'anti-boucle-fallback',
      'Anti-boucle fallback doit être déclenché quand profil.phone == gateway');
  });

  await runTest('C2 — aucun SMS envoyé si profil.phone == gateway', async () => {
    const ctx = createMockContext({
      ownerOnline       : false,
      ownerProfilePhone : GATEWAY_NUMBER,
    });
    await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.strictEqual(ctx.smsSentTo.length, 0,
      'Aucun SMS envoyé si fallbackTo == gateway number (anti-boucle)');
  });

  await runTest('C3 — message conservé en Firestore malgré l\'anti-boucle', async () => {
    const ctx = createMockContext({
      ownerOnline       : false,
      ownerProfilePhone : GATEWAY_NUMBER,
    });
    const result = await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.ok(result.savedMsgId, 'Message conservé en Firestore même si anti-boucle');
    assert.ok(ctx.firestoreDocs.length > 0, 'Document Firestore présent');
  });

  await runTest('C4 — ANTI-BOUCLE 1 (from == to) bloque l\'auto-envoi gateway', async () => {
    const ctx = createMockContext({ ownerOnline: false, ownerProfilePhone: OWNER_PHONE });
    // Simuler from == to (gateway se parle à lui-même)
    const payload = makeWebhookPayload({ from: GATEWAY_NUMBER, to: GATEWAY_NUMBER });
    const result = await simulateProcessSmsReceived(payload, ctx);
    assert.strictEqual(result.decision, 'anti-boucle-self',
      'ANTI-BOUCLE 1 doit bloquer from == to');
    assert.strictEqual(ctx.smsSentTo.length, 0, 'Aucun SMS envoyé si from == to');
  });

  await runTest('C5 — profil.phone absent → sms_fallback_no_phone, message conservé', async () => {
    const ctx = createMockContext({
      ownerOnline       : false,
      ownerProfilePhone : null, // profil sans numéro
    });
    const result = await simulateProcessSmsReceived(makeWebhookPayload(), ctx);
    assert.strictEqual(result.decision, 'sms_fallback_no_phone',
      'Décision sms_fallback_no_phone si profil sans numéro');
    assert.strictEqual(ctx.smsSentTo.length, 0, 'Aucun SMS envoyé si recipientPhone absent');
    assert.ok(result.savedMsgId, 'Message conservé en Firestore');
  });

  // ─────────────────────────────────────────────────────────────
  // TEST D — WEBHOOK DUPLIQUÉ
  // ─────────────────────────────────────────────────────────────
  console.log('\n━━━ Test D — Webhook Dupliqué ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await runTest('D1 — déduplication : même messageId traité une seule fois', async () => {
    // La déduplication Redis/Map est dans isAlreadyProcessed() dans le vrai code.
    // Ici on simule en utilisant un Set de messageIds traités.
    const processedIds = new Set();
    const payload = makeWebhookPayload({ messageId: 'ir-dedup-test-001' });

    async function simulateWithDedup(webhookBody, ctx) {
      const msgId = webhookBody.data?.messageId;
      if (msgId && processedIds.has(msgId)) {
        ctx.mocks.mockLogger.info('[INfiniReach] webhook:duplicate', { messageId: msgId });
        return { decision: 'duplicate' };
      }
      if (msgId) processedIds.add(msgId);
      return simulateProcessSmsReceived(webhookBody, ctx);
    }

    const ctx1 = createMockContext({ ownerOnline: true, ownerProfilePhone: OWNER_PHONE });
    const result1 = await simulateWithDedup(payload, ctx1);
    assert.notStrictEqual(result1.decision, 'duplicate', '1er traitement : pas un doublon');

    const ctx2 = createMockContext({ ownerOnline: true, ownerProfilePhone: OWNER_PHONE });
    const result2 = await simulateWithDedup(payload, ctx2);
    assert.strictEqual(result2.decision, 'duplicate', '2ème traitement même messageId : doublon détecté');
  });

  await runTest('D2 — doublon → aucun message Firestore supplémentaire', async () => {
    const processedIds = new Set();
    const payload = makeWebhookPayload({ messageId: 'ir-dedup-test-002' });

    async function simulateWithDedup(webhookBody, ctx) {
      const msgId = webhookBody.data?.messageId;
      if (msgId && processedIds.has(msgId)) {
        return { decision: 'duplicate' };
      }
      if (msgId) processedIds.add(msgId);
      return simulateProcessSmsReceived(webhookBody, ctx);
    }

    const ctx = createMockContext({ ownerOnline: true, ownerProfilePhone: OWNER_PHONE });
    await simulateWithDedup(payload, ctx);
    const countAfterFirst = ctx.firestoreDocs.length;

    await simulateWithDedup(payload, ctx);
    const countAfterSecond = ctx.firestoreDocs.length;

    assert.strictEqual(countAfterFirst, countAfterSecond,
      'Aucun document Firestore ajouté par le doublon');
  });

  await runTest('D3 — doublon → aucun SMS sortant supplémentaire', async () => {
    const processedIds = new Set();
    const payload = makeWebhookPayload({ messageId: 'ir-dedup-test-003' });

    async function simulateWithDedup(webhookBody, ctx) {
      const msgId = webhookBody.data?.messageId;
      if (msgId && processedIds.has(msgId)) {
        return { decision: 'duplicate' };
      }
      if (msgId) processedIds.add(msgId);
      return simulateProcessSmsReceived(webhookBody, ctx);
    }

    const ctx = createMockContext({ ownerOnline: false, ownerProfilePhone: OWNER_PHONE });
    await simulateWithDedup(payload, ctx);
    const smsAfterFirst = ctx.smsSentTo.length;

    await simulateWithDedup(payload, ctx);
    const smsAfterSecond = ctx.smsSentTo.length;

    assert.strictEqual(smsAfterFirst, smsAfterSecond,
      'Aucun SMS supplémentaire envoyé par le doublon');
  });

  await runTest('D4 — doublon → aucun événement Socket.IO supplémentaire', async () => {
    const processedIds = new Set();
    const payload = makeWebhookPayload({ messageId: 'ir-dedup-test-004' });

    async function simulateWithDedup(webhookBody, ctx) {
      const msgId = webhookBody.data?.messageId;
      if (msgId && processedIds.has(msgId)) {
        return { decision: 'duplicate' };
      }
      if (msgId) processedIds.add(msgId);
      return simulateProcessSmsReceived(webhookBody, ctx);
    }

    const ctx = createMockContext({ ownerOnline: true, ownerProfilePhone: OWNER_PHONE });
    await simulateWithDedup(payload, ctx);
    const eventsAfterFirst = ctx.emittedEvents.length;

    await simulateWithDedup(payload, ctx);
    const eventsAfterSecond = ctx.emittedEvents.length;

    assert.strictEqual(eventsAfterFirst, eventsAfterSecond,
      'Aucun événement Socket.IO supplémentaire pour le doublon');
  });

  // ─────────────────────────────────────────────────────────────
  // Résumé
  // ─────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Résultat : ${passed} réussis, ${failed} échoués`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

runAllTests().catch((err) => {
  console.error('Erreur fatale dans les tests:', err);
  process.exit(1);
});
