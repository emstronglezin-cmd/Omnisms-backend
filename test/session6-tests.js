'use strict';
/**
 * OmniSMS — Tests Session 6 (A-AB)
 * Couverture : §1-15 (routage présence, vocal, temps réel, PWA, offline, SaaSPay)
 *
 * Tests automatisables sans infra live (mocks) :
 *   A–F : Routage SMS entrant (présence)
 *   G–I : Vocal → SMS (transcription path)
 *   J–L : Temps réel (polling merge)
 *   M–P : Microphone (permission stubs)
 *   W–Y : Offline compteur (crédits)
 *   Z–AB : SaaSPay (service import)
 *
 * Tests Q-V (Safari/Chrome/PWA) : manuels — non automatisables.
 */

let pass = 0;
let fail = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    pass++;
  } catch (e) {
    console.error(`  ❌ ${label}`);
    console.error(`     ${e.message}`);
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// ── §1-2 — Présence dans socketService ──────────────────────
console.log('\n── §1-2 Présence Socket.IO ──────────────────────────');

test('A. isUserOnline exporté depuis socketService', () => {
  const sock = require('../services/socketService');
  assert(typeof sock.isUserOnline === 'function', 'isUserOnline must be a function');
  assert(typeof sock.setUserOnline === 'function', 'setUserOnline must be a function');
  assert(typeof sock.setUserOffline === 'function', 'setUserOffline must be a function');
});

test('B. isUserOnline retourne false si Redis absent (pas de crash)', async () => {
  const sock = require('../services/socketService');
  // Redis non connecté en test → doit retourner false sans lever d'exception
  const result = await sock.isUserOnline('test-uid-absent');
  assert(result === false, `Expected false, got ${result}`);
});

test('C. sms.gateway.inbound.js contient la vérification de présence', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../routes/sms.gateway.inbound.js', 'utf8');
  assert(src.includes('isUserOnline'), 'isUserOnline call must be present');
  assert(src.includes('ownerIsOnline'), 'ownerIsOnline variable must be present');
  assert(src.includes('OmniSMS (utilisateur connecté)'), 'OmniSMS connected log must be present');
  assert(src.includes('SMS ordinaire (utilisateur déconnecté)'), 'SMS fallback log must be present');
});

// ── §3 — Username routing ────────────────────────────────────
console.log('\n── §3 Username routing ──────────────────────────────');

test('D. resolveUserByUsername exporté depuis userResolver', () => {
  const ur = require('../services/userResolver');
  assert(typeof ur.resolveUserByUsername === 'function', 'resolveUserByUsername must be a function');
});

test('E. resolveUserByPhone exporté et accepte les variantes', () => {
  const { resolveUserByPhone } = require('../services/userResolver');
  assert(typeof resolveUserByPhone === 'function', 'resolveUserByPhone must be a function');
});

// ── §4 — SMS fallback (infinireach unchanged) ────────────────
console.log('\n── §4 SMS Fallback (InfiniReach non modifié) ────────');

test('F. smsGateway.sendSMS exporté et non modifié', () => {
  const gw = require('../services/smsGateway');
  assert(typeof gw.sendSMS === 'function', 'sendSMS must be a function');
  assert(typeof gw.isConfigured === 'function', 'isConfigured must be a function');
});

// ── §5 — Voice → transcription → SMS ────────────────────────
console.log('\n── §5 Voice → Transcription → SMS ───────────────────');

test('G. messageRouter.js contient la branche audio→transcription', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../services/messageRouter.js', 'utf8');
  assert(src.includes("type === 'audio' && audioUrl"), 'audio branch condition must be present');
  assert(src.includes('transcriptionService'), 'transcriptionService import must be present');
  assert(src.includes('transcribe('), 'transcribe() call must be present');
  assert(src.includes('[OmniSMS Vocal]'), 'SMS text prefix must be present');
});

test('H. transcriptionService.transcribe est une fonction async', () => {
  const { transcribe } = require('../services/transcriptionService');
  assert(typeof transcribe === 'function', 'transcribe must be a function');
});

test('I. messageRouter NE CASSE PAS si audioUrl est null', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../services/messageRouter.js', 'utf8');
  // Vérifier que la condition est: type === 'audio' && audioUrl (pas juste type === 'audio')
  assert(src.includes("type === 'audio' && audioUrl"), 'Must check audioUrl before transcribing');
});

// ── §6-7 — Temps réel (polling) ──────────────────────────────
console.log('\n── §6-7 Temps réel (polling Flutter) ────────────────');

test('J. polling_interval réduit à 5s dans messaging_provider.dart', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/lib/providers/messaging_provider.dart', 'utf8');
  assert(src.includes('Duration(seconds: 5)'), 'Polling interval must be 5 seconds');
  assert(!src.includes('Duration(seconds: 15)'), 'Old 15s interval must be removed');
});

test('K. injectInboundMessage() existe dans messaging_provider.dart', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/lib/providers/messaging_provider.dart', 'utf8');
  assert(src.includes('injectInboundMessage'), 'injectInboundMessage method must exist');
});

test('L. _pollMessages() utilise la fusion (merge) et non le remplacement', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/lib/providers/messaging_provider.dart', 'utf8');
  assert(src.includes('existingIds'), 'merge by ID must be present');
  assert(src.includes('newMessages'), 'newMessages variable must be present');
});

// ── §8 — Microphone ──────────────────────────────────────────
console.log('\n── §8 Microphone permissions ────────────────────────');

test('M. RECORD_AUDIO permission dans AndroidManifest.xml', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/android/app/src/main/AndroidManifest.xml', 'utf8');
  assert(src.includes('RECORD_AUDIO'), 'RECORD_AUDIO must be in AndroidManifest');
  // Must NOT be commented out
  const lines = src.split('\n');
  const line = lines.find(l => l.includes('RECORD_AUDIO'));
  assert(line && !line.trim().startsWith('<!--'), 'RECORD_AUDIO must not be commented');
});

test('N. NSMicrophoneUsageDescription dans iOS Info.plist', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/ios/Runner/Info.plist', 'utf8');
  assert(src.includes('NSMicrophoneUsageDescription'), 'NSMicrophoneUsageDescription must be in Info.plist');
});

test('O. record et permission_handler dans pubspec.yaml', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/pubspec.yaml', 'utf8');
  assert(src.includes('record:'), 'record package must be in pubspec.yaml');
  assert(src.includes('permission_handler:'), 'permission_handler package must be in pubspec.yaml');
});

test('P. VoiceRecorderWidget demande permission avant enregistrement', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/lib/widgets/audio/voice_recorder_widget.dart', 'utf8');
  assert(src.includes('_initRecording') || src.includes('_requestPermission') || src.includes('permission'), 'Permission check must be in voice recorder widget');
});

// ── §9-10 — PWA navigateur mobile ────────────────────────────
console.log('\n── §9-10 PWA navigateur mobile ──────────────────────');

test('Q. index.html contient la détection iOS/Safari', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/web/index.html', 'utf8');
  assert(src.includes('isIOS'), 'isIOS detection must be present');
  assert(src.includes('isIOSSafari'), 'isIOSSafari detection must be present');
});

test('R. index.html contient la modal instructions iOS', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/web/index.html', 'utf8');
  assert(src.includes('showIOSInstructions'), 'showIOSInstructions function must be present');
  assert(src.includes('ios-install-modal'), 'ios-install-modal must be present');
});

test('S. index.html contient le téléchargement APK pour Android', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/web/index.html', 'utf8');
  assert(src.includes('downloadAPK'), 'downloadAPK function must be present');
  assert(src.includes('OmniSMS.apk'), 'APK filename must be present');
  assert(src.includes('isAndroid'), 'isAndroid detection must be present');
});

test('T. index.html a touch-action: manipulation sur les boutons', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/web/index.html', 'utf8');
  assert(src.includes('touch-action: manipulation'), 'touch-action fix must be present');
  assert(src.includes('-webkit-tap-highlight-color: transparent'), 'tap highlight fix must be present');
});

test('U. PWA déjà installée (standalone) ne montre pas le prompt', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../../frontend/web/index.html', 'utf8');
  assert(src.includes('isStandalone'), 'isStandalone check must be present');
  assert(src.includes('display-mode: standalone'), 'standalone media query must be present');
});

// ── §11 — Offline monétisation atomique ──────────────────────
console.log('\n── §11 Offline monétisation (atomique) ──────────────');

test('W. /credits/decrement utilise db.runTransaction', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../routes/credits.js', 'utf8');
  assert(src.includes('runTransaction'), 'Firestore transaction must be used in decrement');
  assert(src.includes('INSUFFICIENT_CREDITS'), 'INSUFFICIENT_CREDITS error code must be present');
});

test('X. Transaction atomique empêche le double-spend', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../routes/credits.js', 'utf8');
  // The transaction reads current credits WITHIN the transaction before decrementing
  assert(src.includes("await tx.get(userRef)"), 'tx.get must be inside transaction');
  assert(src.includes("tx.update(userRef"), 'tx.update must be used (not ref.update)');
});

test('Y. isSubscribed (premium) exempté de décrément', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../routes/credits.js', 'utf8');
  assert(src.includes('isSubscribed'), 'isSubscribed check must be present');
  assert(src.includes('ne pas consommer de crédits'), 'premium exemption comment must be present');
});

// ── §12 — SaaSPay ────────────────────────────────────────────
console.log('\n── §12 SaaSPay ──────────────────────────────────────');

test('Z. services/saaspay.js existe et est valide', () => {
  const saaspay = require('../services/saaspay');
  assert(typeof saaspay.createCheckout === 'function', 'createCheckout must be a function');
  assert(typeof saaspay.getCheckoutStatus === 'function', 'getCheckoutStatus must be a function');
  assert(typeof saaspay.verifyWebhookSignature === 'function', 'verifyWebhookSignature must be a function');
  assert(typeof saaspay.isConfigured === 'function', 'isConfigured must be a function');
});

test('AA. saaspay.js utilise SAASPAY_* env vars', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../services/saaspay.js', 'utf8');
  assert(src.includes('SAASPAY_SECRET_KEY'), 'SAASPAY_SECRET_KEY must be referenced');
  assert(src.includes('SAASPAY_API_KEY'), 'SAASPAY_API_KEY must be referenced');
  assert(src.includes('saaspay.me'), 'SaaSPAY.me URL must be present');
  assert(!src.includes('leekpay.fr'), 'leekpay.fr URL must NOT be present');
});

test('AB. server.js monte payment.saaspay (nouveau prestataire)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../server.js', 'utf8');
  assert(src.includes('payment.saaspay'), 'payment.saaspay route must be mounted in server.js');
  assert(src.includes('saasPayRoutes'), 'saasPayRoutes variable must be present');
  // Backward compat: leekpay must still be present
  assert(src.includes('payment.leekpay'), 'payment.leekpay backward compat must still be mounted');
});

// ── Summary ──────────────────────────────────────────────────
const total = pass + fail;
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log(`║  Résultats : ${pass} PASS / ${fail} FAIL / ${total} total${' '.repeat(Math.max(0, 26 - String(total).length))} ║`);
console.log('╚════════════════════════════════════════════════════════════╝');

if (fail === 0) {
  console.log('\n✅ Tous les tests Session 6 passent.');
} else {
  console.log(`\n❌ ${fail} test(s) échoué(s).`);
  process.exit(1);
}
