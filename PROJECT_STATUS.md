# OmniSMS Backend — Statut du Projet

**Version**: 4.4.0  
**Date**: 2026-09-07  
**Environnement**: Production (Render)  
**URL**: https://omnisms-backend.onrender.com

---

## 1. Résumé Exécutif

### Mode Online (OmniSMS ↔ OmniSMS) : ✅ OPÉRATIONNEL

Le mode Online est complet et fonctionnel. Ne pas modifier.

### Mode Offline (OmniSMS ↔ SMS) : ✅ OPÉRATIONNEL via SMS Gateway Z Fold2

L'architecture Offline utilise désormais **SMS Gateway for Android™** (sms-gate.app) sur Samsung Z Fold2 comme transport principal. Infobip est conservé en standby configurable.

**Blockers techniques** : aucun côté backend — configuration utilisateur requise (voir section 5).

---

## 2. État des composants

### Backend (Render)

| Composant | Status | Notes |
|---|---|---|
| API Messages (`/api/messages`) | ✅ OK | Online + Offline |
| Auth Firebase | ✅ OK | JWT + Firebase ID Token |
| Socket.IO | ✅ OK | `message:receive`, `sms:inbound`, `sms:delivery` |
| **SMS Gateway sortant** | ✅ NOUVEAU | `services/smsGateway.js` → `api.sms-gate.app` |
| **SMS Gateway entrant (webhook)** | ✅ NOUVEAU | `POST /api/webhooks/sms-gateway/inbound` |
| **Déduplication webhook Gateway** | ✅ NOUVEAU | HMAC + Redis SETNX + Map fallback |
| **Transport agnostique (worker)** | ✅ NOUVEAU | `selectTransport()` dans smsQueueWorker |
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

## 3. Implémentations Session 2026-09-07 (SMS Gateway Z Fold2)

### Phase 3 — services/smsGateway.js (NOUVEAU)

Service dédié pour SMS Gateway for Android™ (sms-gate.app, capcom6).

**Exports** :
- `isConfigured()` — vérifie `SMS_GATEWAY_LOGIN` + `SMS_GATEWAY_PASSWORD`
- `isSmsGatewayProvider()` — vérifie `OFFLINE_SMS_PROVIDER === 'sms_gateway'`
- `isInfobipFallbackEnabled()` — vérifie `OFFLINE_SMS_FALLBACK_TO_INFOBIP === 'true'`
- `sendSMS({ to, text, messageId, ttl, withDeliveryReport })` — POST api.sms-gate.app/3rdparty/v1/messages
- `validateWebhookSignature(req)` — HMAC-SHA256(rawBody + X-Timestamp, signingKey) + anti-replay 5 min
- `getMessageStatus(gatewayMessageId)` — GET /3rdparty/v1/messages/{id}
- `getStatus()` — objet de santé pour health check

**Auth** : `Authorization: Basic base64(LOGIN:PASSWORD)`

### Phase 4 — services/messageRouter.js (MODIFIÉ)

Section 3 (route Offline) refactorisée :
- Avant : `route: 'INFOBIP'`, appel direct `infobip.sendSMS()`
- Après : `route: 'SMS_EXTERNE'` avec `transport: 'sms_gateway'|'infobip'`
- `selectTransport()` détermine le provider selon `OFFLINE_SMS_PROVIDER`
- Support fallback Gateway → Infobip si `OFFLINE_SMS_FALLBACK_TO_INFOBIP=true`
- Champ `smsProvider` ajouté dans Firestore

### Phase 5 — services/smsQueueWorker.js (MODIFIÉ)

Worker SMS rendu transport-agnostique :
- Avant : appel hardcodé `getInfobip().sendSMS()`
- Après : `selectTransport()` → `sms_gateway` ou `infobip` selon configuration
- Support fallback Gateway → Infobip dans le worker
- `smsProvider` mis à jour dans Firestore après envoi

### Phase 6 — routes/sms.gateway.inbound.js (NOUVEAU)

Webhook SMS entrant pour SMS Gateway Z Fold2 :
- `POST /api/webhooks/sms-gateway/inbound` — handler principal
- `GET /api/webhooks/sms-gateway/status` — health check + guide config
- Signature HMAC avec anti-replay (±5 min)
- Réponse 200 immédiate (évite les 14 retries Gateway)
- Déduplication par `eventId` (Redis SETNX TTL 24h + Map)
- Events traités : `sms:received`, `sms:batch:received`, `sms:sent`, `sms:delivered`, `sms:failed`
- Champs ajoutés Firestore : `smsProvider`, `deviceId`, `simNumber`

### Phase 6 — server.js (MODIFIÉ)

```javascript
// Nouveau :
const smsGatewayInboundRoutes = require('./routes/sms.gateway.inbound');
app.use('/api/webhooks', smsGatewayInboundRoutes);
```

### Phase 8 — .env.example (MODIFIÉ)

9 nouvelles variables SMS Gateway ajoutées. Section Infobip relabellée "(EN STANDBY)".

### Phase 9 — test/sms-gateway-tests.js (NOUVEAU)

26 tests automatisés G1-G10. **26/26 PASS ✅**

### Précédentes implémentations (Session 2026-09-05, commit 84c0ebd)

- `services/smsQueueWorker.js` créé — BullMQ retry
- `routes/infobip.inbound.js` — déduplication ajoutée
- `test/offline-sms-tests.js` créé — 37 tests A-J
- `CONTEXT.md` + `PROJECT_STATUS.md` créés

---

## 4. Résultats de tests

### Tests SMS Gateway (2026-09-07) — NOUVEAU

```
26 PASS / 0 FAIL / 26 total ✅

── G1. Backend → SMS Gateway          : 3 PASS
── G2. SMS Gateway accepte l'envoi   : 2 PASS
── G3. Erreur Gateway (4xx/5xx)      : 2 PASS
── G4. Timeout Gateway               : 2 PASS
── G5. Retry BullMQ                  : 3 PASS
── G6. Doublon webhook entrant       : 3 PASS
── G7. SMS entrant → Firestore       : 2 PASS
── G8. Rattachement conversation     : 3 PASS
── G9. Normalisation E.164           : 3 PASS
── G10. Online OmniSMS non impacté   : 3 PASS
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

**Total automatisé : 63/63 PASS ✅**

---

## 5. Tests Hardware (non automatisables — nécessitent Z Fold2 + SIM)

| ID | Test | Prérequis | Status |
|---|---|---|---|
| H-G1 | Z Fold2 connecté à sms-gate.app, SIM active | Z Fold2 + compte sms-gate.app | ⏳ UTILISATEUR |
| H-G2 | Envoi SMS réel OmniSMS → numéro externe via Z Fold2 | H-G1 + vars Render configurées | ⏳ UTILISATEUR |
| H-G3 | Réception SMS réel → apparition dans OmniSMS | H-G1 + webhook configuré | ⏳ UTILISATEUR |
| H-G4 | Latence end-to-end mesurée | H-G2 + H-G3 | ⏳ UTILISATEUR |
| H-G5 | DLR `sms:delivered` vérifié dans Firestore | H-G2 + webhook events | ⏳ UTILISATEUR |

**Procédure E2E complète** (voir CONTEXT.md section 12 pour la configuration détaillée) :

```
1. App SMS Gateway → créer compte → noter Login/Password
2. Connecter Z Fold2 → noter Device ID
3. Configurer webhook dans l'app :
   URL = https://omnisms-backend.onrender.com/api/webhooks/sms-gateway/inbound
   Events = sms:received (+ autres optionnel)
   Signing Key = générer → copier dans SMS_GATEWAY_WEBHOOK_SECRET
4. Render → Environment Variables :
   SMS_GATEWAY_LOGIN=...
   SMS_GATEWAY_PASSWORD=...
   SMS_GATEWAY_DEVICE_ID=...
   SMS_GATEWAY_WEBHOOK_SECRET=...
   OFFLINE_SMS_PROVIDER=sms_gateway
5. Redéployer → GET /health → vérifier status
6. Envoyer message depuis OmniSMS vers numéro externe → vérifier réception physique
7. Envoyer SMS depuis téléphone externe vers SIM Z Fold2 → vérifier apparition dans OmniSMS
```

---

## 6. BLOCKERS

### ✅ RÉSOLU — BLOCKER 1 : Intégration Z Fold2

L'intégration du Samsung Z Fold2 comme transport SMS physique est **implémentée côté backend**.
- ✅ `services/smsGateway.js` créé
- ✅ `routes/sms.gateway.inbound.js` créé
- ✅ `messageRouter.js` modifié (route `SMS_EXTERNE`)
- ✅ `smsQueueWorker.js` modifié (`selectTransport()`)

**Reste côté utilisateur** (non bloquant pour le backend) :
- [ ] Configurer le webhook dans l'application SMS Gateway for Android™ sur le Z Fold2
- [ ] Renseigner les variables d'environnement dans Render
- [ ] Effectuer les tests hardware H-G1 à H-G5

### ⚠️ CONFIG REQUISE Render — Variables SMS Gateway

```
SMS_GATEWAY_LOGIN=votre_login_sms_gateway
SMS_GATEWAY_PASSWORD=votre_password_sms_gateway
SMS_GATEWAY_DEVICE_ID=votre_device_id_zfold2
SMS_GATEWAY_WEBHOOK_SECRET=votre_signing_key_hmac
OFFLINE_SMS_PROVIDER=sms_gateway
```

### ⚠️ CONFIG OPTIONNELLE mais recommandée

- [ ] `REDIS_URL` → activer BullMQ (sinon les retry SMS s'exécutent en mode inline)
- [ ] `SMS_GATEWAY_REQUIRE_SIGNATURE=true` → mode strict HMAC
- [ ] `OFFLINE_SMS_FALLBACK_TO_INFOBIP=true` → fallback Infobip si Gateway indisponible

---

## 7. Architecture des fichiers

### Fichiers modifiés / créés (session 2026-09-07)

| Fichier | Type | Description |
|---|---|---|
| `services/smsGateway.js` | **CRÉÉ** | Service SMS Gateway for Android™ — sendSMS, validateWebhookSignature, health |
| `routes/sms.gateway.inbound.js` | **CRÉÉ** | Webhook entrant Z Fold2 — HMAC, dedup, sms:received, DLR |
| `test/sms-gateway-tests.js` | **CRÉÉ** | 26 tests G1-G10 automatisés — 26/26 PASS |
| `services/messageRouter.js` | **MODIFIÉ** | Offline route → `SMS_EXTERNE` + `selectTransport()` + fallback |
| `services/smsQueueWorker.js` | **MODIFIÉ** | `selectTransport()` transport-agnostique + fallback Infobip |
| `server.js` | **MODIFIÉ** | Import + registration `smsGatewayInboundRoutes` |
| `.env.example` | **MODIFIÉ** | 9 nouvelles vars SMS Gateway + Infobip relabellé standby |
| `routes/infobip.inbound.js` | **MODIFIÉ** | Résolution conflict merge (dedup + INFOBIP_REQUIRE_SIGNATURE) |
| `CONTEXT.md` | **MIS À JOUR** | Architecture SMS Gateway, API, flux, vars env |
| `PROJECT_STATUS.md` | **MIS À JOUR** | Ce fichier |

### Fichiers modifiés (session 2026-09-05, commit 84c0ebd)

| Fichier | Type | Description |
|---|---|---|
| `services/smsQueueWorker.js` | **CRÉÉ** | Worker BullMQ SMS retry + enqueueSmsJob() |
| `routes/infobip.inbound.js` | **MODIFIÉ** | Déduplication isAlreadyProcessed() + getRedis() |
| `services/messageRouter.js` | **MODIFIÉ** | Retry via enqueueSmsJob() si sendSMS échec |
| `server.js` | **MODIFIÉ** | Démarrage SMS worker au boot |
| `test/offline-sms-tests.js` | **CRÉÉ** | 37 tests A-J mode Offline |
| `CONTEXT.md` | **CRÉÉ** | Architecture complète |
| `PROJECT_STATUS.md` | **CRÉÉ** | Ce fichier |

### Fichiers non modifiés (fonctionnels, lecture seule)

| Fichier | Rôle |
|---|---|
| `services/infobip.js` | Client Infobip sendSMS/DLR — en standby |
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
7. **Ne jamais hardcoder** de clé API, secret, token dans le code
8. **Ne pas supprimer Infobip** — garder en standby, configurable via `OFFLINE_SMS_PROVIDER`

---

## 9. Guide de déploiement Render

### Variables minimales requises

```
FIREBASE_SERVICE_ACCOUNT_JSON=...
JWT_SECRET=...
SMS_GATEWAY_LOGIN=...
SMS_GATEWAY_PASSWORD=...
```

### Variables recommandées

```
SMS_GATEWAY_DEVICE_ID=...
SMS_GATEWAY_WEBHOOK_SECRET=...
OFFLINE_SMS_PROVIDER=sms_gateway
REDIS_URL=...
```

### Après déploiement

1. Vérifier état : `GET https://omnisms-backend.onrender.com/health`
2. Vérifier config Gateway : `GET https://omnisms-backend.onrender.com/api/webhooks/sms-gateway/status`
3. Configurer webhook dans l'app SMS Gateway for Android™ sur le Z Fold2
4. Effectuer les tests hardware H-G1 à H-G5
