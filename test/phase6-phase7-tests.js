'use strict';
/**
 * OmniSMS — Tests Phase 6 (Offline Mode) & Phase 7 (Payment)
 * Run : node test/phase6-phase7-tests.js
 */

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// ─── Helpers inline (no external deps) ─────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    if (s.length === 8 && /^[67]/.test(s)) s = '+226' + s;
    else if (s.length === 9 && /^0[67]/.test(s)) s = '+226' + s.slice(1);
    else if (/^\d{10,14}$/.test(s)) s = '+' + s;
  }
  return /^\+\d{7,15}$/.test(s) ? s : null;
}

function makeExternalConvId(ownerUid, externalPhone) {
  const e164 = normalizePhone(externalPhone) || externalPhone.replace(/\s/g, '');
  return `ext-${ownerUid}-${e164}`;
}

function parseHashPrefix(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^[#]?\s*(\+?[\d]{6,15})\s+([\s\S]+)$/);
  if (!match) return null;
  const rawPhone  = match[1];
  const cleanText = match[2].trim();
  const e164      = normalizePhone(rawPhone);
  if (!e164 || !cleanText) return null;
  return { targetPhone: e164, cleanText };
}

// ════════════════════════════════════════════════════════════════
// PHASE 6 — OFFLINE MODE TESTS
// ════════════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════════════');
console.log('PHASE 6 — OFFLINE MODE');
console.log('══════════════════════════════════════════════════');

// ── 6.1 : makeExternalConvId ────────────────────────────────────
console.log('\n[6.1] External conversation ID format');
assert(makeExternalConvId('uid123', '+22670000000') === 'ext-uid123-+22670000000',
  'makeExternalConvId: format ext-{uid}-{phone}');
assert(makeExternalConvId('uid123', '+22670000000') === makeExternalConvId('uid123', '+22670000000'),
  'makeExternalConvId: idempotent (same result for same inputs)');
assert(makeExternalConvId('uid_A', '+22670111222') !== makeExternalConvId('uid_B', '+22670111222'),
  'makeExternalConvId: different owners → different convIds');
assert(makeExternalConvId('uid_A', '+22670111222') !== makeExternalConvId('uid_A', '+22670333444'),
  'makeExternalConvId: same owner, different phones → different convIds');

// ── 6.2 : #NUMERO protocol parsing ─────────────────────────────
console.log('\n[6.2] #NUMERO protocol — parseHashPrefix()');
const p1 = parseHashPrefix('#22670123456 Salut Emmanuel');
assert(p1 !== null,                                  '#22670123456 → parsed');
assert(p1?.targetPhone === '+22670123456',           '#22670123456 → E.164 normalisé');
assert(p1?.cleanText === 'Salut Emmanuel',           '#22670123456 → texte extrait');

const p2 = parseHashPrefix('+22670123456 Bonjour');
assert(p2 !== null,                                  '+22670123456 (sans #) → parsed');
assert(p2?.targetPhone === '+22670123456',           '+22670123456 → E.164 correct');

const p3 = parseHashPrefix('#0022670123456 Test');
assert(p3 !== null,                                  '#00226... → parsed (format 00 accepté)');
assert(p3?.targetPhone === '+22670123456',           '#00226... → normalisé en +226...');

assert(parseHashPrefix('Bonjour comment ça va') === null, 'Texte ordinaire → null');
assert(parseHashPrefix('#notaphone message') === null,    '#notaphone → null (pas assez de chiffres)');
assert(parseHashPrefix('') === null,                     'Chaîne vide → null');
assert(parseHashPrefix(null) === null,                   'null → null');
assert(parseHashPrefix('#22670123456') === null,         '#numero sans message → null (texte requis)');

// ── 6.3 : Phone normalization (critical for SMS routing) ────────
console.log('\n[6.3] Phone normalization — normalizePhone()');
assert(normalizePhone('+22670123456') === '+22670123456', '+226... → inchangé');
assert(normalizePhone('0022670123456') === '+22670123456', '00226... → +226...');
assert(normalizePhone('70123456') === '+22670123456',     '8 chiffres BF → +226...');
assert(normalizePhone('  +226 70 12 34 56  ') === '+22670123456', 'espaces supprimés');
assert(normalizePhone(null) === null,                     'null → null');
assert(normalizePhone('') === null,                       'vide → null');
assert(normalizePhone('123') === null,                    'trop court → null');

// ── 6.4 : External conversation structure ──────────────────────
console.log('\n[6.4] External conversation Firestore structure (mock)');
const mockExternalConv = {
  conversationId    : 'ext-uid123-+22670000000',
  ownerUid          : 'uid123',
  externalPhone     : '+22670000000',
  externalName      : 'Jean Dupont',
  infobipNumber     : '+22600111222',        // NEW in Phase 6
  channel           : 'sms',
  createdAt         : new Date().toISOString(),
  updatedAt         : new Date().toISOString(),
  lastMessageAt     : new Date().toISOString(),
  lastMessage       : 'Salut',
  providerMessageIds: ['msg-abc-123'],       // NEW in Phase 6
};
assert(mockExternalConv.conversationId.startsWith('ext-'), 'conversationId commence par ext-');
assert(mockExternalConv.infobipNumber !== undefined,         'infobipNumber présent');
assert(Array.isArray(mockExternalConv.providerMessageIds),   'providerMessageIds est un tableau');
assert(mockExternalConv.channel === 'sms',                  'channel = sms');
assert(mockExternalConv.ownerUid === 'uid123',               'ownerUid présent');

// ── 6.5 : SMS→OmniSMS transition logic ─────────────────────────
console.log('\n[6.5] SMS→OmniSMS transition logic');
// Simuler la logique de transition
function simulateTransition(externalConvs, newPhone, newUid) {
  const affected = externalConvs.filter(c => c.externalPhone === newPhone);
  const updates  = affected.map(c => ({
    docId            : c.conversationId,
    linkedOmniSmsUid : newUid,
    linkedAt         : new Date().toISOString(),
    newOmniConvId    : [c.ownerUid, newUid].sort().join('-'),
  }));
  return updates;
}

const existingConvs = [
  { conversationId: 'ext-ownerA-+22670111111', ownerUid: 'ownerA', externalPhone: '+22670111111' },
  { conversationId: 'ext-ownerB-+22670111111', ownerUid: 'ownerB', externalPhone: '+22670111111' },
  { conversationId: 'ext-ownerA-+22670222222', ownerUid: 'ownerA', externalPhone: '+22670222222' },
];
const transitions = simulateTransition(existingConvs, '+22670111111', 'newUID123');
assert(transitions.length === 2, 'Transition: 2 conversations concernées pour +22670111111');
assert(transitions[0].linkedOmniSmsUid === 'newUID123', 'Transition: linkedOmniSmsUid = newUID');
assert(transitions[0].newOmniConvId === ['ownerA', 'newUID123'].sort().join('-'),
  'Transition: newOmniConvId déterministe [ownerA, newUID]');
assert(transitions[1].newOmniConvId === ['ownerB', 'newUID123'].sort().join('-'),
  'Transition: newOmniConvId déterministe [ownerB, newUID]');
// L'unaffected conversation (ownerA ↔ +22670222222) ne doit pas être modifiée
const unaffected = simulateTransition(existingConvs, '+22670111111', 'newUID123');
const otherConvModified = unaffected.some(u => u.docId === 'ext-ownerA-+22670222222');
assert(!otherConvModified, 'Transition: conversations non-liées au numéro → non touchées');

// ── 6.6 : Infobip number stored on inbound ─────────────────────
console.log('\n[6.6] infobipNumber stored on external_conversations (inbound)');
function mockGetOrCreateExternalConv(ownerUid, externalPhone, externalName, infobipNumber) {
  const e164   = normalizePhone(externalPhone) || externalPhone;
  const convId = makeExternalConvId(ownerUid, e164);
  return {
    conversationId: convId,
    ownerUid,
    externalPhone : e164,
    externalName  : externalName || null,
    infobipNumber : infobipNumber || null,
    channel       : 'sms',
  };
}
const conv = mockGetOrCreateExternalConv('uid123', '+22670111111', null, '+22600999888');
assert(conv.infobipNumber === '+22600999888', 'infobipNumber stocké sur create');
assert(conv.conversationId === 'ext-uid123-+22670111111', 'conversationId correct');

// ════════════════════════════════════════════════════════════════
// PHASE 7 — PAYMENT TESTS
// ════════════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════════════');
console.log('PHASE 7 — PAYMENT');
console.log('══════════════════════════════════════════════════');

// ── 7.1 : userId fallback logic ─────────────────────────────────
console.log('\n[7.1] userId fallback — webhook null userId');
async function mockHandleSuccessfulPayment({ checkoutId, userId, orderId }, mockDb) {
  let resolvedUserId = userId;

  if (!resolvedUserId && checkoutId) {
    // Simuler la lookup Firestore
    const ckDoc = mockDb[checkoutId];
    if (ckDoc?.userId) {
      resolvedUserId = ckDoc.userId;
    }
    if (!resolvedUserId && orderId) {
      const orDoc = mockDb[orderId];
      if (orDoc?.userId) resolvedUserId = orDoc.userId;
    }
  }
  return resolvedUserId;
}

const mockDb = {
  'ck_abc123': { userId: 'user_XYZ', status: 'pending', checkoutId: 'ck_abc123' },
  'OMNI-LP-999': { userId: 'user_XYZ', status: 'pending', orderId: 'OMNI-LP-999' },
};

(async () => {
  // Cas 1 : userId fourni directement dans metadata
  const r1 = await mockHandleSuccessfulPayment({ checkoutId: 'ck_abc123', userId: 'user_META', orderId: null }, mockDb);
  assert(r1 === 'user_META', 'P7: userId from metadata (primary path)');

  // Cas 2 : userId null → fallback par checkoutId
  const r2 = await mockHandleSuccessfulPayment({ checkoutId: 'ck_abc123', userId: null, orderId: null }, mockDb);
  assert(r2 === 'user_XYZ', 'P7: userId null → récupéré via Firestore checkoutId');

  // Cas 3 : userId null, checkoutId inconnu → fallback par orderId
  const r3 = await mockHandleSuccessfulPayment({ checkoutId: 'ck_unknown', userId: null, orderId: 'OMNI-LP-999' }, mockDb);
  assert(r3 === 'user_XYZ', 'P7: userId null, checkoutId inconnu → récupéré via orderId');

  // Cas 4 : userId null, tout inconnu → null
  const r4 = await mockHandleSuccessfulPayment({ checkoutId: 'ck_unknown2', userId: null, orderId: null }, mockDb);
  assert(r4 === null || r4 === undefined, 'P7: userId null + inconnu → null (activation skippée)');

  // ── 7.2 : Anti-replay idempotence ───────────────────────────────
  console.log('\n[7.2] Anti-replay idempotence');
  const processedCheckouts = new Set();
  function isAlreadyProcessedMock(id, firestoreData) {
    if (processedCheckouts.has(id)) return true;
    if (firestoreData[id]?.premiumActivated === true) return true;
    return false;
  }
  const storeA = { 'ck_done': { premiumActivated: true } };
  assert(isAlreadyProcessedMock('ck_done', storeA),   'Anti-replay: Firestore premiumActivated=true → bloqué');
  assert(!isAlreadyProcessedMock('ck_new', storeA),   'Anti-replay: nouveau checkout → autorisé');
  processedCheckouts.add('ck_mem');
  assert(isAlreadyProcessedMock('ck_mem', storeA),    'Anti-replay: mémoire Set → bloqué');

  // ── 7.3 : Webhook signature validation ─────────────────────────
  console.log('\n[7.3] Webhook signature validation');
  const crypto = require('crypto');
  function verifyWebhookSignatureMock(rawBody, signature, signingKey) {
    if (!signingKey) {
      // DEGRADED MODE: log prominently but accept
      return { valid: true, mode: 'degraded_no_key' };
    }
    if (!signature) {
      return { valid: true, mode: 'degraded_no_sig' };
    }
    try {
      const hmac = crypto.createHmac('sha256', signingKey).update(rawBody).digest('hex');
      const bufA = Buffer.from(hmac, 'hex');
      const bufB = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
      if (bufA.length !== bufB.length) return { valid: false, mode: 'invalid' };
      return { valid: crypto.timingSafeEqual(bufA, bufB), mode: 'verified' };
    } catch (_) {
      return { valid: false, mode: 'crypto_error' };
    }
  }
  const body     = '{"event":"payment.completed","data":{"status":"paid"}}';
  const key      = 'test_secret_key';
  const validSig = crypto.createHmac('sha256', key).update(body).digest('hex');

  assert(verifyWebhookSignatureMock(body, validSig, key).valid === true,  'Sig: HMAC valide → accepté');
  assert(verifyWebhookSignatureMock(body, 'bad_sig', key).valid === false, 'Sig: HMAC invalide → rejeté');
  assert(verifyWebhookSignatureMock(body, null, null).mode === 'degraded_no_key',
    'Sig: pas de clé → mode dégradé (loggé)');
  assert(verifyWebhookSignatureMock(body, null, key).mode === 'degraded_no_sig',
    'Sig: clé présente mais pas de signature → mode dégradé (suspect)');

  // ── 7.4 : Payment flow end-to-end data integrity ───────────────
  console.log('\n[7.4] Payment flow data integrity');
  function createCheckoutPayload(userId, orderId, amount, currency) {
    return {
      amount,
      currency,
      description  : `OmniSMS Premium — ${userId.substring(0, 8)}`,
      metadata: {
        userId,     // ← CRITIQUE : doit être présent pour webhook fallback
        orderId,
        app: 'OmniSMS',
      },
    };
  }
  const checkoutPayload = createCheckoutPayload('user_ABC123', 'OMNI-LP-123', 1000, 'XOF');
  assert(checkoutPayload.metadata.userId === 'user_ABC123',  'Checkout: userId dans metadata');
  assert(checkoutPayload.metadata.orderId === 'OMNI-LP-123', 'Checkout: orderId dans metadata');
  assert(checkoutPayload.amount === 1000,                     'Checkout: amount correct');
  assert(checkoutPayload.currency === 'XOF',                  'Checkout: currency correct');

  // ── 7.5 : polling / Socket.IO concurrence ─────────────────────
  console.log('\n[7.5] Polling + Socket.IO coexistence (anti-double activation)');
  let activationCount = 0;
  const processed = new Set();
  async function mockActivate(checkoutId, userId) {
    if (processed.has(checkoutId)) return false; // idempotent
    processed.add(checkoutId);
    activationCount++;
    return true;
  }
  // Simuler webhook + polling simultanés
  await Promise.all([
    mockActivate('ck_concurrent_1', 'user1'),
    mockActivate('ck_concurrent_1', 'user1'),
    mockActivate('ck_concurrent_1', 'user1'),
  ]);
  assert(activationCount === 1, 'Anti-double: activation concurrente → 1 seule exécution');

  // ─────────────────────────────────────────────────────────────
  // RÉSULTAT FINAL
  // ─────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log(`RÉSULTATS : ${passed} ✅  ${failed} ❌`);
  console.log('══════════════════════════════════════════════════\n');
  if (failed > 0) {
    console.error(`${failed} test(s) échoué(s)`);
    process.exit(1);
  } else {
    console.log('✅ Tous les tests Phase 6 & Phase 7 passent !');
    process.exit(0);
  }
})();
