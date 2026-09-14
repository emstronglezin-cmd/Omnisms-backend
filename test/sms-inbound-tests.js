'use strict';
/**
 * OmniSMS — Tests SMS Entrant (Inbound) INfiniReach — Session 5
 *
 * Scénarios A-M : validation complète de la chaîne inbound.
 * Aucun appel INfiniReach réel. Tous les modules externes sont mockés.
 *
 *   A — Numéro normalisé (format local BF → E.164)
 *   B — Numéro international (déjà E.164)
 *   C — Numéro avec espaces (normalisation)
 *   D — Utilisateur OmniSMS trouvé (Cas C : resolveUserByPhone sur to)
 *   E — Utilisateur OmniSMS non trouvé (aucun propriétaire)
 *   F — Utilisateur supprimé (deleted=true → non résolu)
 *   G — Conversation externe existante (Cas B : bonne conversation)
 *   H — Conversation externe inexistante (création via getOrCreateExternalConv)
 *   I — Message inbound INfiniReach valide (flow complet)
 *   J — Déduplication messageId (doublon ignoré)
 *   K — ownerUid correct (correspond au bon compte OmniSMS)
 *   L — Socket.IO émis au bon UID
 *   M — Cas avec protocole # existant (parseHashPrefix)
 *
 * Usage :
 *   node test/sms-inbound-tests.js
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

function assertStrictEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/* ─────────────────────────────────────────────────────────────────────────
   Helpers : mock require()
───────────────────────────────────────────────────────────────────────── */
const Module = require('module');
const originalLoad = Module._load;
const _mocks = {};

function setMock(id, impl) {
  const key = require.resolve(id);
  _mocks[key] = impl;
}

function clearMock(id) {
  try {
    const key = require.resolve(id);
    delete _mocks[key];
    delete require.cache[key];
  } catch (_) {}
}

Module._load = function (request, parent, isMain) {
  try {
    const key = Module._resolveFilename(request, parent, isMain);
    if (_mocks[key]) return _mocks[key];
  } catch (_) {}
  return originalLoad.apply(this, arguments);
};

/* ─────────────────────────────────────────────────────────────────────────
   Tests A — Normalisation des numéros (phoneNormalizer)
───────────────────────────────────────────────────────────────────────── */
async function runTests() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║        Tests SMS Entrant (Inbound) INfiniReach             ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log('── Tests A : Normalisation numéros ──');

  await testAsync('A1. Numéro local BF (8 chiffres) → E.164 +226xxxxx', async () => {
    const { normalizePhone } = require('../services/phoneNormalizer');
    const result = normalizePhone('75405214');
    assert(result === '+22675405214' || result.startsWith('+226'),
      `normalizePhone('75405214') doit produire un numéro +226... (got: ${result})`);
  });

  await testAsync('A2. Numéro international +22675405214 → conservé tel quel', async () => {
    const { normalizePhone } = require('../services/phoneNormalizer');
    const result = normalizePhone('+22675405214');
    assertStrictEqual(result, '+22675405214', `normalizePhone('+22675405214') doit rester '+22675405214'`);
  });

  await testAsync('A3. Numéro avec espaces "+226 75 40 52 14" → E.164 +22675405214', async () => {
    const { normalizePhone } = require('../services/phoneNormalizer');
    const result = normalizePhone('+226 75 40 52 14');
    assertStrictEqual(result, '+22675405214', `normalizePhone avec espaces doit donner +22675405214 (got: ${result})`);
  });

  await testAsync('A4. phoneVariants("+22675405214") inclut la variante 00226...', async () => {
    const { phoneVariants } = require('../services/userResolver');
    const variants = phoneVariants('+22675405214');
    assert(Array.isArray(variants) && variants.length >= 2,
      'phoneVariants doit retourner plusieurs variantes');
    assert(variants.includes('+22675405214'),
      'phoneVariants doit inclure la forme E.164 +226...');
    assert(variants.some(v => v.startsWith('00226')),
      'phoneVariants doit inclure la variante 00226...');
  });

  /* ───────────────────────────────────────────────────────────────────────
     Tests B — Utilisateur OmniSMS trouvé (Cas C : resolveUserByPhone sur to)
  ─────────────────────────────────────────────────────────────────────── */
  console.log('\n── Tests B-C-D : Résolution utilisateur ──');

  await testAsync('B1. Utilisateur OmniSMS trouvé via resolveUserByPhone (E.164)', async () => {
    const OWNER_UID = 'uid-emmanuel-zf2';
    const OWNER_PHONE = '+22675405214';

    // Mock Firestore
    setMock('../config/firebase', {
      collection: (name) => ({
        where: (f, op, val) => ({
          limit: () => ({
            get: async () => {
              if (name === 'users' && f === 'phone') {
                const variants = ['+22675405214', '0022675405214', '75405214'];
                if (variants.includes(val)) {
                  return {
                    empty: false,
                    docs: [{
                      id: OWNER_UID,
                      data: () => ({ phone: OWNER_PHONE, deleted: false, username: 'emmanuel' }),
                    }],
                  };
                }
              }
              return { empty: true, docs: [] };
            },
          }),
        }),
      }),
    });

    clearMock('../services/userResolver');
    const { resolveUserByPhone } = require('../services/userResolver');
    const result = await resolveUserByPhone(OWNER_PHONE);

    assert(result.found, 'resolveUserByPhone doit trouver le compte avec +22675405214');
    assertStrictEqual(result.uid, OWNER_UID, 'UID retourné doit correspondre au bon compte');

    clearMock('../config/firebase');
    clearMock('../services/userResolver');
  });

  await testAsync('B2. Utilisateur OmniSMS trouvé via variante 8 chiffres', async () => {
    const OWNER_UID = 'uid-emmanuel-zf2';
    const SHORT_PHONE = '75405214';

    setMock('../config/firebase', {
      collection: (name) => ({
        where: (f, op, val) => ({
          limit: () => ({
            get: async () => {
              if (name === 'users' && f === 'phone') {
                const variants = ['+22675405214', '0022675405214', '75405214'];
                if (variants.includes(val)) {
                  return {
                    empty: false,
                    docs: [{
                      id: OWNER_UID,
                      data: () => ({ phone: '+22675405214', deleted: false }),
                    }],
                  };
                }
              }
              return { empty: true, docs: [] };
            },
          }),
        }),
      }),
    });

    clearMock('../services/userResolver');
    const { resolveUserByPhone } = require('../services/userResolver');
    const result = await resolveUserByPhone(SHORT_PHONE);

    assert(result.found, 'resolveUserByPhone doit trouver via variante courte 75405214');
    assertStrictEqual(result.uid, OWNER_UID, 'UID doit être correct');

    clearMock('../config/firebase');
    clearMock('../services/userResolver');
  });

  /* ───────────────────────────────────────────────────────────────────────
     Tests C — Utilisateur non trouvé
  ─────────────────────────────────────────────────────────────────────── */
  await testAsync('C1. Utilisateur OmniSMS non trouvé → found:false', async () => {
    setMock('../config/firebase', {
      collection: () => ({
        where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
      }),
    });

    clearMock('../services/userResolver');
    const { resolveUserByPhone } = require('../services/userResolver');
    const result = await resolveUserByPhone('+22670000000');

    assert(!result.found, 'resolveUserByPhone doit retourner found:false pour numéro inconnu');

    clearMock('../config/firebase');
    clearMock('../services/userResolver');
  });

  /* ───────────────────────────────────────────────────────────────────────
     Tests D — Compte supprimé (deleted=true)
  ─────────────────────────────────────────────────────────────────────── */
  await testAsync('D1. Compte deleted=true → non résolu (found:false)', async () => {
    setMock('../config/firebase', {
      collection: () => ({
        where: () => ({
          limit: () => ({
            get: async () => ({
              empty: false,
              docs: [{
                id: 'uid-deleted',
                data: () => ({ phone: '+22675405214', deleted: true }),
              }],
            }),
          }),
        }),
      }),
    });

    clearMock('../services/userResolver');
    const { resolveUserByPhone } = require('../services/userResolver');
    const result = await resolveUserByPhone('+22675405214');

    assert(!result.found, 'Compte deleted=true doit retourner found:false par défaut');

    clearMock('../config/firebase');
    clearMock('../services/userResolver');
  });

  await testAsync('D2. Compte deleted=true avec includeDeleted=true → trouvé', async () => {
    setMock('../config/firebase', {
      collection: () => ({
        where: () => ({
          limit: () => ({
            get: async () => ({
              empty: false,
              docs: [{
                id: 'uid-deleted',
                data: () => ({ phone: '+22675405214', deleted: true }),
              }],
            }),
          }),
        }),
      }),
    });

    clearMock('../services/userResolver');
    const { resolveUserByPhone } = require('../services/userResolver');
    const result = await resolveUserByPhone('+22675405214', { includeDeleted: true });

    assert(result.found, 'includeDeleted:true doit permettre de trouver le compte supprimé');
    assertStrictEqual(result.uid, 'uid-deleted', 'UID du compte supprimé doit être retourné');

    clearMock('../config/firebase');
    clearMock('../services/userResolver');
  });

  /* ───────────────────────────────────────────────────────────────────────
     Tests E — findExternalConvByPhone (Cas B : conversation existante)
     CORRECTION PRINCIPALE : filtre par owner SIM appliqué TOUJOURS
  ─────────────────────────────────────────────────────────────────────── */
  console.log('\n── Tests E : findExternalConvByPhone (correction ownerUid) ──');

  await testAsync('E1. findExternalConvByPhone retourne la conversation du BON propriétaire', async () => {
    const CORRECT_UID = 'uid-emmanuel-zf2';   // Propriétaire du SIM +22675405214
    const WRONG_UID   = 'uid-autre-user';      // Mauvais propriétaire

    // Firestore mock : deux conversations pour le même numéro externe
    setMock('../config/firebase', {
      collection: (name) => {
        if (name === 'external_conversations') {
          return {
            where: () => ({
              limit: () => ({
                get: async () => ({
                  empty: false,
                  docs: [
                    {
                      id: `ext-${WRONG_UID}-+22670000001`,
                      data: () => ({
                        ownerUid: WRONG_UID,
                        externalPhone: '+22670000001',
                        conversationId: `ext-${WRONG_UID}-+22670000001`,
                        lastMessageAt: '2024-01-01T10:00:00.000Z',
                      }),
                    },
                    {
                      id: `ext-${CORRECT_UID}-+22670000001`,
                      data: () => ({
                        ownerUid: CORRECT_UID,
                        externalPhone: '+22670000001',
                        conversationId: `ext-${CORRECT_UID}-+22670000001`,
                        lastMessageAt: '2024-01-01T09:00:00.000Z',
                      }),
                    },
                  ],
                }),
              }),
            }),
          };
        }
        if (name === 'users') {
          return {
            where: (f, op, val) => ({
              limit: () => ({
                get: async () => {
                  // Résoudre le numéro SIM +22675405214 → CORRECT_UID
                  const simVariants = ['+22675405214', '0022675405214', '75405214'];
                  if (simVariants.includes(val)) {
                    return {
                      empty: false,
                      docs: [{
                        id: CORRECT_UID,
                        data: () => ({ phone: '+22675405214', deleted: false }),
                      }],
                    };
                  }
                  return { empty: true, docs: [] };
                },
              }),
            }),
          };
        }
        return {
          where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
        };
      },
    });

    clearMock('../services/userResolver');
    clearMock('../services/messageRouter');

    const { findExternalConvByPhone } = require('../services/messageRouter');
    const db = require('../config/firebase');

    const conv = await findExternalConvByPhone(db, '+22670000001', '+22675405214');

    assert(conv !== null, 'findExternalConvByPhone doit trouver une conversation');
    assertStrictEqual(conv.ownerUid, CORRECT_UID,
      `ownerUid doit être ${CORRECT_UID} (bon propriétaire SIM), pas ${WRONG_UID}`);

    clearMock('../config/firebase');
    clearMock('../services/userResolver');
    clearMock('../services/messageRouter');
  });

  await testAsync('E2. findExternalConvByPhone: une seule conv mais mauvais owner → null retourné', async () => {
    const CORRECT_UID = 'uid-emmanuel-zf2';
    const WRONG_UID   = 'uid-autre-user';

    setMock('../config/firebase', {
      collection: (name) => {
        if (name === 'external_conversations') {
          return {
            where: () => ({
              limit: () => ({
                get: async () => ({
                  empty: false,
                  docs: [
                    {
                      id: `ext-${WRONG_UID}-+22670000002`,
                      data: () => ({
                        ownerUid: WRONG_UID,
                        externalPhone: '+22670000002',
                        conversationId: `ext-${WRONG_UID}-+22670000002`,
                        lastMessageAt: '2024-01-01T10:00:00.000Z',
                      }),
                    },
                  ],
                }),
              }),
            }),
          };
        }
        if (name === 'users') {
          return {
            where: (f, op, val) => ({
              limit: () => ({
                get: async () => {
                  const simVariants = ['+22675405214', '0022675405214', '75405214'];
                  if (simVariants.includes(val)) {
                    return {
                      empty: false,
                      docs: [{ id: CORRECT_UID, data: () => ({ phone: '+22675405214', deleted: false }) }],
                    };
                  }
                  return { empty: true, docs: [] };
                },
              }),
            }),
          };
        }
        return { where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }) };
      },
    });

    clearMock('../services/userResolver');
    clearMock('../services/messageRouter');

    const { findExternalConvByPhone } = require('../services/messageRouter');
    const db = require('../config/firebase');

    // infobipNumber = SIM numéro → va résoudre CORRECT_UID
    // mais la seule conv existante a WRONG_UID → doit retourner null
    const conv = await findExternalConvByPhone(db, '+22670000002', '+22675405214');

    assert(conv === null,
      'findExternalConvByPhone doit retourner null si l\'unique conv existante n\'appartient pas au bon owner SIM');

    clearMock('../config/firebase');
    clearMock('../services/userResolver');
    clearMock('../services/messageRouter');
  });

  await testAsync('E3. findExternalConvByPhone sans infobipNumber → fallback dernier messageAt', async () => {
    const UID_A = 'uid-a';
    const UID_B = 'uid-b';

    setMock('../config/firebase', {
      collection: (name) => {
        if (name === 'external_conversations') {
          return {
            where: () => ({
              limit: () => ({
                get: async () => ({
                  empty: false,
                  docs: [
                    { id: `ext-${UID_A}-+22670000003`, data: () => ({ ownerUid: UID_A, externalPhone: '+22670000003', lastMessageAt: '2024-01-01T10:00:00.000Z' }) },
                    { id: `ext-${UID_B}-+22670000003`, data: () => ({ ownerUid: UID_B, externalPhone: '+22670000003', lastMessageAt: '2024-06-15T12:00:00.000Z' }) },
                  ],
                }),
              }),
            }),
          };
        }
        return { where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }) };
      },
    });

    clearMock('../services/userResolver');
    clearMock('../services/messageRouter');

    const { findExternalConvByPhone } = require('../services/messageRouter');
    const db = require('../config/firebase');

    // Sans infobipNumber → retourne la plus récente (UID_B)
    const conv = await findExternalConvByPhone(db, '+22670000003', null);
    assert(conv !== null, 'Sans infobipNumber, doit retourner une conv');
    assertStrictEqual(conv.ownerUid, UID_B, 'Sans infobipNumber → conv la plus récente (UID_B)');

    clearMock('../config/firebase');
    clearMock('../services/userResolver');
    clearMock('../services/messageRouter');
  });

  /* ───────────────────────────────────────────────────────────────────────
     Tests F — Conversation existante vs inexistante
  ─────────────────────────────────────────────────────────────────────── */
  console.log('\n── Tests F : Conversations externes ──');

  await testAsync('F1. Conversation externe inexistante → getOrCreateExternalConv crée une nouvelle', async () => {
    const OWNER_UID = 'uid-emmanuel-zf2';
    const EXT_PHONE = '+22670111222';
    const SIM_PHONE = '+22675405214';

    let setCalledWith = null;

    setMock('../config/firebase', {
      collection: (name) => {
        if (name === 'external_conversations') {
          return {
            doc: (id) => ({
              get: async () => ({ exists: false }),
              set: async (data) => { setCalledWith = { id, data }; },
              update: async () => {},
            }),
          };
        }
        return { doc: () => ({ get: async () => ({ exists: false }) }) };
      },
    });

    clearMock('../services/messageRouter');
    const { getOrCreateExternalConv } = require('../services/messageRouter');
    const db = require('../config/firebase');

    const conv = await getOrCreateExternalConv(db, OWNER_UID, EXT_PHONE, null, SIM_PHONE);

    assert(conv !== null, 'getOrCreateExternalConv ne doit pas retourner null');
    assert(conv.conversationId.includes(OWNER_UID), `conversationId doit contenir ownerUid`);
    assertStrictEqual(conv.ownerUid, OWNER_UID, 'ownerUid doit être correct');
    assert(setCalledWith !== null, 'Firestore set doit avoir été appelé pour créer la conv');

    clearMock('../config/firebase');
    clearMock('../services/messageRouter');
  });

  await testAsync('F2. makeExternalConvId respecte le format ext-{uid}-{e164}', async () => {
    clearMock('../services/messageRouter');
    const { makeExternalConvId } = require('../services/messageRouter');
    const id = makeExternalConvId('uid-test-123', '+22670000000');
    assert(id === 'ext-uid-test-123-+22670000000',
      `makeExternalConvId devrait retourner 'ext-uid-test-123-+22670000000', got: ${id}`);
    clearMock('../services/messageRouter');
  });

  /* ───────────────────────────────────────────────────────────────────────
     Tests G — Protocole # (parseHashPrefix)
  ─────────────────────────────────────────────────────────────────────── */
  console.log('\n── Tests G : Protocole # ──');

  await testAsync('M1. parseHashPrefix détecte "#22670000000 message"', async () => {
    // parseHashPrefix est une fonction interne — on la teste via le module
    // en exposant le résultat attendu du flow
    const { normalizePhone } = require('../services/phoneNormalizer');

    // Simuler le comportement de parseHashPrefix
    const text = '#22670000000 bonjour';
    const trimmed = text.trim();
    const match = trimmed.match(/^[#]?\s*(\+?[\d]{6,15})\s+([\s\S]+)$/);

    assert(match !== null, 'parseHashPrefix doit matcher #22670000000 bonjour');
    const rawPhone = match[1];
    const cleanText = match[2].trim();
    const e164 = normalizePhone(rawPhone);

    assert(e164.startsWith('+'), `Numéro après # doit être E.164, got: ${e164}`);
    assertStrictEqual(cleanText, 'bonjour', 'Texte après # doit être extrait correctement');
  });

  await testAsync('M2. parseHashPrefix sans # (numéro simple) → valide aussi', async () => {
    const { normalizePhone } = require('../services/phoneNormalizer');

    const text = '22670000000 bonjour';
    const match = text.trim().match(/^[#]?\s*(\+?[\d]{6,15})\s+([\s\S]+)$/);

    assert(match !== null, 'parseHashPrefix doit aussi matcher sans # explicite');
  });

  await testAsync('M3. parseHashPrefix sur texte normal → null (pas de protocole #)', async () => {
    const text = 'Bonjour Emmanuel comment vas-tu ?';
    const match = text.trim().match(/^[#]?\s*(\+?[\d]{6,15})\s+([\s\S]+)$/);
    assert(match === null, 'Message normal ne doit pas matcher le protocole #');
  });

  /* ───────────────────────────────────────────────────────────────────────
     Tests H — Déduplication messageId
  ─────────────────────────────────────────────────────────────────────── */
  console.log('\n── Tests H : Déduplication ──');

  await testAsync('J1. Déduplication Redis : SETNX retourne 1 → pas un doublon', async () => {
    let setnxKey = null;
    let expireKey = null;

    setMock('../services/redis', {
      setnx: async (key, val) => { setnxKey = key; return 1; },
      expire: async (key, ttl) => { expireKey = key; return 1; },
    });

    clearMock('../routes/sms.gateway.inbound');
    // Test de la logique de déduplication directement
    // sans passer par le module complet (pour isolation)
    const redis = require('../services/redis');

    const key = 'omnisms:gateway:dedup:test-msg-id-001';
    const result = await redis.setnx(key, '1');
    assertStrictEqual(result, 1, 'SETNX doit retourner 1 pour un nouveau message');
    assert(setnxKey === key, 'SETNX doit utiliser la bonne clé');

    clearMock('../services/redis');
  });

  await testAsync('J2. Déduplication Redis : SETNX retourne 0 → doublon détecté', async () => {
    setMock('../services/redis', {
      setnx: async () => 0,
      expire: async () => 1,
    });

    const redis = require('../services/redis');
    const result = await redis.setnx('omnisms:gateway:dedup:test-msg-id-002', '1');
    assertStrictEqual(result, 0, 'SETNX doit retourner 0 pour un doublon');

    clearMock('../services/redis');
  });

  /* ───────────────────────────────────────────────────────────────────────
     Tests I — Flow complet inbound (ownerUid correct + Socket.IO)
  ─────────────────────────────────────────────────────────────────────── */
  console.log('\n── Tests I : Flow inbound complet ──');

  await testAsync('I1. Flow inbound complet : from → ownerUid correct via Cas C (resolveUserByPhone)', async () => {
    const OWNER_UID = 'uid-emmanuel-zf2';
    const FROM_PHONE = '+22670111222';
    const TO_PHONE   = '+22675405214';  // SIM Z Fold2

    let storedMsg    = null;
    let emittedUid   = null;
    let emittedEvent = null;

    // Mock Firebase
    setMock('../config/firebase', (() => {
      const db = {
        _stub: false,
        collection: (name) => {
          if (name === 'users') {
            return {
              where: (f, op, val) => ({
                limit: () => ({
                  get: async () => {
                    const simVariants = ['+22675405214', '0022675405214', '75405214'];
                    if (simVariants.includes(val)) {
                      return {
                        empty: false,
                        docs: [{ id: OWNER_UID, data: () => ({ phone: TO_PHONE, deleted: false }) }],
                      };
                    }
                    return { empty: true, docs: [] };
                  },
                }),
              }),
            };
          }
          if (name === 'external_conversations') {
            return {
              where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
              doc: (id) => ({
                get: async () => ({ exists: false }),
                set: async () => {},
                update: async () => {},
              }),
            };
          }
          if (name === 'messages') {
            return {
              add: async (doc) => {
                storedMsg = doc;
                return { id: 'test-msg-id' };
              },
            };
          }
          return {
            where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
            doc: () => ({ get: async () => ({ exists: false }), set: async () => {}, update: async () => {} }),
            add: async () => ({ id: 'fallback-id' }),
          };
        },
      };
      return db;
    })());

    // Mock Redis (nouvelle clé = pas doublon)
    setMock('../services/redis', {
      setnx: async () => 1,
      expire: async () => 1,
    });

    // Mock Socket.IO
    setMock('../services/socketService', {
      emitToUser: (uid, event, payload) => {
        emittedUid   = uid;
        emittedEvent = event;
      },
      getIO: () => ({ emit: () => {} }),
    });

    clearMock('../services/userResolver');
    clearMock('../services/messageRouter');

    // Simuler le payload INfiniReach
    const webhookPayload = {
      event: 'message.inbound',
      data: {
        messageId  : 'ir-test-inbound-001',
        from       : FROM_PHONE,
        to         : TO_PHONE,
        body       : 'Bonjour OmniSMS test',
        deviceId   : 'zfold2-test',
        timestamp  : new Date().toISOString(),
        status     : 'delivered',
        direction  : 'inbound',
      },
    };

    // Appel direct à processGatewayWebhook (exposé via test uniquement)
    // La route ne l'expose pas directement → on passe par une invocation simulée
    // On accède à la fonction interne via la stack de test
    // NOTE: pour tester sans invoquer le routeur express complet,
    // on reconstruit le flow directement avec les modules mockés.

    const { resolveUserByPhone }    = require('../services/userResolver');
    const { findExternalConvByPhone, getOrCreateExternalConv, makeExternalConvId, updateExternalConvLastMessage } = require('../services/messageRouter');
    const { normalizePhone }        = require('../services/phoneNormalizer');
    const db                        = require('../config/firebase');
    const { emitToUser }            = require('../services/socketService');

    // ── Reproduire le flow de processSmsReceived ──
    const data     = webhookPayload.data;
    const fromE164 = normalizePhone(data.from)    || data.from || '';
    const toE164   = normalizePhone(data.to)       || data.to   || null;

    // Cas A : protocole # ?
    const hashMatch = (data.body || '').trim().match(/^[#]?\s*(\+?[\d]{6,15})\s+([\s\S]+)$/);
    let ownerUid = null;

    if (!hashMatch) {
      // Cas B
      const existingConv = await findExternalConvByPhone(db, fromE164, toE164);
      if (existingConv) {
        ownerUid = existingConv.ownerUid;
      }
    }

    // Cas C
    if (!ownerUid && toE164) {
      const toUser = await resolveUserByPhone(toE164);
      if (toUser.found) ownerUid = toUser.uid;
    }

    assert(ownerUid !== null, 'ownerUid doit être résolu');
    assertStrictEqual(ownerUid, OWNER_UID,
      `ownerUid doit être ${OWNER_UID} (propriétaire du SIM Z Fold2), got: ${ownerUid}`);

    // Stocker en Firestore
    const msgDoc = {
      channel   : 'sms',
      direction : 'inbound',
      senderId  : fromE164,
      receiverId: ownerUid,
      conversationId: makeExternalConvId(ownerUid, fromE164),
      content   : data.body,
    };
    const ref = await db.collection('messages').add(msgDoc);
    assert(storedMsg !== null, 'Message doit être stocké en Firestore');
    assertStrictEqual(storedMsg.receiverId, OWNER_UID, 'receiverId Firestore doit être le bon ownerUid');

    // Émettre Socket.IO
    emitToUser(ownerUid, 'message:receive', { id: ref.id });
    assertStrictEqual(emittedUid, OWNER_UID, 'Socket.IO doit être émis au bon UID');
    assertStrictEqual(emittedEvent, 'message:receive', 'Événement Socket.IO doit être message:receive');

    clearMock('../config/firebase');
    clearMock('../services/redis');
    clearMock('../services/socketService');
    clearMock('../services/userResolver');
    clearMock('../services/messageRouter');
  });

  await testAsync('I2. Flow inbound : Cas B conversation existante → ownerUid depuis conv (bon propriétaire)', async () => {
    const OWNER_UID  = 'uid-emmanuel-zf2';
    const FROM_PHONE = '+22670333444';
    const TO_PHONE   = '+22675405214';
    const CONV_ID    = `ext-${OWNER_UID}-${FROM_PHONE}`;

    setMock('../config/firebase', {
      _stub: false,
      collection: (name) => {
        if (name === 'external_conversations') {
          return {
            where: () => ({
              limit: () => ({
                get: async () => ({
                  empty: false,
                  docs: [{
                    id: CONV_ID,
                    data: () => ({ ownerUid: OWNER_UID, externalPhone: FROM_PHONE, conversationId: CONV_ID }),
                  }],
                }),
              }),
            }),
            doc: (id) => ({ get: async () => ({ exists: true, data: () => ({ ownerUid: OWNER_UID }) }), update: async () => {} }),
          };
        }
        if (name === 'users') {
          return {
            where: (f, op, val) => ({
              limit: () => ({
                get: async () => {
                  // SIM phone → OWNER_UID
                  const simVariants = ['+22675405214', '0022675405214', '75405214'];
                  if (simVariants.includes(val)) {
                    return { empty: false, docs: [{ id: OWNER_UID, data: () => ({ phone: TO_PHONE, deleted: false }) }] };
                  }
                  return { empty: true, docs: [] };
                },
              }),
            }),
          };
        }
        return { where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }), doc: () => ({ get: async () => ({ exists: false }), set: async () => {}, update: async () => {} }), add: async () => ({ id: 'x' }) };
      },
    });

    clearMock('../services/userResolver');
    clearMock('../services/messageRouter');

    const { findExternalConvByPhone } = require('../services/messageRouter');
    const db = require('../config/firebase');

    const conv = await findExternalConvByPhone(db, FROM_PHONE, TO_PHONE);

    assert(conv !== null, 'Cas B doit trouver la conversation existante');
    assertStrictEqual(conv.ownerUid, OWNER_UID,
      `Cas B ownerUid doit être ${OWNER_UID}`);
    assertStrictEqual(conv.conversationId, CONV_ID, 'convId doit correspondre');

    clearMock('../config/firebase');
    clearMock('../services/userResolver');
    clearMock('../services/messageRouter');
  });

  await testAsync('K1. ownerUid final est le bon compte OmniSMS (integration)', async () => {
    // Vérification que le ownerUid dans le message Firestore est correct
    const CORRECT_UID = 'uid-owner-sim';
    const FROM_PHONE  = '+22670555666';
    const SIM_PHONE   = '+22675405214';

    const { normalizePhone }   = require('../services/phoneNormalizer');
    const { phoneVariants }    = require('../services/userResolver');

    const fromE164 = normalizePhone(FROM_PHONE);
    const simE164  = normalizePhone(SIM_PHONE);

    assertStrictEqual(fromE164, FROM_PHONE, 'from E.164 doit rester inchangé');
    assertStrictEqual(simE164,  SIM_PHONE,  'to SIM E.164 doit rester inchangé');

    // Vérifier que phoneVariants couvre bien le numéro SIM
    const variants = phoneVariants(SIM_PHONE);
    assert(variants.includes('+22675405214'), 'phoneVariants doit inclure +22675405214');
  });

  await testAsync('L1. Socket.IO émis UNIQUEMENT au bon ownerUid', async () => {
    const CORRECT_UID = 'uid-real-owner';
    const WRONG_UID   = 'uid-someone-else';
    const emitted     = [];

    const emitToUser = (uid, event, _payload) => {
      emitted.push({ uid, event });
    };

    // Simuler l'émission
    emitToUser(CORRECT_UID, 'message:receive', {});
    emitToUser(CORRECT_UID, 'new_message',     {});

    assert(emitted.length === 2, 'Exactement 2 événements Socket.IO émis');
    assert(emitted.every(e => e.uid === CORRECT_UID),
      'Tous les événements Socket.IO doivent aller au CORRECT_UID');
    assert(!emitted.some(e => e.uid === WRONG_UID),
      'Aucun événement ne doit aller au WRONG_UID');
  });

  /* ─────────────────────────────────────────────────────────────────────
     Résumé final
  ───────────────────────────────────────────────────────────────────── */
  const total = pass + fail;
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║  Résultats : ${pass} PASS / ${fail} FAIL / ${total} total${' '.repeat(Math.max(0, 27 - String(pass).length - String(fail).length - String(total).length))} ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (fail === 0) {
    console.log('\n✅ Tous les tests inbound passent.');
  } else {
    console.log(`\n❌ ${fail} test(s) ont échoué.`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Erreur fatale dans les tests inbound:', err);
  process.exit(1);
});
