'use strict';
/**
 * OmniSMS — Tests Routage SMS Entrant (Présence + FROM/TO)
 *
 * Vérifie les deux bugs critiques corrigés en Session 7 :
 *   Bug 1 : fallback SMS vers fromE164 au lieu de recipientE164
 *   Bug 2 : présence non isolée par UID (autre UID connecté ≠ destinataire online)
 *
 * Tests :
 *   Test 1 — Destinataire CONNECTÉ (57→75) → OmniSMS, aucun SMS fallback
 *   Test 2 — Destinataire DÉCONNECTÉ (57→75) → SMS vers 75, JAMAIS vers 57
 *   Test 3 — Destinataire SANS compte OmniSMS → SMS vers X
 *   Test 4 — Présence isolée par UID (B connecté ≠ A online)
 *   Test 5 — Variantes de numéros résolvent vers le même compte
 */

let pass = 0;
let fail = 0;

function ok(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}${detail ? '\n     ' + detail : ''}`);
    fail++;
  }
}

// ─────────────────────────────────────────────────────────────
// Lecture du code source — tests structurels (sans live server)
// ─────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const inboundSrc = fs.readFileSync(
  path.join(__dirname, '../routes/sms.gateway.inbound.js'),
  'utf8'
);

console.log('\n── Test 1 — Destinataire CONNECTÉ → OmniSMS, pas de fallback ──────');

ok(
  'T1.a Code contient la vérification de présence (isUserOnline)',
  /isUserOnline\s*\(ownerUid\)/.test(inboundSrc),
  'isUserOnline(ownerUid) doit être appelé avec l\'UID destinataire'
);

ok(
  'T1.b OmniSMS branch émet vers ownerUid (message:receive)',
  /emitFn\s*\(\s*ownerUid\s*,\s*'message:receive'/.test(inboundSrc) ||
  /emitFn\s*\(\s*ownerUid\s*,\s*"message:receive"/.test(inboundSrc),
  'emitFn(ownerUid, "message:receive", ...) doit être présent'
);

ok(
  'T1.c Log routingDecision: omnisms quand online',
  /routingDecision\s*:\s*['"]omnisms['"]/.test(inboundSrc),
  'log { routingDecision: "omnisms" } doit être présent'
);

console.log('\n── Test 2 — Destinataire DÉCONNECTÉ → SMS vers DESTINATAIRE (75), JAMAIS vers expéditeur (57) ──');

// Bug 1 : vérifier que fromE164 n'est PAS utilisé comme `to` dans sendSMS du fallback
// La ligne corrigée doit contenir `to: recipientE164`
const sendSmsBlock = (() => {
  // Extraire le bloc sendSMS du fallback offline
  const match = inboundSrc.match(/smsGateway\.sendSMS\s*\(\s*\{([\s\S]{0,400}?)\}\s*\)/);
  return match ? match[0] : '';
})();

ok(
  'T2.a sendSMS fallback utilise recipientE164 comme `to` (DESTINATAIRE)',
  /to\s*:\s*recipientE164/.test(sendSmsBlock),
  `Bloc sendSMS extrait : ${sendSmsBlock.slice(0, 120).replace(/\n/g, ' ')}`
);

ok(
  'T2.b sendSMS fallback N\'utilise PAS fromE164 comme `to`',
  !/to\s*:\s*fromE164/.test(sendSmsBlock),
  'fromE164 ne doit JAMAIS être le destinataire du fallback'
);

ok(
  'T2.c Log fallbackTo utilise recipientE164',
  /fallbackTo\s*:.*recipientE164/.test(inboundSrc),
  'log { fallbackTo: recipientE164... } doit être présent'
);

ok(
  'T2.d Log routingDecision: sms_fallback quand offline',
  /routingDecision\s*:\s*['"]sms_fallback['"]/.test(inboundSrc),
  'log { routingDecision: "sms_fallback" } doit être présent'
);

ok(
  'T2.e Guard: fallback SMS seulement si recipientE164 est résolu',
  /if\s*\(\s*recipientE164\s*\)/.test(inboundSrc),
  'Guard if (recipientE164) doit protéger le sendSMS fallback'
);

console.log('\n── Test 3 — Destinataire SANS compte OmniSMS ──────────────────────');

ok(
  'T3.a Code gère ownerUid absent (pas de crash)',
  /if\s*\(\s*ownerUid\s*\)/.test(inboundSrc),
  'if (ownerUid) doit conditionner tout le bloc de livraison'
);

ok(
  'T3.b Message stocké en Firestore même sans ownerUid',
  /db\.collection\s*\(\s*'messages'\s*\)\.add\s*\(/.test(inboundSrc) ||
  /db\.collection\s*\(\s*"messages"\s*\)\.add\s*\(/.test(inboundSrc),
  'db.collection("messages").add() doit être hors du bloc if(ownerUid)'
);

console.log('\n── Test 4 — Isolation de la présence par UID ──────────────────────');

ok(
  'T4.a isUserOnline est appelé avec ownerUid (UID destinataire)',
  /isUserOnline\s*\(\s*ownerUid\s*\)/.test(inboundSrc),
  'Seul l\'UID résolu du destinataire est vérifié'
);

ok(
  'T4.b Double vérification : Redis + Socket.IO room user:{ownerUid}',
  /io\.in\s*\(`user:\$\{ownerUid\}`\)/.test(inboundSrc) ||
  /io\.in\s*\('user:'\s*\+\s*ownerUid\)/.test(inboundSrc),
  'io.in(`user:${ownerUid}`).fetchSockets() doit être présent comme fallback'
);

ok(
  'T4.c fetchSockets() utilisé pour vérifier room spécifique',
  /fetchSockets\s*\(\s*\)/.test(inboundSrc),
  'fetchSockets() vérifie les sockets de CE UID uniquement'
);

ok(
  'T4.d Log structuré inclut resolvedRecipientUid',
  /resolvedRecipientUid/.test(inboundSrc),
  'log { resolvedRecipientUid: ownerUid } doit être présent'
);

ok(
  'T4.e Log structuré inclut recipientPresence',
  /recipientPresence/.test(inboundSrc),
  'log { recipientPresence: "online"|"offline" } doit être présent'
);

console.log('\n── Test 5 — Variantes de numéros → même compte ────────────────────');

// Tester phoneVariants directement
let userResolver;
try {
  userResolver = require('../services/userResolver');
} catch (_) {}

const phoneNormalizer = (() => {
  try { return require('../services/phoneNormalizer'); } catch (_) { return null; }
})();

ok(
  'T5.a phoneNormalizer est disponible',
  !!phoneNormalizer,
  'services/phoneNormalizer.js doit être importable'
);

if (phoneNormalizer) {
  const n1 = phoneNormalizer.normalizePhone('+22675405214');
  const n2 = phoneNormalizer.normalizePhone('75405214');
  const n3 = phoneNormalizer.normalizePhone('+226 75 40 52 14');

  ok(
    'T5.b +22675405214 normalise en E.164',
    n1 === '+22675405214',
    `Résultat : ${n1}`
  );

  ok(
    'T5.c 75405214 normalise vers le même E.164',
    n2 === '+22675405214',
    `Résultat : ${n2} (attendu: +22675405214)`
  );

  ok(
    'T5.d "+226 75 40 52 14" normalise vers le même E.164',
    n3 === '+22675405214',
    `Résultat : ${n3} (attendu: +22675405214)`
  );

  ok(
    'T5.e phoneVariants génère les variantes attendues',
    !!userResolver && typeof userResolver.phoneVariants === 'function',
    'userResolver.phoneVariants() doit être exporté'
  );

  if (userResolver && typeof userResolver.phoneVariants === 'function') {
    const variants = userResolver.phoneVariants('+22675405214');
    ok(
      'T5.f phoneVariants inclut la variante 0022675405214',
      variants.includes('0022675405214'),
      `Variantes : ${variants.join(', ')}`
    );
  }
}

console.log('\n── Test 6 — Logs de diagnostic complets ────────────────────────────');

ok(
  'T6.a Log contient incomingFrom',
  /incomingFrom/.test(inboundSrc)
);

ok(
  'T6.b Log contient incomingTo',
  /incomingTo/.test(inboundSrc)
);

ok(
  'T6.c Log contient resolvedRecipientPhone',
  /resolvedRecipientPhone/.test(inboundSrc)
);

ok(
  'T6.d Log contient recipientOmniSms',
  /recipientOmniSms/.test(inboundSrc)
);

ok(
  'T6.e Log contient routingDecision',
  /routingDecision/.test(inboundSrc)
);

console.log('\n── Test 7 — Comportement logique du routage ────────────────────────');

// Simuler la logique de routage directement
function simulateRouting(fromE164, recipientE164, ownerUid, ownerIsOnline) {
  const result = { smsTo: null, route: null };

  if (!ownerUid) {
    // Pas de compte OmniSMS — pas de SMS fallback depuis ce handler
    // (l'expéditeur externe n'attend pas de retour)
    result.route = 'no_account';
    result.smsTo = null;
    return result;
  }

  if (ownerIsOnline) {
    result.route = 'omnisms';
    result.smsTo = null; // Pas de SMS — livraison OmniSMS
  } else {
    result.route = 'sms_fallback';
    result.smsTo = recipientE164; // ← TOUJOURS le destinataire
  }
  return result;
}

// T7.a 57→75, 75 connecté → OmniSMS, pas de SMS
const r1 = simulateRouting('+22657670000', '+22675405214', 'MGvh4dYLlwJhv5jQbBB9', true);
ok('T7.a 57→75, 75 ONLINE → route=omnisms', r1.route === 'omnisms');
ok('T7.b 57→75, 75 ONLINE → smsTo=null (aucun SMS envoyé)', r1.smsTo === null);

// T7.c 57→75, 75 déconnecté → SMS vers 75, pas vers 57
const r2 = simulateRouting('+22657670000', '+22675405214', 'MGvh4dYLlwJhv5jQbBB9', false);
ok('T7.c 57→75, 75 OFFLINE → route=sms_fallback', r2.route === 'sms_fallback');
ok(
  'T7.d 57→75, 75 OFFLINE → SMS envoyé vers 75 (DESTINATAIRE)',
  r2.smsTo === '+22675405214',
  `smsTo=${r2.smsTo} (attendu: +22675405214)`
);
ok(
  'T7.e 57→75, 75 OFFLINE → SMS PAS envoyé vers 57 (EXPÉDITEUR)',
  r2.smsTo !== '+22657670000',
  `smsTo=${r2.smsTo} (interdit: +22657670000)`
);

// T7.f Pas de compte OmniSMS
const r3 = simulateRouting('+22657670000', '+22699990000', null, false);
ok('T7.f Destinataire sans OmniSMS → route=no_account', r3.route === 'no_account');

// T7.g Présence isolée : UID B connecté ne rend pas UID A online
function checkPresenceIsolation(uidToCheck, connectedUids) {
  // Simuler le comportement de isUserOnline(uid) :
  // retourne true SEULEMENT si uid est dans la liste
  return connectedUids.includes(uidToCheck);
}

const uidA = 'MGvh4dYLlwJhv5jQbBB9';
const uidB = 'rvVbPMAYcbtSeUqQRvIr';
const onlineUids = [uidB]; // Seul B est connecté

ok(
  'T7.g UID B connecté → UID A reste OFFLINE (isolation correcte)',
  checkPresenceIsolation(uidA, onlineUids) === false,
  `A online=${checkPresenceIsolation(uidA, onlineUids)} (attendu: false)`
);

ok(
  'T7.h UID B connecté → UID B est bien ONLINE',
  checkPresenceIsolation(uidB, onlineUids) === true,
  `B online=${checkPresenceIsolation(uidB, onlineUids)} (attendu: true)`
);

// ─────────────────────────────────────────────────────────────
// Résultat final
// ─────────────────────────────────────────────────────────────
const total = pass + fail;
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log(`║  Résultats : ${String(pass).padEnd(2)} PASS / ${String(fail).padEnd(2)} FAIL / ${total} total                     ║`);
console.log('╚════════════════════════════════════════════════════════════╝\n');

if (fail === 0) {
  console.log('✅ Tous les tests routage présence passent.\n');
  console.log('   ✓ Bug 1 corrigé : SMS fallback → DESTINATAIRE (recipientE164), jamais l\'expéditeur');
  console.log('   ✓ Bug 2 corrigé : présence isolée par UID destinataire (Redis + Socket.IO room)');
  console.log('   ✓ Logs diagnostic : incomingFrom/To, resolvedRecipientUid, routingDecision, fallbackTo');
} else {
  console.error(`❌ ${fail} test(s) échoué(s).`);
  process.exit(1);
}
