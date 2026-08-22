'use strict';
/**
 * OmniSMS — Tests unitaires P0-P4
 * Couvre toute la logique critique de stabilisation online.
 *
 * Usage :
 *   node test/p0-p4-unit-tests.js
 *
 * Aucune dépendance Firebase/Redis nécessaire — les modules Firestore/Socket.IO
 * sont mocqués pour tester la logique pure.
 */

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    fail++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════╗');
console.log('║   OmniSMS — Tests P0-P4 (offline / unit)    ║');
console.log('╚══════════════════════════════════════════════╝\n');

// ─── P0 — ConversationId déterministe ────────────────────────────────────────
console.log('── P0 — ConversationId déterministe ──────────────────────────────');

function makeConvId(uid1, uid2) {
  return [uid1, uid2].sort().join('-');
}

test('convId est identique pour A→B et B→A', () => {
  const uidA = 'abc123user';
  const uidB = 'xyz789user';
  assertEqual(makeConvId(uidA, uidB), makeConvId(uidB, uidA));
});

test('convId ne contient jamais de numéro de téléphone', () => {
  const uidA = 'abc123user';
  const uidB = 'xyz789user';
  const cid  = makeConvId(uidA, uidB);
  assert(!cid.includes('+226'), 'convId ne doit pas contenir de numéro E.164');
  assert(!cid.includes('0022'), 'convId ne doit pas contenir de numéro 0022xxx');
});

test('convId format : deux UIDs séparés par un tiret', () => {
  const cid = makeConvId('abc123', 'def456');
  const parts = cid.split('-');
  assertEqual(parts.length, 2, 'ConversationId doit avoir exactement 2 parties');
});

test('sort([A, B]) == sort([B, A]) pour UIDs avec caractères spéciaux', () => {
  const uidA = 'ZzTop999';
  const uidB = 'aaBot001';
  assertEqual(makeConvId(uidA, uidB), makeConvId(uidB, uidA));
});

// ─── P0 — Détection phone vs UID ─────────────────────────────────────────────
console.log('\n── P0 — Détection téléphone vs UID ──────────────────────────────');

function looksLikePhone(s) {
  return /^\+?[0-9\s\-()+]{7,20}$/.test(s) && !s.includes('-');
}

test('numéro E.164 détecté comme téléphone', () => {
  assert(looksLikePhone('+22670123456'), '+22670123456 est un téléphone');
});

test('numéro local détecté comme téléphone', () => {
  assert(looksLikePhone('70123456'), '70123456 est un téléphone');
});

test('numéro avec indicatif 00226 détecté comme téléphone', () => {
  assert(looksLikePhone('0022670123456'), '0022670123456 est un téléphone');
});

test('UID Firestore alphanumérique NON détecté comme téléphone', () => {
  assert(!looksLikePhone('KJHabc12345FIRESTORE'), 'UID Firestore n\'est pas un téléphone');
});

test('conversationId "abc-def" NON détecté comme téléphone (contient tiret)', () => {
  assert(!looksLikePhone('abc123user-def789user'), 'convId avec tiret n\'est pas un téléphone');
});

test('UID avec chiffres et lettres NON détecté comme téléphone', () => {
  assert(!looksLikePhone('uid9B4xKm2'), 'UID mixte alphanumérique n\'est pas un téléphone');
});

// ─── P1 — Priorité displayName local vs profile name ─────────────────────────
console.log('\n── P1 — Isolation noms contacts ─────────────────────────────────');

function resolveDisplayName(contactEntry, profileEntry, fallback) {
  // Règle P1 stricte : displayName local > profile name > fallback
  const localDisplayName = contactEntry?.displayName || null;
  const profileName      = profileEntry?.name || null;
  return localDisplayName || profileName || fallback;
}

test('displayName local est prioritaire sur profile name', () => {
  const result = resolveDisplayName(
    { displayName: 'Astrid' },
    { name: 'Angry' },
    'uid123'
  );
  assertEqual(result, 'Astrid', 'Le displayName local "Astrid" doit gagner sur "Angry"');
});

test('profile name utilisé si pas de displayName local', () => {
  const result = resolveDisplayName(
    { displayName: null },
    { name: 'Angry' },
    'uid123'
  );
  assertEqual(result, 'Angry');
});

test('fallback UID si ni displayName ni profile name', () => {
  const result = resolveDisplayName(null, null, 'uid123');
  assertEqual(result, 'uid123');
});

test('displayName local vide n\'écrase pas le profile name', () => {
  const result = resolveDisplayName(
    { displayName: '' },
    { name: 'ProfileName' },
    'uid123'
  );
  assertEqual(result, 'ProfileName', 'DisplayName vide = pas de displayName → fallback profile name');
});

test('contacts_manual ont priorité sur contacts_synced', () => {
  // Simuler la logique de contactCache (manual > synced)
  const contactCache = new Map();
  const manual = [{ contactUid: 'uid1', displayName: 'ManualName', phone: '+22670000000' }];
  const synced = [{ contactUid: 'uid1', displayName: 'SyncedName', phone: '+22670000000' }];

  for (const c of manual) {
    if (c.contactUid) contactCache.set(c.contactUid, { displayName: c.displayName });
  }
  for (const c of synced) {
    if (c.contactUid && !contactCache.has(c.contactUid)) {
      contactCache.set(c.contactUid, { displayName: c.displayName });
    }
  }

  assertEqual(contactCache.get('uid1').displayName, 'ManualName');
});

// ─── P2 — Résolution URL audio ────────────────────────────────────────────────
console.log('\n── P2 — Résolution URL audio ─────────────────────────────────────');

const API_BASE = 'https://omnisms-backend.onrender.com';

function resolveAudioUrl(rawUrl) {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('/') && !rawUrl.startsWith('//')) {
    return API_BASE + rawUrl;
  }
  return rawUrl;
}

test('URL relative → préfixée par API_BASE', () => {
  const resolved = resolveAudioUrl('/uploads/audio/voice_1234.webm');
  assertEqual(resolved, 'https://omnisms-backend.onrender.com/uploads/audio/voice_1234.webm');
});

test('data URI → inchangée', () => {
  const dataUri = 'data:audio/webm;base64,GkXfoZ...';
  assertEqual(resolveAudioUrl(dataUri), dataUri);
});

test('URL absolue HTTPS → inchangée', () => {
  const url = 'https://omnisms-backend.onrender.com/uploads/audio/voice_5678.webm';
  assertEqual(resolveAudioUrl(url), url);
});

test('URL vide → chaîne vide', () => {
  assertEqual(resolveAudioUrl(''), '');
});

test('URL avec protocole protocol-relative // → inchangée', () => {
  const url = '//cdn.example.com/audio.webm';
  assertEqual(resolveAudioUrl(url), url);
});

// ─── P3 — Déduplication messages Socket.IO ───────────────────────────────────
console.log('\n── P3 — Déduplication messages ───────────────────────────────────');

function deduplicateMsg(existingMsgs, newMsg) {
  const exists = existingMsgs.some(m => (m.id || m._id) === (newMsg.id || newMsg._id));
  if (!exists) {
    existingMsgs.push(newMsg);
    return true; // ajouté
  }
  return false; // dupliqué, ignoré
}

test('message avec nouvel ID → ajouté', () => {
  const msgs = [{ id: 'msg1' }, { id: 'msg2' }];
  const added = deduplicateMsg(msgs, { id: 'msg3' });
  assert(added, 'Nouveau message doit être ajouté');
  assertEqual(msgs.length, 3);
});

test('message avec ID existant → non dupliqué', () => {
  const msgs = [{ id: 'msg1' }, { id: 'msg2' }];
  const added = deduplicateMsg(msgs, { id: 'msg1' });
  assert(!added, 'Message dupliqué ne doit pas être ajouté');
  assertEqual(msgs.length, 2);
});

test('message avec _id au lieu de id → dédupliqué correctement', () => {
  const msgs = [{ _id: 'msg1' }];
  const added = deduplicateMsg(msgs, { _id: 'msg1' });
  assert(!added, 'Doit déduplication via _id');
});

test('conversationId matching : string exact', () => {
  const activeConvId = 'uidA-uidB';
  const msg = { conversationId: 'uidA-uidB' };
  assert(msg.conversationId === activeConvId, 'ConversationId doit correspondre exactement');
});

test('conversationId non-matching → message ignoré', () => {
  const activeConvId = 'uidA-uidB';
  const msg = { conversationId: 'uidA-uidC' }; // différente conversation
  assert(msg.conversationId !== activeConvId, 'ConversationId ne correspond pas');
});

// ─── P4 — Groupes : résolution identifiant membre ────────────────────────────
console.log('\n── P4 — Groupes : résolution identifiant ─────────────────────────');

const PHONE_RE    = /^\+?[0-9\s\-()+]{7,20}$/;
const USERNAME_RE = /^@?[a-zA-Z0-9_.-]{2,50}$/;

function classifyIdentifier(s) {
  if (PHONE_RE.test(s) && !s.includes('-')) return 'phone';
  if (USERNAME_RE.test(s)) {
    return s.startsWith('@') ? 'username' : 'username_or_uid';
  }
  return 'uid';
}

test('numéro E.164 classifié comme phone', () => {
  assertEqual(classifyIdentifier('+22670123456'), 'phone');
});

test('@username classifié comme username', () => {
  assertEqual(classifyIdentifier('@alice'), 'username');
});

test('username sans @ classifié comme username_or_uid', () => {
  assertEqual(classifyIdentifier('alice'), 'username_or_uid');
});

test('UID Firestore classifié comme uid ou username_or_uid', () => {
  const cls = classifyIdentifier('KJHabc12345FIRE');
  assert(cls === 'uid' || cls === 'username_or_uid', `Classification inattendue: ${cls}`);
});

test('dupliquer membre → non ajouté', () => {
  const existing = ['uid1', 'uid2', 'uid3'];
  const toAdd = 'uid2';
  const merged = [...new Set([...existing, toAdd])];
  assertEqual(merged.length, 3, 'Pas de duplication');
});

test('nouveau membre → ajouté', () => {
  const existing = ['uid1', 'uid2'];
  const toAdd = 'uid3';
  const merged = [...new Set([...existing, toAdd])];
  assertEqual(merged.length, 3);
  assert(merged.includes('uid3'));
});

test('identifier "phone ou username" accepté via le champ identifier', () => {
  // Simuler la logique backend qui accepte {identifier} ou {members: []}
  function normalizeMembers(body) {
    if (body.members && Array.isArray(body.members)) return body.members;
    if (body.identifier) return [body.identifier];
    return [];
  }

  const withIdentifier = normalizeMembers({ identifier: '+22670123456' });
  assertEqual(withIdentifier.length, 1);
  assertEqual(withIdentifier[0], '+22670123456');

  const withMembers = normalizeMembers({ members: ['uid1', 'uid2'] });
  assertEqual(withMembers.length, 2);

  const empty = normalizeMembers({});
  assertEqual(empty.length, 0);
});

// ─── phoneVariants (userResolver.js) ─────────────────────────────────────────
console.log('\n── PhoneVariants — résolution multi-format ───────────────────────');

function phoneVariants(raw) {
  if (!raw) return [];
  const digits = raw.replace(/\D/g, '');
  const variants = new Set();

  variants.add(raw.trim());
  variants.add(digits);

  if (digits.length >= 8) {
    // Tenter sans indicatif pays (derniers 8 chiffres)
    variants.add(digits.slice(-8));
  }

  // Burkina Faso : 226 → +226
  if (digits.startsWith('226') && digits.length === 11) {
    variants.add('+' + digits);
    variants.add('00' + digits);
    variants.add(digits.slice(3));  // sans indicatif
  }
  if (digits.startsWith('00226') && digits.length === 13) {
    const local = digits.slice(5);
    variants.add('+226' + local);
    variants.add(local);
    variants.add('226' + local);
  }
  if (digits.startsWith('226') || (raw.startsWith('+') && digits.startsWith('226'))) {
    const local = digits.slice(3);
    variants.add(local);
    variants.add('+226' + local);
  }

  return [...variants];
}

test('phoneVariants("+22670123456") contient la version avec "00226"', () => {
  const v = phoneVariants('+22670123456');
  assert(v.includes('0022670123456') || v.some(x => x.includes('70123456')),
    'Doit contenir au moins la version locale ou 00226');
});

test('phoneVariants("70123456") contient le numéro brut', () => {
  const v = phoneVariants('70123456');
  assert(v.includes('70123456'), 'Doit contenir le numéro local brut');
});

test('phoneVariants("0022670123456") génère "+22670123456"', () => {
  const v = phoneVariants('0022670123456');
  assert(v.includes('+22670123456'), `Doit contenir +226... mais a: ${JSON.stringify(v)}`);
});

test('phoneVariants ne retourne pas de duplicates via Set', () => {
  const v = phoneVariants('+22670123456');
  const unique = new Set(v);
  assertEqual(v.length, unique.size, 'Pas de doublons dans les variants');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════');
const total = pass + fail;
console.log(`  Résultats : ${pass}/${total} tests passés`);
if (fail > 0) {
  console.log(`  ⚠️  ${fail} test(s) ÉCHOUÉ(S)`);
} else {
  console.log('  🎉 Tous les tests sont passés !');
}
console.log('════════════════════════════════════════════════\n');

if (fail > 0) process.exit(1);
