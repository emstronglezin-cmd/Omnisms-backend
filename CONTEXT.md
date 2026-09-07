# OmniSMS — Architecture et Contexte Technique

**Version**: 4.4.0  
**Date mise à jour**: 2026-09-07  
**Backend URL**: https://omnisms-backend.onrender.com

---

## 1. Vue d'ensemble

OmniSMS est une plateforme de messagerie hybride permettant :
- La messagerie **en temps réel** entre utilisateurs OmniSMS (mode Online, Socket.IO)
- La messagerie **SMS classique** vers/depuis des numéros non-inscrits (mode Offline, **SMS Gateway Z Fold2**)
- La **transcription audio** (Groq Whisper)
- Les **paiements** Premium (LeekPay Mobile Money)

**Transport Offline par défaut** : **SMS Gateway for Android™** (sms-gate.app, capcom6) installé sur Samsung Z Fold2  
**Transport Offline en standby** : Infobip (conservé, configurable via `OFFLINE_SMS_PROVIDER`)

---

## 2. Architecture globale

```
┌──────────────────────────────────────────────────────────────────────┐
│                          CLIENTS                                     │
│  PWA (Frontend Vercel) │ Flutter Android │ SMS classique             │
└───────────┬────────────┴────────┬─────────┴──────────────────────────┘
            │                    │                        │
            │ REST + Socket.IO   │ REST                   │ via SIM
            ▼                    ▼                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   BACKEND OMNISMS (Render)                            │
│                    Express.js v4.21 / Node 18+                       │
│                                                                      │
│  routes/messages.v2.js ──▶ services/messageRouter.js                │
│        │                         │                                   │
│        │              ┌──────────┴──────────────┐                   │
│        │         resolveUserByPhone()       normalizePhone()         │
│        │              │                          │                   │
│        │         ┌────▼────┐             ┌───────▼──────┐           │
│        │         │OMNISMS  │             │ SMS_EXTERNE  │           │
│        │         │(Online) │             │   (Offline)  │           │
│        │         └────┬────┘             └───────┬──────┘           │
│        │           Socket.IO                     │                   │
│        │                               ┌─────────▼────────┐         │
│        │                               │ selectTransport()│         │
│        │                               └────┬────────┬────┘         │
│        │                          sms_gateway   infobip(standby)    │
│        │                               │            │               │
│        │                    services/smsGateway.js  services/infobip.js
│        │                               │            │               │
│        │                               ▼            ▼               │
│        │                    api.sms-gate.app   api.infobip.com      │
│        │                               │                            │
│        │                          Samsung Z Fold2                   │
│        │                               │                            │
│        │                              SIM → réseau SMS              │
│        │                                                            │
│  routes/sms.gateway.inbound.js  ◀── POST /api/webhooks/sms-gateway/inbound
│    (webhook SMS entrant Z Fold2 + déduplication HMAC)               │
│                                                                      │
│  routes/infobip.inbound.js ◀── (EN STANDBY)                         │
│    POST /api/webhooks/infobip/inbound (conservé, non supprimé)      │
│                                                                      │
│  services/queueService.js + smsQueueWorker.js                        │
│    (BullMQ retry 3×, inline fallback sans Redis)                     │
│    smsQueueWorker.selectTransport() → sms_gateway | infobip          │
│                                                                      │
│  services/firebase.js → Firestore (messages, external_conversations) │
└──────────────────────────────────────────────────────────────────────┘
            │                    │
            ▼                    ▼
     Google Firestore     SMS Gateway Cloud API
     (persistence)        api.sms-gate.app/3rdparty/v1
```

---

## 3. Mode Online (OmniSMS ↔ OmniSMS)

**Flux** :  
OmniSMS user A → `POST /api/messages/send` → `messageRouter.routeMessage()` → `resolveUserByPhone()` → UID trouvé → Firestore `messages` + `Socket.IO emitToUser()`

**ConversationId** :  
`[UID_A, UID_B].sort().join('-')` — déterministe, jamais de numéro de téléphone

**Règle** : Ne jamais modifier ce flux. Il est fonctionnel.

---

## 4. Mode Offline (OmniSMS ↔ SMS externe) — Transport SMS Gateway Z Fold2

### 4.1 Flux sortant (OmniSMS → numéro externe)

```
OmniSMS user
   ↓ POST /api/messages/send { receiverId: "phone_number" }
messageRouter.routeMessage()
   ↓ resolveUserByPhone(phone) → { found: false }
   ↓ makeExternalConvId(ownerUid, e164) → "ext-{ownerUid}-{e164}"
   ↓ getOrCreateExternalConv(db, ownerUid, e164) → Firestore external_conversations
   ↓ db.collection('messages').add({ channel: 'sms', status: 'pending' })
   ↓ selectTransport() → { provider: 'sms_gateway', send: smsGateway.sendSMS }
   ↓ smsGateway.sendSMS({ to, text: "[OmniSMS] Nom : contenu", messageId })
     → POST https://api.sms-gate.app/3rdparty/v1/messages
     → Authorization: Basic base64(SMS_GATEWAY_LOGIN:SMS_GATEWAY_PASSWORD)
     → Body: { textMessage: { text }, phoneNumbers: [to], deviceId, simNumber }
     → Réponse 202: { id: "gw-xxx", state: "Pending" }
   ↓ succès → update status='sent', smsMessageId=gatewayMessageId, smsProvider='sms_gateway'
   ↓ échec → enqueueSmsJob() → BullMQ retry 3×, backoff exponentiel 3s/9s/27s
   ↓ [si OFFLINE_SMS_FALLBACK_TO_INFOBIP=true] → fallback Infobip avant retry queue

retour: { route: 'SMS_EXTERNE', transport: 'sms_gateway', conversationId, messageId, smsResult }
```

**ConversationId externe** : `ext-{ownerUid}-{e164Phone}` (stable, unique par propriétaire OmniSMS)

**Texte SMS** : `[OmniSMS] {senderDisplay} : {content}` (format inchangé)

### 4.2 Sélection du transport (selectTransport)

```javascript
// Dans messageRouter.js et smsQueueWorker.js
if (OFFLINE_SMS_PROVIDER === 'sms_gateway' && SMS_GATEWAY_LOGIN && SMS_GATEWAY_PASSWORD) {
  transport = 'sms_gateway'   // → smsGateway.sendSMS()
} else if (INFOBIP_API_KEY && INFOBIP_BASE_URL) {
  transport = 'infobip'       // → infobip.sendSMS() (standby)
}
```

### 4.3 Flux entrant (SMS reçu sur Z Fold2 → OmniSMS)

```
numéro externe
   ↓ SMS → SIM dans Samsung Z Fold2
   ↓ SMS Gateway for Android™ détecte le SMS entrant
   ↓ POST https://omnisms-backend.onrender.com/api/webhooks/sms-gateway/inbound
     Headers: X-Timestamp: epoch_ms, X-Signature: HMAC-SHA256(rawBody+X-Timestamp, signingKey)
     Body: {
       deviceId: "zfold2-xxx",
       event: "sms:received",
       id: "Ey6ECg...",          ← eventId pour déduplication
       webhookId: "LreFUt...",
       payload: {
         messageId: "abc123",
         message: "Bonjour!",
         sender: "+22670000000",
         recipient: "+22600000000",
         simNumber: 1,
         receivedAt: "2024-06-22T..."
       }
     }
routes/sms.gateway.inbound.js
   ↓ 1. validateWebhookSignature() → HMAC-SHA256(rawBody+X-Timestamp, SMS_GATEWAY_WEBHOOK_SECRET)
       Anti-replay: |now - X-Timestamp| < 5 min
       Si SMS_GATEWAY_REQUIRE_SIGNATURE=false → lax mode (non bloquant si signature absente)
   ↓ 2. Réponse 200 immédiate (empêche les retries Gateway)
   ↓ 3. Async: isAlreadyProcessed(eventId) → skip si doublon
       Redis SETNX TTL 24h OU Map mémoire (omnisms:gateway:dedup:{eventId})
   ↓ 4. event === 'sms:received' ou 'sms:batch:received' → traitement inbound
   ↓ 5. findExternalConvByPhone(sender) → ownerUid depuis external_conversations
       OU parseHashPrefix(message) → ownerUid si SMS préfixé '#'
       OU resolveUserByPhone(recipient) → ownerUid depuis numéro SIM
   ↓ 6. getOrCreateExternalConv(db, ownerUid, senderE164)
   ↓ 7. db.collection('messages').add({
         direction: 'inbound', channel: 'sms',
         smsProvider: 'sms_gateway', deviceId, simNumber
       })
   ↓ 8. emitToUser(ownerUid, 'message:receive', payload)
       Si ownerUid offline → message en Firestore, récupéré à la reconnexion

   Autres events traités:
   ↓ 'sms:sent' / 'sms:delivered' / 'sms:failed' / 'sms:cancelled'
       → updateDeliveryStatus(gatewayMessageId, status)
```

**Déduplication** : clé `omnisms:gateway:dedup:{eventId}` — Redis SETNX TTL 24h + Map mémoire fallback  
**Retry Gateway** : jusqu'à 14 retries avec backoff exponentiel (départ 10s) → déduplication critique

---

## 5. SMS Gateway for Android™ — API

**Application** : SMS Gateway for Android™ par capcom6  
**GitHub** : https://github.com/capcom6/android-sms-gateway  
**Docs API** : https://docs.sms-gate.app  
**Cloud API URL** : `https://api.sms-gate.app/3rdparty/v1`  
**Compatibilité Render** : ✅ accessible depuis internet (cloud API)

### Authentification
```
Authorization: Basic base64(SMS_GATEWAY_LOGIN:SMS_GATEWAY_PASSWORD)
```

### Envoi SMS
```
POST /3rdparty/v1/messages
Content-Type: application/json
Authorization: Basic ...

{
  "textMessage": { "text": "[OmniSMS] Alice : Bonjour!" },
  "phoneNumbers": ["+22670000000"],
  "deviceId": "zfold2-device-id",    // SMS_GATEWAY_DEVICE_ID
  "simNumber": 1,                     // SMS_GATEWAY_SIM_NUMBER
  "ttl": 3600,
  "id": "omnisms-msg-xxx"             // idempotence
}

→ 202 Accepted: { "id": "gw-xxx", "state": "Pending" }
```

### Statut message
```
GET /3rdparty/v1/messages/{id}
→ { "id": "gw-xxx", "state": "Sent"|"Delivered"|"Failed" }
```

### Webhook entrant (sms:received)
```
POST {BACKEND_URL}/api/webhooks/sms-gateway/inbound
X-Timestamp: 1719059123456
X-Signature: sha256=abc...

{
  "deviceId": "...",
  "event": "sms:received",
  "id": "Ey6ECg...",
  "webhookId": "LreFUt...",
  "payload": {
    "messageId": "abc123",
    "message": "Bonjour!",
    "sender": "+22670000000",
    "recipient": "+22600000000",
    "simNumber": 1,
    "receivedAt": "2024-06-22T14:30:00Z"
  }
}
```

### Signature HMAC
```
X-Signature = HMAC-SHA256(rawBody + X-Timestamp, SMS_GATEWAY_WEBHOOK_SECRET)
Anti-replay : |Date.now() - X-Timestamp| < 300 000 ms (5 min)
```

---

## 6. Système de routage (messageRouter.js)

**Décision de routage** :

| Destinataire | Route | Transport | Action |
|---|---|---|---|
| UID OmniSMS connu | `OMNISMS` | — | Firestore + Socket.IO |
| Numéro non trouvé dans OmniSMS | `SMS_EXTERNE` | `sms_gateway` (défaut) | Firestore + SMS Gateway Z Fold2 |
| Numéro non trouvé (si sms_gateway non dispo) | `SMS_EXTERNE` | `infobip` (standby) | Firestore + Infobip API |

**Retour routeMessage()** :
```javascript
{ route: 'SMS_EXTERNE', transport: 'sms_gateway'|'infobip', conversationId, messageId, smsResult, message }
// ou
{ route: 'OMNISMS', conversationId, messageId, message }
```

**Résolution** : `services/userResolver.js` → `resolveUserByPhone(phone)` → variantes E.164 → Firestore `users`

**Normalisation** : `services/phoneNormalizer.js` → librairie `phone` npm → E.164 robuste avec fallback simple

---

## 7. Résilience et Queue

**Composants** :
- `services/queueService.js` : BullMQ + Redis, fallback inline si Redis absent
- `services/smsQueueWorker.js` : Worker SMS avec `selectTransport()` (transport-agnostic)
- `services/redis.js` : ioredis + MemoryStore fallback automatique

**selectTransport() dans le worker** :
```javascript
function selectTransport() {
  const gw = getSmsGateway();
  if (gw && gw.isSmsGatewayProvider() && gw.isConfigured())
    return { provider: 'sms_gateway', send: (opts) => gw.sendSMS(opts) };
  const ib = getInfobip();
  if (ib && ib.isConfigured())
    return { provider: 'infobip', send: ({ to, text }) => ib.sendSMS({ to, text }) };
  return null;
}
```

**Fallback Gateway → Infobip** (si `OFFLINE_SMS_FALLBACK_TO_INFOBIP=true`) :
- Si Gateway échoue → tente Infobip immédiatement avant d'entrer en queue BullMQ

**Déduplication inbound** :
- Redis SETNX avec TTL 24h (si Redis disponible)
- Map mémoire fallback (non distribué, OK pour instance unique Render)

**Retry outbound** :
- Si `sendSMS()` échoue → `enqueueSmsJob()` → BullMQ `sms` queue
- JobId = `sms-{messageId}` → idempotent si messageId défini

---

## 8. Conversations externes (Firestore)

**Collection** : `external_conversations`

```
{
  conversationId    : "ext-{ownerUid}-{e164Phone}",
  ownerUid          : "UID_OMNISMS",
  externalPhone     : "+22670000000",
  externalName      : "Jean Dupont" | null,
  infobipNumber     : "+22600000000" | null,   // conservé pour compatibilité
  channel           : "sms",
  createdAt         : ISO8601,
  updatedAt         : ISO8601,
  lastMessageAt     : ISO8601,
  lastMessage       : "...",
  providerMessageIds: [],  // IDs Gateway/Infobip pour DLR
}
```

**Collection** : `messages` (messages individuels, OmniSMS + SMS)

```
{
  conversationId: "ext-{ownerUid}-{e164}" | "{uid1}-{uid2}",
  senderId      : "UID" | "+22670000000",
  receiverId    : "UID" | "+22670000000",
  content       : "texte",
  channel       : "sms" | "app",
  direction     : "inbound" | "outbound" | null,
  status        : "pending" | "sent" | "delivered" | "failed",
  smsMessageId  : "gw-xxx" | "infobip-id" | null,
  smsProvider   : "sms_gateway" | "infobip" | null,   // NOUVEAU — quel transport
  deviceId      : "zfold2-xxx" | null,                // NOUVEAU — device SMS Gateway
  simNumber     : 1 | null,                           // NOUVEAU — SIM utilisée
  createdAt     : ISO8601,
}
```

---

## 9. Mode hybride SMS USSD (hybridSms.js)

Permet à des utilisateurs **sans smartphone** d'utiliser OmniSMS via SMS USSD :

- `*NOM NUMERO message` → Premier message, enregistre alias
- `*NOM message` → Message suivant, résout alias
- `#NOM NUMERO message` → Identique avec préfixe `#`
- `DÉMARRER` / `START` → Instructions d'inscription

**Webhook** : `POST /sms/hybrid/incoming` (Africa's Talking, Twilio, Orange)

---

## 10. Endpoints clés

| Méthode | URL | Authentification | Description |
|---|---|---|---|
| POST | `/api/messages/send` | Firebase JWT | Envoyer message (Online ou Offline) |
| GET | `/api/messages` | Firebase JWT | Lister conversations (OmniSMS + SMS) |
| GET | `/api/messages/:convId` | Firebase JWT | Historique conversation |
| POST | `/api/webhooks/sms-gateway/inbound` | HMAC opt. | **SMS entrant Z Fold2 (principal)** |
| GET | `/api/webhooks/sms-gateway/status` | Aucune | Statut webhook SMS Gateway |
| POST | `/api/webhooks/infobip/inbound` | HMAC opt. | SMS entrant Infobip (standby) |
| GET | `/api/webhooks/infobip/inbound/status` | Aucune | Statut webhook Infobip |
| POST | `/api/sms/send` | Firebase JWT | SMS direct via Infobip |
| GET | `/api/sms/infobip/status` | Aucune | Statut Infobip |
| GET | `/health` | Aucune | Santé backend |

---

## 11. Variables d'environnement (Render)

### SMS Gateway Z Fold2 (Transport principal Offline)

| Variable | Requis | Défaut | Description |
|---|---|---|---|
| `SMS_GATEWAY_LOGIN` | **OUI** | — | Login compte sms-gate.app |
| `SMS_GATEWAY_PASSWORD` | **OUI** | — | Mot de passe compte sms-gate.app |
| `SMS_GATEWAY_DEVICE_ID` | recommandé | — | Device ID du Z Fold2 (depuis l'app) |
| `SMS_GATEWAY_API_URL` | non | `https://api.sms-gate.app/3rdparty/v1` | URL API cloud |
| `SMS_GATEWAY_WEBHOOK_SECRET` | recommandé | — | Clé HMAC pour valider les webhooks |
| `SMS_GATEWAY_SIM_NUMBER` | non | `1` | Numéro de SIM à utiliser sur le Z Fold2 |
| `SMS_GATEWAY_REQUIRE_SIGNATURE` | non | `false` | Bloquer si signature HMAC absente/invalide |
| `OFFLINE_SMS_PROVIDER` | non | `sms_gateway` | `sms_gateway` ou `infobip` |
| `OFFLINE_SMS_FALLBACK_TO_INFOBIP` | non | `false` | Fallback automatique sur Infobip si Gateway échoue |

### Infobip (Transport Offline EN STANDBY)

| Variable | Requis | Description |
|---|---|---|
| `INFOBIP_API_KEY` | si standby | Clé API Infobip |
| `INFOBIP_BASE_URL` | si standby | URL Infobip (ex: `xxx.api.infobip.com`) |
| `INFOBIP_SENDER_ID` | non | Nom expéditeur (défaut: `OmniSMS`) |
| `INFOBIP_WEBHOOK_SECRET` | optionnel | HMAC secret webhook Infobip |

### Commun

| Variable | Requis | Description |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **OUI** | JSON service account Firebase |
| `JWT_SECRET` | **OUI** | Secret JWT pour authentification |
| `REDIS_URL` | optionnel | Redis pour BullMQ (fallback inline si absent) |
| `RENDER_EXTERNAL_URL` | non | URL backend (défaut: `https://omnisms-backend.onrender.com`) |
| `DEFAULT_PHONE_COUNTRY` | non | Code pays défaut normalisation (défaut: `BF`) |

---

## 12. Configuration Z Fold2 (actions utilisateur)

### Dans l'application SMS Gateway for Android™

1. **Créer un compte** sur https://sms-gate.app → noter `Login` et `Password`
2. **Connecter le Z Fold2** → noter le `Device ID` affiché dans l'app
3. **Configurer le webhook** dans Settings → Webhooks :
   - URL : `https://omnisms-backend.onrender.com/api/webhooks/sms-gateway/inbound`
   - Events : `sms:received` (et optionnellement `sms:sent`, `sms:delivered`, `sms:failed`)
   - Signing Key : générer une clé → copier dans `SMS_GATEWAY_WEBHOOK_SECRET`

### Dans Render (variables d'environnement)

```
SMS_GATEWAY_LOGIN=votre_login
SMS_GATEWAY_PASSWORD=votre_password
SMS_GATEWAY_DEVICE_ID=votre_device_id_zfold2
SMS_GATEWAY_WEBHOOK_SECRET=votre_signing_key_hmac
OFFLINE_SMS_PROVIDER=sms_gateway
```

---

## 13. Règles absolues

1. **Ne pas toucher au système de paiement** (`routes/payment.leekpay.js`, `services/leekpay.js`)
2. **Ne pas casser le mode Online** (`makeConversationId`, `routeMessage` branche OMNISMS)
3. **Ne pas réécrire ce qui fonctionne** — étendre, corriger, compléter
4. **Toujours utiliser `process.env` pour les secrets** — jamais de hardcode
5. **Valider les webhooks** avec HMAC si `SMS_GATEWAY_WEBHOOK_SECRET` configuré
6. **Déduplication systématique** des webhooks entrants (Redis ou Map mémoire)
7. **Normaliser les numéros** via `phoneNormalizer.normalizePhone()` systématiquement
8. **Ne pas supprimer Infobip** — conserver en standby, activable via `OFFLINE_SMS_PROVIDER=infobip`
9. **Ne pas inventer d'API** — utiliser uniquement les endpoints documentés officiellement
