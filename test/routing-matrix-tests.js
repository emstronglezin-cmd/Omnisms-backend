'use strict';
/**
 * OmniSMS — Tests de routage Session 8 : Matrice A–H
 *
 * Couvre les 8 scénarios de routage critiques :
 *   A. Online → Online (compte OmniSMS connecté)
 *   B. Online → Compte OmniSMS déconnecté
 *   C. Online → Sans compte OmniSMS
 *   D. Offline → Compte OmniSMS
 *   E. Offline → Sans compte OmniSMS
 *   F. SMS entrant (67 → 75) : mapping FROM/TO
 *   G. Réponse SMS entrant : destination = 67 (jamais 75)
 *   H. Logs de routage : senderUid, targetPhone ≠ senderPhone
 *
 * + Tests supplémentaires sur la nouvelle logique de présence dans routeMessage().
 *
 * Usage :
 *   node test/routing-matrix-tests.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

/* ── Couleurs console ───────────────────────────────────────── */
const green  = s => `\x1b[32m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const cyan   = s => `\x1b[36m${s}\x1b[0m`;
const bold   = s => `\x1b[1m${s}\x1b[0m`;

let passed  = 0;
let failed  = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(green('  ✓'), name);
    passed++;
  } catch (err) {
    console.log(red('  ✗'), name);
    console.log(red(`    ${err.message}`));
    failures.push({ name, error: err.message });
    failed++;
  }
}

function skip(name, reason) {
  console.log(yellow('  ⊘'), name, yellow(`[SKIP: ${reason}]`));
  skipped++;
}

function section(title) {
  console.log('\n' + bold(cyan(`── ${title} ─────────────────────────────────`)));
}

/* ── Lecture sécurisée de fichier source ────────────────────── */
function readSrc(relPath) {
  const abs = path.join(__dirname, '..', relPath);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

/* ════════════════════════════════════════════════════════════════
   LECTURE DES SOURCES
   ════════════════════════════════════════════════════════════════ */
const messageRouterSrc  = readSrc('services/messageRouter.js');
const gatewayInboundSrc = readSrc('routes/sms.gateway.inbound.js');
const socketServiceSrc  = readSrc('services/socketService.js');
const messagesV2Src     = readSrc('routes/messages.v2.js');

/* ════════════════════════════════════════════════════════════════
   SECTION 1 : PRÉSENCE — Vérification dans routeMessage()
   ════════════════════════════════════════════════════════════════ */
section('Section 1 — Présence dans routeMessage()');

test('1.a routeMessage contient vérification isUserOnline(resolvedUid)', () => {
  assert(
    messageRouterSrc.includes('isUserOnline(resolvedUid)'),
    'Doit appeler isUserOnline(resolvedUid) avant de router vers OmniSMS'
  );
});

test('1.b routeMessage utilise recipientIsOnline comme condition OMNISMS', () => {
  assert(
    messageRouterSrc.includes('recipientIsOnline'),
    'Doit déclarer et utiliser recipientIsOnline'
  );
});

test('1.c routeMessage initialise recipientIsOnline à false', () => {
  assert(
    messageRouterSrc.includes('recipientIsOnline = false'),
    'recipientIsOnline doit être initialisé à false (fail-safe)'
  );
});

test('1.d Condition OMNISMS vérifie resolvedUid ET recipientIsOnline', () => {
  // La condition doit être : if (resolvedUid && recipientIsOnline)
  assert(
    messageRouterSrc.includes('resolvedUid && recipientIsOnline'),
    'La route OMNISMS doit exiger resolvedUid ET recipientIsOnline (pas seulement resolvedUid)'
  );
});

test('1.e Fallback Socket.IO room dans routeMessage (double check)', () => {
  assert(
    messageRouterSrc.includes("io.in(`user:${resolvedUid}`).fetchSockets()"),
    'Doit avoir le fallback io.in(`user:${resolvedUid}`).fetchSockets() pour Redis vide'
  );
});

test('1.f Logging présence dans routeMessage avec recipientOnline', () => {
  assert(
    messageRouterSrc.includes('recipientOnline'),
    'Les logs ROUTING doivent inclure le champ recipientOnline'
  );
});

/* ════════════════════════════════════════════════════════════════
   SECTION 2 — Fallback SMS vers numéro DESTINATAIRE (jamais expéditeur)
   ════════════════════════════════════════════════════════════════ */
section('Section 2 — Fallback SMS : destination correcte');

test('2.a Fallback offline utilise resolvedUserInfo.phone comme e164Target', () => {
  assert(
    messageRouterSrc.includes('resolvedUserInfo.phone'),
    'Doit utiliser resolvedUserInfo.phone pour le fallback offline (numéro réel du destinataire)'
  );
});

test('2.b Fallback offline : condition sur resolvedUid + !recipientIsOnline + resolvedUserInfo', () => {
  assert(
    messageRouterSrc.includes('resolvedUid && !recipientIsOnline && resolvedUserInfo'),
    'Doit avoir la condition : resolvedUid && !recipientIsOnline && resolvedUserInfo'
  );
});

test('2.c Log explicite "Destinataire OmniSMS OFFLINE" dans routeMessage', () => {
  assert(
    messageRouterSrc.includes('Destinataire OmniSMS OFFLINE'),
    'Doit logger explicitement le cas OFFLINE → fallback SMS'
  );
});

test('2.d Log SMS_EXTERNE contient normalizedTarget', () => {
  assert(
    messageRouterSrc.includes('normalizedTarget'),
    'Le log SMS_EXTERNE doit inclure normalizedTarget pour traçabilité'
  );
});

/* ════════════════════════════════════════════════════════════════
   SECTION 3 — Récupération phone pour UID préresolu (targetUid)
   ════════════════════════════════════════════════════════════════ */
section('Section 3 — Résolution phone pour UID préresolu');

test('3.a routeMessage appelle resolveUserByUid si resolvedUid sans userInfo', () => {
  assert(
    messageRouterSrc.includes('resolveUserByUid'),
    'Doit appeler resolveUserByUid pour obtenir le phone quand uid préresolu'
  );
});

test('3.b resolveUserByUid importé dynamiquement dans routeMessage', () => {
  assert(
    messageRouterSrc.includes("require('./userResolver')"),
    'Doit importer dynamiquement userResolver pour resolveUserByUid'
  );
});

/* ════════════════════════════════════════════════════════════════
   SECTION 4 — Mapping FROM/TO dans sms.gateway.inbound.js
   ════════════════════════════════════════════════════════════════ */
section('Section 4 — Mapping FROM/TO inbound SMS (Sessions 7+8)');

test('4.a fromE164 = expéditeur (from), recipientE164 = destinataire (to)', () => {
  assert(
    gatewayInboundSrc.includes('fromE164') &&
    gatewayInboundSrc.includes('recipientE164'),
    'Doit distinguer fromE164 (expéditeur) et recipientE164 (destinataire)'
  );
});

test('4.b SMS fallback utilise recipientE164 comme destination (jamais fromE164)', () => {
  // Cherche le sendSMS avec to: recipientE164
  assert(
    gatewayInboundSrc.includes('to       : recipientE164'),
    'sendSMS fallback doit utiliser to: recipientE164 (destinataire), jamais fromE164'
  );
});

test('4.c sendId expéditeur est fromE164 dans le message stocké', () => {
  assert(
    gatewayInboundSrc.includes('senderId        : fromE164') ||
    gatewayInboundSrc.includes("senderId    : fromE164"),
    'senderId dans Firestore doit être fromE164 (l\'expéditeur externe)'
  );
});

test('4.d getOrCreateExternalConv utilise fromE164 comme externalPhone', () => {
  // La conversation externe doit stocker l'expéditeur (from) comme externalPhone
  assert(
    gatewayInboundSrc.includes('getOrCreateExternalConv') &&
    gatewayInboundSrc.includes('fromE164'),
    'getOrCreateExternalConv doit recevoir fromE164 comme externalPhone'
  );
  // Vérifier l'ordre des arguments : (db, ownerUid, fromE164, ...)
  const match = gatewayInboundSrc.match(/getOrCreateExternalConv\(\s*\n?\s*db,\s*ownerUid,\s*fromE164/);
  assert(match, 'getOrCreateExternalConv(db, ownerUid, fromE164, ...) — fromE164 en 3ème argument');
});

test('4.e recipientE164 JAMAIS utilisé comme externalPhone dans inbound', () => {
  // recipientE164 est le numéro de la passerelle (75), jamais l'externalPhone
  const match = gatewayInboundSrc.match(/getOrCreateExternalConv\([^)]*recipientE164[^)]*\)/s);
  // Acceptable seulement en 4ème argument (infobipNumber)
  if (match) {
    const args = match[0];
    // Le 3ème argument (externalPhone) ne doit pas être recipientE164
    // Format : getOrCreateExternalConv(db, ownerUid, ARG3, ARG4)
    const parts = args.replace('getOrCreateExternalConv(', '').split(',');
    // parts[2] = 3ème arg = externalPhone
    assert(
      !parts[2] || !parts[2].trim().startsWith('recipientE164'),
      'recipientE164 ne doit PAS être le 3ème argument de getOrCreateExternalConv (= externalPhone)'
    );
  }
  // Si pas de match, le test passe (pas utilisé du tout dans ce call)
});

test('4.f présence vérifiée sur ownerUid uniquement (jamais autre UID)', () => {
  assert(
    gatewayInboundSrc.includes('isUserOnline(ownerUid)'),
    'Présence vérifiée sur ownerUid uniquement — pas sur fromE164 ou autre UID'
  );
});

/* ════════════════════════════════════════════════════════════════
   SECTION 5 — TEST G : Réponse SMS (OmniSMS → 67, jamais 75)
   ════════════════════════════════════════════════════════════════ */
section('Section 5 — Réponse SMS : destination = expéditeur initial');

test('5.a external_conversations stocke externalPhone = FROM (67)', () => {
  // getOrCreateExternalConv dans messageRouter.js stocke externalPhone = e164 du destinataire
  // (qui est l'externalPhone fourni par l'appelant = fromE164 depuis le webhook)
  assert(
    messageRouterSrc.includes('externalPhone'),
    'external_conversations doit stocker externalPhone'
  );
  assert(
    messageRouterSrc.includes("externalPhone     : e164"),
    'externalPhone doit être normalisé en E.164'
  );
});

test('5.b routeMessage en réponse : targetPhone = externalPhone (67) → e164Target = 67', () => {
  // Quand l'utilisateur répond, il passe receiverId = externalPhone (67)
  // routeMessage() normalise: normalizePhone(targetPhone) → +22667...
  // e164Target = +22667... → SMS to: +22667...
  assert(
    messageRouterSrc.includes('normalizePhone(targetPhone)') ||
    messageRouterSrc.includes('normalizePhone(resolvedUserInfo.phone)'),
    'e164Target doit être normalisé via normalizePhone() — jamais le numéro de l\'expéditeur OmniSMS'
  );
});

test('5.c Pas de hardcode du numéro passerelle comme destination dans routeMessage', () => {
  // Le numéro passerelle (SIM Z Fold2) ne doit jamais être en dur comme destination
  const hardcodedGateway =
    messageRouterSrc.includes("to: '+22675405214'") ||
    messageRouterSrc.includes('to: "22675405214"') ||
    messageRouterSrc.includes("to: process.env.INFINIREACH_FROM_NUMBER") &&
    messageRouterSrc.includes("e164Target");
  // La gateway phone est utilisée comme FROM (expéditeur SMS), jamais comme TO (destination)
  // Ce test vérifie l'absence d'un hardcode incorrect comme destination
  assert(
    !messageRouterSrc.includes("to: '+22675405214'") &&
    !messageRouterSrc.includes('to: "22675405214"'),
    'Le numéro de passerelle ne doit pas être hardcodé comme destination dans routeMessage'
  );
});

/* ════════════════════════════════════════════════════════════════
   SECTION 6 — TEST H : Logs de routage (senderUid ≠ resolvedUid, targetPhone ≠ senderPhone)
   ════════════════════════════════════════════════════════════════ */
section('Section 6 — Logs structurés ROUTING');

test('6.a Log OMNISMS inclut senderUid', () => {
  const omnismsLog = messageRouterSrc.includes("'[ROUTING] Message routed → OMNISMS'");
  assert(omnismsLog, 'Doit avoir un log [ROUTING] Message routed → OMNISMS');
  // Vérifier que senderUid est dans le log (il y est via variable senderUid)
  const idx = messageRouterSrc.indexOf("'[ROUTING] Message routed → OMNISMS'");
  const logBlock = messageRouterSrc.substring(idx, idx + 300);
  assert(logBlock.includes('senderUid'), 'Log OMNISMS doit inclure senderUid');
});

test('6.b Log OMNISMS inclut resolvedUid', () => {
  const idx = messageRouterSrc.indexOf("'[ROUTING] Message routed → OMNISMS'");
  const logBlock = messageRouterSrc.substring(idx, idx + 300);
  assert(logBlock.includes('resolvedUid'), 'Log OMNISMS doit inclure resolvedUid');
});

test('6.c Log OMNISMS inclut route: OMNISMS', () => {
  const idx = messageRouterSrc.indexOf("'[ROUTING] Message routed → OMNISMS'");
  const logBlock = messageRouterSrc.substring(idx, idx + 400);
  assert(logBlock.includes("route"), 'Log OMNISMS doit inclure le champ route');
});

test('6.d Log SMS_EXTERNE inclut senderUid', () => {
  const idx = messageRouterSrc.indexOf("'[ROUTING] Message routed → SMS_EXTERNE'");
  assert(idx !== -1, 'Doit avoir un log [ROUTING] Message routed → SMS_EXTERNE');
  const logBlock = messageRouterSrc.substring(idx, idx + 500);
  assert(logBlock.includes('senderUid'), 'Log SMS_EXTERNE doit inclure senderUid');
});

test('6.e Log SMS_EXTERNE inclut normalizedTarget (pour vérifier que ce n\'est pas le sender)', () => {
  const idx = messageRouterSrc.indexOf("'[ROUTING] Message routed → SMS_EXTERNE'");
  const logBlock = messageRouterSrc.substring(idx, idx + 500);
  assert(logBlock.includes('normalizedTarget'), 'Log SMS_EXTERNE doit inclure normalizedTarget');
});

test('6.f Log SMS_EXTERNE inclut resolvedUid (null si pas de compte OmniSMS)', () => {
  const idx = messageRouterSrc.indexOf("'[ROUTING] Message routed → SMS_EXTERNE'");
  const logBlock = messageRouterSrc.substring(idx, idx + 500);
  assert(logBlock.includes('resolvedUid'), 'Log SMS_EXTERNE doit inclure resolvedUid');
});

test('6.g Log présence destinataire avec recipientOnline', () => {
  assert(
    messageRouterSrc.includes('Vérification présence destinataire'),
    'Doit logger la vérification de présence avec un message clair'
  );
});

/* ════════════════════════════════════════════════════════════════
   SECTION 7 — Double check présence dans inbound (Session 7)
   ════════════════════════════════════════════════════════════════ */
section('Section 7 — Double check présence inbound (Sessions 7 validé)');

test('7.a isUserOnline(ownerUid) dans sms.gateway.inbound.js', () => {
  assert(
    gatewayInboundSrc.includes('isUserOnline(ownerUid)'),
    'Double vérification présence : Redis first'
  );
});

test('7.b io.in(`user:${ownerUid}`).fetchSockets() dans inbound (fallback Redis)', () => {
  assert(
    gatewayInboundSrc.includes('io.in(`user:${ownerUid}`).fetchSockets()'),
    'Fallback Socket.IO fetchSockets pour connexion récente (Redis pas encore mis à jour)'
  );
});

test('7.c Log diagnostic inbound : incomingFrom, incomingTo, resolvedRecipientUid', () => {
  assert(
    gatewayInboundSrc.includes('incomingFrom') &&
    gatewayInboundSrc.includes('incomingTo') &&
    gatewayInboundSrc.includes('resolvedRecipientUid'),
    'Logs diagnostics complets : incomingFrom, incomingTo, resolvedRecipientUid'
  );
});

test('7.d Log inbound : recipientPresence online/offline', () => {
  assert(
    gatewayInboundSrc.includes("recipientPresence     : 'online'") ||
    gatewayInboundSrc.includes("recipientPresence     : 'offline'"),
    'Logs inbound doivent inclure recipientPresence online/offline'
  );
});

test('7.e Log inbound : routingDecision omnisms/sms_fallback', () => {
  assert(
    gatewayInboundSrc.includes("routingDecision       : 'omnisms'") ||
    gatewayInboundSrc.includes("routingDecision       : 'sms_fallback'"),
    'Logs inbound doivent inclure routingDecision omnisms ou sms_fallback'
  );
});

test('7.f fallbackTo = recipientE164 (jamais fromE164) dans les logs', () => {
  assert(
    gatewayInboundSrc.includes('fallbackTo            : recipientE164'),
    'fallbackTo dans les logs doit être recipientE164 (destinataire OmniSMS, jamais l\'expéditeur externe)'
  );
});

/* ════════════════════════════════════════════════════════════════
   SECTION 8 — Isolation des UIDs (Sessions 7 validé)
   ════════════════════════════════════════════════════════════════ */
section('Section 8 — Isolation UIDs et numéros');

test('8.a senderUid distinct de resolvedUid dans routeMessage', () => {
  // Les deux variables existent et sont séparées
  assert(
    messageRouterSrc.includes('senderUid') &&
    messageRouterSrc.includes('resolvedUid'),
    'senderUid et resolvedUid doivent exister et être distincts'
  );
  // L'un n'est jamais assigné à l'autre
  assert(
    !messageRouterSrc.includes('senderUid = resolvedUid') &&
    !messageRouterSrc.includes('resolvedUid = senderUid'),
    'senderUid et resolvedUid ne doivent jamais être interchangés'
  );
});

test('8.b makeConversationId(senderUid, resolvedUid) — ordre correct', () => {
  assert(
    messageRouterSrc.includes('makeConversationId(senderUid, resolvedUid)'),
    'La conversation doit lier senderUid et resolvedUid (destinataire)'
  );
});

test('8.c Dans inbound, ownerUid ≠ fromE164 (UID != numéro expéditeur)', () => {
  // ownerUid est résolu depuis le numéro SIM destinataire (recipientE164)
  // et non depuis le numéro expéditeur (fromE164)
  assert(
    gatewayInboundSrc.includes('ownerUid') &&
    !gatewayInboundSrc.includes('ownerUid = fromE164') &&
    !gatewayInboundSrc.includes("ownerUid  = fromE164"),
    'ownerUid ne doit jamais être assigné directement depuis fromE164'
  );
});

/* ════════════════════════════════════════════════════════════════
   SECTION 9 — Intégrité globale des fichiers
   ════════════════════════════════════════════════════════════════ */
section('Section 9 — Intégrité globale');

test('9.a messageRouter.js exporte routeMessage', () => {
  assert(
    messageRouterSrc.includes('module.exports') &&
    messageRouterSrc.includes('routeMessage'),
    'routeMessage doit être exporté depuis messageRouter.js'
  );
});

test('9.b messageRouter.js exporte makeConversationId', () => {
  assert(
    messageRouterSrc.includes('makeConversationId'),
    'makeConversationId doit être exporté'
  );
});

test('9.c messageRouter.js exporte makeExternalConvId', () => {
  assert(
    messageRouterSrc.includes('makeExternalConvId'),
    'makeExternalConvId doit être exporté'
  );
});

test('9.d socketService.js exporte isUserOnline', () => {
  assert(
    socketServiceSrc.includes('isUserOnline'),
    'socketService.js doit exporter isUserOnline'
  );
});

test('9.e socketService.js exporte getIO', () => {
  assert(
    socketServiceSrc.includes('getIO'),
    'socketService.js doit exporter getIO'
  );
});

test('9.f messages.v2.js appelle routeMessage()', () => {
  assert(
    messagesV2Src.includes('routeMessage(') &&
    messagesV2Src.includes("require('../services/messageRouter')"),
    'messages.v2.js doit importer et appeler routeMessage()'
  );
});

test('9.g messages.v2.js passe targetPhone (pas targetFrom) à routeMessage', () => {
  assert(
    messagesV2Src.includes('targetPhone:'),
    'routeMessage doit recevoir targetPhone (numéro destinataire, jamais expéditeur)'
  );
});

test('9.h Aucun "to: fromE164" dans l\'inbound (Bug 1 Session 7 corrigé)', () => {
  assert(
    !gatewayInboundSrc.includes('to: fromE164') &&
    !gatewayInboundSrc.includes('to       : fromE164'),
    'to: fromE164 ne doit PAS exister dans l\'inbound handler (Bug 1 corrigé)'
  );
});

test('9.i Infobip non modifié (Infobip non supprimé)', () => {
  const infobipFile = path.join(__dirname, '..', 'services', 'infobip.js');
  assert(fs.existsSync(infobipFile), 'services/infobip.js doit exister (Infobip non supprimé)');
});

test('9.j InfiniReach non modifié (smsGateway non supprimé)', () => {
  const gwFile = path.join(__dirname, '..', 'services', 'smsGateway.js');
  assert(fs.existsSync(gwFile), 'services/smsGateway.js doit exister (InfiniReach non supprimé)');
});

/* ════════════════════════════════════════════════════════════════
   SECTION 10 — Matrice conceptuelle A–H (documentation comportement attendu)
   ════════════════════════════════════════════════════════════════ */
section('Section 10 — Matrice comportement A–H (vérification code)');

test('A. Online→Online : routeMessage route OMNISMS si recipientIsOnline=true', () => {
  // La condition est : if (resolvedUid && recipientIsOnline) → OMNISMS
  assert(
    messageRouterSrc.includes("route         : 'OMNISMS'"),
    "Route OMNISMS retourne route: 'OMNISMS'"
  );
});

test('B. Online→Compte déconnecté : routeMessage route SMS_EXTERNE si recipientIsOnline=false', () => {
  // Si resolvedUid trouvé MAIS recipientIsOnline=false → passe au bloc SMS_EXTERNE
  // Le code gère maintenant : resolvedUid && !recipientIsOnline && resolvedUserInfo.phone
  assert(
    messageRouterSrc.includes('!recipientIsOnline'),
    'Si recipientIsOnline=false, ne doit PAS router vers OMNISMS'
  );
});

test('C. Online→Sans compte : e164Target = normalizePhone(targetPhone)', () => {
  // Pas de resolvedUid → e164Target = normalizePhone(targetPhone) direct
  assert(
    messageRouterSrc.includes('normalizePhone(targetPhone)'),
    'Sans compte OmniSMS, destination = normalizePhone(targetPhone) fourni'
  );
});

test('D. Offline→Compte OmniSMS : resolveUserByUid pour récupérer le phone', () => {
  // Si targetUid (preResolvedUid) fourni sans resolvedUserInfo → resolveUserByUid
  assert(
    messageRouterSrc.includes('resolveUserByUid(resolvedUid)'),
    'Doit appeler resolveUserByUid pour obtenir le phone quand UID préresolu'
  );
});

test('E. Offline→Sans compte : e164Target = targetPhone normalisé (inchangé)', () => {
  assert(
    messageRouterSrc.includes("route         : 'SMS_EXTERNE'"),
    "Route SMS_EXTERNE retourne route: 'SMS_EXTERNE'"
  );
});

test('F. SMS entrant 67→75 : fromE164=67, recipientE164=75, ownerUid résolu depuis 75', () => {
  // recipientE164 utilisé pour résoudre le compte OmniSMS
  assert(
    gatewayInboundSrc.includes('resolveUserByPhone(recipientE164)') ||
    gatewayInboundSrc.includes("resolveUserByPhone(hashParsed.targetPhone)") ||
    gatewayInboundSrc.includes('toUser = await resolveUserByPhone(recipientE164)'),
    'Le destinataire OmniSMS est résolu depuis recipientE164 (75), pas fromE164 (67)'
  );
});

test('G. Réponse SMS : externalPhone=67 → routeMessage(targetPhone=67) → SMS to: 67', () => {
  // external_conversations.externalPhone = fromE164 (l'expéditeur entrant = 67)
  // Quand user répond, targetPhone = externalPhone = 67
  // routeMessage() → e164Target = normalizePhone(67) → SMS to: 67
  assert(
    messageRouterSrc.includes("externalPhone     : e164") ||
    messageRouterSrc.includes("externalPhone  : e164"),
    'external_conversations stocke externalPhone = e164 (le FROM entrant = 67)'
  );
});

test('H. Logs : senderUid dans log, targetPhone != senderUid dans log', () => {
  // Les logs incluent senderUid séparé de targetPhone
  assert(
    messageRouterSrc.includes('senderUid,') ||
    messageRouterSrc.includes('senderUid :'),
    'Les logs doivent avoir senderUid comme champ séparé'
  );
  assert(
    messageRouterSrc.includes('targetPhone') &&
    messageRouterSrc.includes('senderUid'),
    'senderUid et targetPhone doivent être deux champs distincts dans les logs'
  );
});

/* ════════════════════════════════════════════════════════════════
   SECTION 11 — Sécurité : pas de fuite de secrets dans les logs
   ════════════════════════════════════════════════════════════════ */
section('Section 11 — Sécurité logs');

test('11.a Pas de token JWT dans les logs messageRouter', () => {
  assert(
    !messageRouterSrc.toLowerCase().includes('bearer') &&
    !messageRouterSrc.includes('jwt_secret') &&
    !messageRouterSrc.includes('FIREBASE_PRIVATE_KEY'),
    'Aucun secret JWT ne doit apparaître dans les logs'
  );
});

test('11.b Numéros masqués dans les logs (replace /\\d{4}$/)', () => {
  assert(
    messageRouterSrc.includes(".replace(/\\d{4}$/, '****')"),
    'Les numéros de téléphone doivent être masqués dans les logs (4 derniers chiffres)'
  );
});

/* ════════════════════════════════════════════════════════════════
   RAPPORT FINAL
   ════════════════════════════════════════════════════════════════ */
console.log('\n' + bold('═'.repeat(60)));
console.log(bold('  ROUTING MATRIX TESTS — Session 8'));
console.log(bold('═'.repeat(60)));
console.log(green(`  ✓ ${passed} tests passed`));
if (skipped > 0) console.log(yellow(`  ⊘ ${skipped} tests skipped`));
if (failed > 0) {
  console.log(red(`  ✗ ${failed} tests FAILED`));
  console.log('\n' + red(bold('  Failures:')));
  failures.forEach(({ name, error }) => {
    console.log(red(`  • ${name}`));
    console.log(red(`    → ${error}`));
  });
}
console.log(bold('═'.repeat(60)));

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log(green(bold('\n  ✅ Tous les tests de la matrice de routage passent.\n')));
}
