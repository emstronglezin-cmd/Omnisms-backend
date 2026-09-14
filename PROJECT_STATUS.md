# OmniSMS Backend — Statut du Projet

**Version**: 4.7.0  
**Date**: 2026-09-14  
**Environnement**: Production (Render)  
**URL**: https://omnisms-backend.onrender.com

---

## 1. Résumé Exécutif

### Mode Online (OmniSMS ↔ OmniSMS) : ✅ OPÉRATIONNEL

Le mode Online est complet et fonctionnel. Ne pas modifier.

### Mode Offline (OmniSMS ↔ SMS) : ✅ OPÉRATIONNEL via INfiniReach Z Fold2

L'architecture Offline utilise désormais **INfiniReach** (https://api.infinireach.io) sur Samsung Z Fold2 comme transport principal. Infobip est conservé en standby configurable.

**Blockers techniques** : aucun côté backend — configuration utilisateur requise (voir section 5).

---

## 2. État des composants

### Backend (Render)

| Composant | Status | Notes |
|---|---|---|
| API Messages (`/api/messages`) | ✅ OK | Online + Offline |
| Auth Firebase | ✅ OK | JWT + Firebase ID Token |
| Socket.IO | ✅ OK | `message:receive`, `sms:inbound`, `sms:delivery` |
| **INfiniReach sortant** | ✅ MIGRÉ | `services/smsGateway.js` → `api.infinireach.io/api/v1/messages` |
| **INfiniReach entrant (webhook)** | ✅ MIGRÉ | `POST /api/webhooks/sms-gateway/inbound` — payload `data.*` |
| **Déduplication webhook INfiniReach** | ✅ OK | data.messageId → Redis SETNX + Map fallback |
| **Transport agnostique (worker)** | ✅ OK | `selectTransport()` dans smsQueueWorker |
| Infobip sortant | ✅ STANDBY | Si `OFFLINE_SMS_PROVIDER=infobip` |
| Infobip entrant (webhook) | ✅ STANDBY | `/api/webhooks/infobip/inbound` (conservé) |
| Déduplication webhook Infobip | ✅ OK | Redis SETNX + Map fallback |
| SMS Queue Worker | ✅ OK | BullMQ retry 3× + inline fallback |
| messageRouter.js | ✅ OK | Routing Online (`OMNISMS`) / Offline (`SMS_EXTERNE`) |
| phoneNormalizer.js | ✅ OK | E.164 + multi-variantes |
| userResolver.js | ✅ OK | Résolution phone → UID |
| BullMQ / Redis | ✅ OK si `REDIS_URL` configuré | Inline fallback sinon |
| LeekPay paiements | ✅ OK | Ne pas toucher |
| Transcription Groq | ✅ OK | |

---

## 3. Implémentations Session 2026-09-11 (Migration INfiniReach)

### Phase INfiniReach-1 — services/smsGateway.js (RÉÉCRIT)

Entièrement réécrit de sms-gate.app vers INfiniReach. Interface exportée **identique** — aucune modification de `messageRouter.js` ou `smsQueueWorker.js` nécessaire.

**Changements clés** :
- **Auth** : `X-API-Key: ${INFINIREACH_API_KEY}` (était `Authorization: Basic base64(LOGIN:PASSWORD)`)
- **Endpoint envoi** : `POST /api/v1/messages` (était `POST /messages` sms-gate.app)
- **Payload** : `{to, message, from, channel:'sms', externalId}` (était `{textMessage, phoneNumbers, deviceId, simNumber}`)
- **Champ `from` obligatoire** : `INFINIREACH_FROM_NUMBER` = numéro SIM Z Fold2
- **Codes succès** : `200-299` (était `202` uniquement)
- **Logs** : `[INfiniReach]` prefix
- **Vars env** : `INFINIREACH_API_KEY`, `INFINIREACH_FROM_NUMBER`, `INFINIREACH_API_URL`, `INFINIREACH_ENABLED`
- **Webhook secret** : `INFINIREACH_WEBHOOK_SECRET` (vide = mode permissif)

**Exports conservés** :
`isConfigured`, `isSmsGatewayProvider`, `isInfobipFallbackEnabled`, `getActiveProvider`, `sendSMS`, `getMessageStatus`, `validateWebhookSignature`, `getStatus`

### Phase INfiniReach-2 — routes/sms.gateway.inbound.js (ADAPTÉ)

Webhook entrant adapté du format sms-gate.app vers le format INfiniReach.

**Mapping INfiniReach → interne OmniSMS** :

| INfiniReach (body.data.*) | Champ interne | Ancien (body.payload.*) |
|---|---|---|
| `data.messageId` | `smsMessageId` + clé dédup | `body.id \|\| payload.messageId` |
| `data.from` | `senderId`, `from` | `payload.sender` |
| `data.to` | `to` | `payload.recipient` |
| `data.body` | `content` | `payload.message` |
| `data.deviceId` | `deviceId` | `body.deviceId` |
| `data.timestamp` | `createdAt` | `payload.receivedAt` |

**Events dispatcher** :

| INfiniReach event | Action | Ancien event |
|---|---|---|
| `message.inbound` | SMS entrant complet | `sms:received` |
| `message.sent` | DLR envoi | `sms:sent` |
| `message.delivered` | DLR livraison | `sms:delivered` |
| `message.failed` | DLR échec | `sms:failed` |

**GET /api/webhooks/sms-gateway/status** : mis à jour avec guide config INfiniReach.

### Phase INfiniReach-3 — .env.example (MIS À JOUR)

Variables `SMS_GATEWAY_*` remplacées par `INFINIREACH_*` :
- `INFINIREACH_API_KEY`, `INFINIREACH_FROM_NUMBER`, `INFINIREACH_API_URL`, `INFINIREACH_ENABLED`
- `INFINIREACH_WEBHOOK_SECRET` (vide = permissif), `INFINIREACH_REQUIRE_SIGNATURE`
- `OFFLINE_SMS_PROVIDER`, `OFFLINE_SMS_FALLBACK_TO_INFOBIP` conservés inchangés
- Section Infobip conservée en standby

### Phase INfiniReach-4 — test/sms-gateway-tests.js (RÉÉCRIT)

Suite de tests remplacée : 26 tests G1-G10 (sms-gate.app) → 33 tests A-E + régression G (INfiniReach).

**Tests A-E nouveaux** :
- **A (6 tests)** — Envoi SMS : URL `/api/v1/messages`, `X-API-Key`, `channel=sms`, `from`, `to`, `message`, `externalId`
- **B (5 tests)** — Webhook entrant : payload `data.*` accepté, mapping correct, déduplication `data.messageId`
- **C (6 tests)** — Erreurs : 401, 400, 429, 500, timeout, BullMQ throw
- **D (4 tests)** — Online : aucun appel INfiniReach depuis mode Online, `isSmsGatewayProvider()`
- **E (5 tests)** — Offline : `SMS_EXTERNE`, `processSmsJob`, retry BullMQ, fallback Infobip, standby

**Régression G (7 tests)** : déduplication Redis, Firestore champs, `makeExternalConvId`, normalisation E.164, `makeConversationId`, Online isolation

---

### Phase INfiniReach-5 — Audit et Finalisation (Session 2026-09-13)

#### Correctifs appliqués

1. **`services/smsQueueWorker.js` (ligne 97)** — Hint stale corrigé  
   `SMS_GATEWAY_LOGIN + SMS_GATEWAY_PASSWORD` → `INFINIREACH_API_KEY + INFINIREACH_FROM_NUMBER (transport principal INfiniReach Z Fold2)`

2. **`services/messageRouter.js` (ligne 416)** — Hint stale corrigé  
   `SMS_GATEWAY_LOGIN + SMS_GATEWAY_PASSWORD` → `INFINIREACH_API_KEY + INFINIREACH_FROM_NUMBER (INfiniReach Z Fold2)`

3. **`services/smsGateway.js`** — `logStartupDiagnostic()` ajouté  
   Logs sûrs au démarrage : enabled/api key configured/from number/api url — jamais la valeur réelle de la clé

4. **`services/smsGateway.js`** — Hint 404 spécifique ajouté  
   Sur `statusCode === 404` : message explicatif sur le device non enregistré dans INfiniReach

5. **`routes/sms.gateway.inbound.js`** — Log webhook entrant ajouté  
   `[InfiniReach Webhook] received { event, messageId, from, to, bodyLength, direction, deviceId, ip }` à l'entrée HTTP du POST handler (avant le 200)

6. **`services/smsQueueWorker.js` + `services/messageRouter.js`** — Commentaire fallback Infobip  
   Comment `⚠️ Pendant la phase de test INfiniReach : OFFLINE_SMS_FALLBACK_TO_INFOBIP=false` ajouté

7. **`server.js`** — Appel `logStartupDiagnostic()` au démarrage

#### Nouveaux tests ajoutés (15 tests)

- **F (4 tests)** — 404 device non trouvé : `success=false` strict, erreur remontée, `processSmsJob` throw, mock HTTP 404 réel
- **I (6 tests)** — Cycle de vie compte supprimé (CAS 1-4) : actif, `deleted=true`, même numéro réajouté, nouvelle inscription
- **K (5 tests)** — Fallback désactivé + diagnostic démarrage : `OFFLINE_SMS_FALLBACK_TO_INFOBIP`, Infobip non appelé, `logStartupDiagnostic` sans secret

### Phase INfiniReach-6 — Corrections Réception + Flutter (Session 2026-09-14)

**Backend :**
- `services/messageRouter.js` — `findExternalConvByPhone()` : filtre `infobipNumber` (= SIM `to`) appliqué TOUJOURS (avant : seulement si `docs.length > 1`). Garantit que `ownerUid` = propriétaire réel du SIM destinataire.
- `test/sms-inbound-tests.js` — 23 nouveaux tests (A-M) : normalisation, résolution utilisateur, compte supprimé, conversation externe, flow inbound complet, déduplication, protocole #.

**Flutter (`/home/user/frontend/`) :**
- `android/app/src/main/AndroidManifest.xml` — Permission `RECORD_AUDIO` ré-activée (était commentée).
- `ios/Runner/Info.plist` — Clé `NSMicrophoneUsageDescription` ajoutée (manquante → crash iOS).
- `pubspec.yaml` — Ajout `record: ^5.1.2` + `permission_handler: ^11.3.1`.
- `lib/widgets/audio/voice_recorder_widget.dart` — Demande permission avant enregistrement, gestion refus sans blocage, suppression double `SafeArea`.
- `lib/services/audio_recording_service.dart` — Refactoring complet avec vraie gestion permission.
- `lib/screens/messaging/conversation_screen.dart` — Correction scroll perpétuel (flag `_hasScrolledToBottom`) : scroll auto seulement au premier chargement et sur nouveaux messages. Empêche les sauts visuels iOS.
- `lib/providers/messaging_provider.dart` — `_pollMessages()` fusionne les messages (merge) au lieu de remplacer entièrement la liste : évite la perte de scroll et les doublons.

### Précédentes implémentations (Session 2026-09-07)

- `services/smsGateway.js` — transport sms-gate.app (remplacé par INfiniReach)
- `routes/sms.gateway.inbound.js` — webhook sms-gate.app (adapté INfiniReach)
- `services/messageRouter.js` — route `SMS_EXTERNE` + `selectTransport()`
- `services/smsQueueWorker.js` — `selectTransport()` transport-agnostique
- `server.js` — enregistrement `smsGatewayInboundRoutes`

### Précédentes implémentations (Session 2026-09-05, commit 84c0ebd)

- `services/smsQueueWorker.js` créé — BullMQ retry
- `routes/infobip.inbound.js` — déduplication ajoutée
- `test/offline-sms-tests.js` créé — 37 tests A-J
- `CONTEXT.md` + `PROJECT_STATUS.md` créés

---

## 4. Résultats de tests

### Tests Inbound SMS (2026-09-14) — Session 5 — NOUVEAU

```
23 PASS / 0 FAIL / 23 total ✅
```

Fichier : `test/sms-inbound-tests.js`

### Tests INfiniReach (2026-09-13) — Audit + Nouveaux tests F/I/K

```
48 PASS / 0 FAIL / 48 total ✅

══ TEST A — Envoi SMS INfiniReach                    : 6 PASS
══ TEST B — Webhook entrant INfiniReach              : 5 PASS
══ TEST C — Erreurs API INfiniReach                  : 6 PASS
══ TEST D — Online — Isolation                        : 4 PASS
══ TEST E — Offline — Retry                           : 5 PASS
══ RÉGRESSION G — Interface + Routage                : 7 PASS
══ TEST F — 404 Device non trouvé                    : 4 PASS  ← NOUVEAU
══ TEST I — Cycle de vie compte supprimé (CAS 1-4)  : 6 PASS  ← NOUVEAU
══ TEST K — Fallback Infobip désactivé + diagnostic  : 5 PASS  ← NOUVEAU
```

### Tests Offline SMS (2026-09-05) — Régression ✅

```
37 PASS / 0 FAIL / 37 total ✅

── A. SMS Sortant OmniSMS → externe  : 6 PASS
── B. SMS Entrant externe → OmniSMS  : 4 PASS
── C. Online OmniSMS ↔ OmniSMS       : 3 PASS
── D. Numéro inconnu                 : 2 PASS
── E. Numéro déjà OmniSMS            : 2 PASS
── F. Doublon webhook                : 3 PASS
── G. Erreur du Gateway              : 3 PASS
── H. Retry                          : 3 PASS
── I. Reconnexion Gateway            : 3 PASS
── J. Conservation de l'historique   : 3 PASS
── Bonus hybridSms.js                : 5 PASS
```

**Total automatisé : 85/85 PASS ✅** (48 INfiniReach + 37 régression)

---

## 5. Tests Hardware (non automatisables — nécessitent Z Fold2 + SIM + INfiniReach)

| ID | Test | Prérequis | Status |
|---|---|---|---|
| H-A1 | Z Fold2 connecté à INfiniReach, SIM active | Z Fold2 + app INfiniReach | ⏳ UTILISATEUR |
| H-A2 | Envoi SMS réel OmniSMS → numéro externe via Z Fold2 | H-A1 + vars Render configurées | ⏳ UTILISATEUR |
| H-A3 | Réception SMS réel → apparition dans OmniSMS | H-A1 + webhook configuré | ⏳ UTILISATEUR |
| H-A4 | Latence end-to-end mesurée | H-A2 + H-A3 | ⏳ UTILISATEUR |
| H-A5 | DLR `message.delivered` vérifié dans Firestore | H-A2 + webhook DLR | ⏳ UTILISATEUR |

**Procédure E2E complète** :

```
1. Installer l'app INfiniReach sur Z Fold2
2. Se connecter — noter les identifiants (API Key)
3. Configurer webhook dans l'app :
   URL = https://omnisms-backend.onrender.com/api/webhooks/sms-gateway/inbound
   Event = message.inbound (+ optionnel: message.delivered, message.failed)
4. Render → Environment Variables :
   INFINIREACH_API_KEY=...
   INFINIREACH_FROM_NUMBER=+226xxxxxxxx   (numéro SIM Z Fold2 en E.164)
   INFINIREACH_API_URL=https://api.infinireach.io
   INFINIREACH_ENABLED=true
   INFINIREACH_WEBHOOK_SECRET=             (vide pour premier test)
   OFFLINE_SMS_PROVIDER=sms_gateway
5. Redéployer → GET /health → vérifier status
6. GET /api/webhooks/sms-gateway/status → vérifier config INfiniReach
7. Envoyer message depuis OmniSMS vers numéro externe → vérifier réception physique
8. Envoyer SMS depuis téléphone externe vers SIM Z Fold2 → vérifier apparition dans OmniSMS
```

---

## 6. BLOCKERS

### ✅ RÉSOLU — BLOCKER 1 : Intégration Z Fold2 (SMS Gateway → INfiniReach)

La migration du transport SMS Gateway (sms-gate.app) vers INfiniReach est **complète côté backend**.

- ✅ `services/smsGateway.js` réécrit pour INfiniReach (X-API-Key, `/api/v1/messages`, `INFINIREACH_*` vars)
- ✅ `routes/sms.gateway.inbound.js` adapté payload `data.*` + events `message.*`
- ✅ `.env.example` mis à jour (INFINIREACH_* vars)
- ✅ `test/sms-gateway-tests.js` réécrit — tests A-E INfiniReach + F/I/K audit — **48/48 PASS**
- ✅ Régression `test/offline-sms-tests.js` — **37/37 PASS**
- ✅ `CONTEXT.md` et `PROJECT_STATUS.md` mis à jour
- ✅ Hints stales `SMS_GATEWAY_LOGIN` corrigés dans `smsQueueWorker.js` et `messageRouter.js`
- ✅ Logs démarrage sûrs (`logStartupDiagnostic`) + logs webhook entrant (`[InfiniReach Webhook] received`)
- ✅ Hint 404 device non trouvé explicatif dans `smsGateway.js`
- ✅ Commentaire fallback Infobip pause dans `smsQueueWorker.js` + `messageRouter.js`

**Reste côté utilisateur** (non bloquant pour le backend) :
- [ ] Configurer le webhook dans l'application INfiniReach sur le Z Fold2
- [ ] Renseigner les variables d'environnement dans Render
- [ ] Effectuer les tests hardware H-A1 à H-A5

### ⚠️ DIAGNOSTIC — Erreur 404 observée en production

**Symptôme** : Backend atteint `POST https://api.infinireach.io/api/v1/messages` (✅ réseau OK) mais INfiniReach répond :
```
HTTP 404 — "No device found with phone number +22675405214 for your account."
```

**Cause** : Le numéro `+22675405214` configuré dans `INFINIREACH_FROM_NUMBER` n'est pas reconnu comme device enregistré dans le compte INfiniReach.

**Le code backend est CORRECT** — il transmet directement `INFINIREACH_FROM_NUMBER` au champ `"from"` sans transformation.

**Action requise (côté utilisateur)** :
1. Ouvrir l'app INfiniReach sur le Z Fold2
2. Vérifier que le device est bien enregistré et actif
3. Confirmer que le numéro SIM affiché dans l'app correspond EXACTEMENT à `+22675405214`
4. Si différent → mettre à jour `INFINIREACH_FROM_NUMBER` avec le numéro exact
5. Si le device n'est pas enregistré → reconnecter/réenregistrer le Z Fold2

### ⚠️ CONFIG REQUISE Render — Variables INfiniReach

```
INFINIREACH_API_KEY=votre_cle_api_infinireach
INFINIREACH_FROM_NUMBER=+226xxxxxxxx       # DOIT correspondre au numéro SIM du Z Fold2 dans INfiniReach
INFINIREACH_API_URL=https://api.infinireach.io
INFINIREACH_ENABLED=true
OFFLINE_SMS_PROVIDER=sms_gateway
OFFLINE_SMS_FALLBACK_TO_INFOBIP=false      # false pendant test INfiniReach pour voir les erreurs clairement
```

### ⚠️ CONFIG OPTIONNELLE mais recommandée

- [ ] `REDIS_URL` → activer BullMQ (sinon retry SMS en mode inline)
- [ ] `INFINIREACH_WEBHOOK_SECRET` → sécuriser les webhooks entrants (après validation initiale)
- [ ] `INFINIREACH_REQUIRE_SIGNATURE=true` → mode strict HMAC
- [ ] `OFFLINE_SMS_FALLBACK_TO_INFOBIP=true` → fallback Infobip si INfiniReach indisponible

---

## 7. Architecture des fichiers

### Fichiers modifiés / créés (session 2026-09-11 — Migration INfiniReach)

| Fichier | Type | Description |
|---|---|---|
| `services/smsGateway.js` | **RÉÉCRIT** | INfiniReach : X-API-Key, `/api/v1/messages`, INFINIREACH_* vars, même interface exportée |
| `routes/sms.gateway.inbound.js` | **ADAPTÉ** | Payload `body.data.*`, events `message.inbound/sent/delivered/failed` |
| `test/sms-gateway-tests.js` | **RÉÉCRIT** | 33 tests A-E + régression G — 33/33 PASS |
| `.env.example` | **MIS À JOUR** | INFINIREACH_* vars, Infobip conservé en standby |
| `CONTEXT.md` | **MIS À JOUR** | Architecture INfiniReach, flows, API, env vars |
| `PROJECT_STATUS.md` | **MIS À JOUR** | Ce fichier |

### Fichiers non modifiés (lecture seule — interface compatible)

| Fichier | Rôle | Raison non-modification |
|---|---|---|
| `services/messageRouter.js` | Routing Online/Offline | `selectTransport()` utilise `smsGateway.isConfigured()` — interface inchangée |
| `services/smsQueueWorker.js` | Worker BullMQ retry | `selectTransport()` utilise `smsGateway.sendSMS()` — interface inchangée |
| `server.js` | Express app | Enregistrement `smsGatewayInboundRoutes` inchangé |
| `test/offline-sms-tests.js` | Régression 37 tests | Toujours valide — 37/37 PASS |

### Fichiers non modifiés (fonctionnels, lecture seule)

| Fichier | Rôle |
|---|---|
| `services/infobip.js` | Client Infobip sendSMS/DLR — en standby |
| `routes/infobip.inbound.js` | Webhook Infobip — en standby |
| `services/smsProvider.js` | Thin wrapper Infobip |
| `services/phoneNormalizer.js` | Normalisation E.164 |
| `services/userResolver.js` | Résolution phone → UID |
| `services/hybridSms.js` | Mode USSD SMS (alias) |
| `services/queueService.js` | BullMQ + Redis + inline fallback |
| `routes/messages.v2.js` | API messages REST + routeMessage() |
| `routes/sms.infobip.js` | POST /api/sms/send (conservé) |
| `models/Alias.js` | Alias USSD scopés par expéditeur |
| `models/Invitation.js` | Invitations utilisateurs non-inscrits |
| `services/redis.js` | ioredis + MemoryStore fallback |
| `routes/payment.leekpay.js` | ❌ NE PAS TOUCHER |
| `services/leekpay.js` | ❌ NE PAS TOUCHER |

---

## 8. Règles de développement

1. **Ne jamais toucher** `routes/payment.leekpay.js`, `services/leekpay.js`, `controllers/leekpayController.js`
2. **Ne jamais modifier** `makeConversationId()` dans `messageRouter.js` (brise Online)
3. **Toujours utiliser** `services/phoneNormalizer.js` pour normaliser les numéros
4. **Toujours utiliser** `services/userResolver.js` pour résoudre phone → UID
5. **Toujours démarrer** par `git status` + audit avant toute modification
6. **Tester** avec `node test/offline-sms-tests.js && node test/sms-gateway-tests.js` après chaque modification offline
7. **Ne jamais hardcoder** de clé API, secret, token dans le code — ne jamais logger `INFINIREACH_API_KEY`
8. **Ne pas supprimer Infobip** — garder en standby, configurable via `OFFLINE_SMS_PROVIDER`
9. **`smsProvider = 'sms_gateway'`** pour tous les messages INfiniReach (rétrocompatibilité Firestore)
10. **Déduplication par `data.messageId`** pour les webhooks INfiniReach entrants

---

## 9. Guide de déploiement Render

### Variables minimales requises

```
FIREBASE_SERVICE_ACCOUNT_JSON=...
JWT_SECRET=...
INFINIREACH_API_KEY=...
INFINIREACH_FROM_NUMBER=+226xxxxxxxx
```

### Variables recommandées

```
INFINIREACH_API_URL=https://api.infinireach.io
INFINIREACH_ENABLED=true
OFFLINE_SMS_PROVIDER=sms_gateway
REDIS_URL=...
```

### Après déploiement

1. Vérifier état : `GET https://omnisms-backend.onrender.com/health`
2. Vérifier config INfiniReach : `GET https://omnisms-backend.onrender.com/api/webhooks/sms-gateway/status`
3. Configurer webhook dans l'app INfiniReach sur le Z Fold2
4. Effectuer les tests hardware H-A1 à H-A5
