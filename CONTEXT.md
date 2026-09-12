# OmniSMS — Architecture et Contexte Technique

**Version**: 4.5.0  
**Date mise à jour**: 2026-09-11  
**Backend URL**: https://omnisms-backend.onrender.com

---

## 1. Vue d'ensemble

OmniSMS est une plateforme de messagerie hybride permettant :
- La messagerie **en temps réel** entre utilisateurs OmniSMS (mode Online, Socket.IO)
- La messagerie **SMS classique** vers/depuis des numéros non-inscrits (mode Offline, **INfiniReach Z Fold2**)
- La **transcription audio** (Groq Whisper)
- Les **paiements** Premium (LeekPay Mobile Money)

**Transport Offline par défaut** : **INfiniReach** (https://api.infinireach.io) installé sur Samsung Z Fold2  
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
│        │                    api.infinireach.io  api.infobip.com      │
│        │                    POST /api/v1/messages                   │
│        │                    X-API-Key: ${INFINIREACH_API_KEY}        │
│        │                               │                            │
│        │                          Samsung Z Fold2                   │
│        │                               │                            │
│        │                              SIM → réseau SMS              │
│        │                                                            │
│  routes/sms.gateway.inbound.js  ◀── POST /api/webhooks/sms-gateway/inbound
│    (webhook SMS entrant INfiniReach + déduplication)                 │
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
     Google Firestore     INfiniReach Cloud API
     (persistence)        api.infinireach.io
```

---

## 3. Mode Online (OmniSMS ↔ OmniSMS)

**Flux** :  
OmniSMS user A → `POST /api/messages/send` → `messageRouter.routeMessage()` → `resolveUserByPhone()` → UID trouvé → Firestore `messages` + `Socket.IO emitToUser()`

**ConversationId** :  
`[UID_A, UID_B].sort().join('-')` — déterministe, jamais de numéro de téléphone

**Règle** : Ne jamais modifier ce flux. Il est fonctionnel.

---

## 4. Mode Offline (OmniSMS ↔ SMS externe) — Transport INfiniReach Z Fold2

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
     → POST https://api.infinireach.io/api/v1/messages
     → X-API-Key: ${INFINIREACH_API_KEY}
     → Content-Type: application/json
     → Body: {
         "to"         : "+22670000000",
         "message"    : "[OmniSMS] Alice : Bonjour!",
         "from"       : "${INFINIREACH_FROM_NUMBER}",   // numéro SIM Z Fold2, obligatoire
         "channel"    : "sms",
         "externalId" : "omnisms-{messageId}"           // idempotence
       }
     → Réponse 200/201/202: { id: "ir-xxx", status: "queued"|"sent" }
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
if (OFFLINE_SMS_PROVIDER === 'sms_gateway' && INFINIREACH_API_KEY && INFINIREACH_FROM_NUMBER) {
  transport = 'sms_gateway'   // → smsGateway.sendSMS() via INfiniReach
} else if (INFOBIP_API_KEY && INFOBIP_BASE_URL) {
  transport = 'infobip'       // → infobip.sendSMS() (standby)
}
```

### 4.3 Flux entrant (SMS reçu sur Z Fold2 → OmniSMS)

```
numéro externe
   ↓ SMS → SIM dans Samsung Z Fold2
   ↓ App INfiniReach détecte le SMS entrant
   ↓ POST https://omnisms-backend.onrender.com/api/webhooks/sms-gateway/inbound
     Headers: [X-Signature optionnel si INFINIREACH_WEBHOOK_SECRET configuré]
     Body: {
       "event"     : "message.inbound",
       "timestamp" : "2024-06-22T15:46:11.000Z",
       "data"      : {
         "messageId" : "ir-msg-abc123",        ← clé de déduplication
         "direction" : "inbound",
         "from"      : "+22670000000",          ← expéditeur
         "to"        : "+22600000000",          ← numéro SIM Z Fold2
         "body"      : "Bonjour!",             ← texte
         "deviceId"  : "zfold2-xxx",
         "timestamp" : "2024-06-22T15:46:11.000Z",
         "status"    : "delivered"
       }
     }

routes/sms.gateway.inbound.js
   ↓ 1. validateWebhookSignature() → HMAC-SHA256 si INFINIREACH_WEBHOOK_SECRET configuré
       Sans secret → mode permissif (accepte tout — cas initial INfiniReach)
   ↓ 2. Réponse 200 immédiate (empêche les retries INfiniReach)
   ↓ 3. Async: isAlreadyProcessed(data.messageId) → skip si doublon
       Redis SETNX TTL 24h OU Map mémoire (omnisms:gateway:dedup:{messageId})
   ↓ 4. event === 'message.inbound' → traitement inbound complet
   ↓ 5. Mapping INfiniReach → OmniSMS :
       data.messageId  → smsMessageId (dédup)
       data.from       → expéditeur, normalisé E.164
       data.to         → destinataire = numéro SIM
       data.body       → texte SMS
       data.deviceId   → deviceId
       data.timestamp  → createdAt
   ↓ 6. findExternalConvByPhone(sender) → ownerUid depuis external_conversations
       OU parseHashPrefix(body) → ownerUid si SMS préfixé '#'
       OU resolveUserByPhone(to) → ownerUid depuis numéro SIM
   ↓ 7. getOrCreateExternalConv(db, ownerUid, senderE164)
   ↓ 8. db.collection('messages').add({
         direction: 'inbound', channel: 'sms',
         smsProvider: 'sms_gateway', deviceId
       })
   ↓ 9. emitToUser(ownerUid, 'message:receive', payload)
       Si ownerUid offline → message en Firestore, récupéré à la reconnexion

   Events DLR traités :
   ↓ 'message.sent'      → updateDeliveryStatus(data, db) → status='sent'
   ↓ 'message.delivered' → updateDeliveryStatus(data, db) → status='delivered'
   ↓ 'message.failed'    → updateDeliveryStatus(data, db) → status='failed'
```

**Déduplication** : clé `omnisms:gateway:dedup:{data.messageId}` — Redis SETNX TTL 24h + Map mémoire fallback  
**Retry INfiniReach** : plusieurs retries possibles → déduplication par `data.messageId` critique

---

## 5. INfiniReach — API

**Fournisseur** : INfiniReach  
**App Z Fold2** : Application Android INfiniReach (Z Fold2 enregistré et connecté)  
**API URL** : `https://api.infinireach.io`  
**Compatibilité Render** : ✅ accessible depuis internet

### Authentification
```
X-API-Key: ${INFINIREACH_API_KEY}
Content-Type: application/json
```

### Envoi SMS
```
POST https://api.infinireach.io/api/v1/messages
X-API-Key: ${INFINIREACH_API_KEY}
Content-Type: application/json

{
  "to"         : "+22670000000",
  "message"    : "[OmniSMS] Alice : Bonjour!",
  "from"       : "${INFINIREACH_FROM_NUMBER}",   // numéro SIM Z Fold2, OBLIGATOIRE
  "channel"    : "sms",
  "externalId" : "omnisms-msg-xxx"               // idempotence
}

→ 200/201/202: { "id": "ir-xxx", "status": "queued"|"sent", ... }
```

### Statut message
```
GET https://api.infinireach.io/api/v1/messages/{id}
X-API-Key: ${INFINIREACH_API_KEY}
→ { "id": "ir-xxx", "status": "sent"|"delivered"|"failed" }
```

### Webhook entrant (message.inbound)
```
POST {BACKEND_URL}/api/webhooks/sms-gateway/inbound
[X-Signature: optionnel si INFINIREACH_WEBHOOK_SECRET configuré]

{
  "event"     : "message.inbound",
  "timestamp" : "2024-06-22T15:46:11.000Z",
  "data"      : {
    "messageId" : "ir-msg-abc123",
    "direction" : "inbound",
    "from"      : "+22670000000",
    "to"        : "+22600000000",
    "body"      : "Bonjour!",
    "deviceId"  : "zfold2-xxx",
    "timestamp" : "2024-06-22T15:46:11.000Z",
    "status"    : "delivered"
  }
}
```

### Events DLR (statuts sortants)
```
message.sent      → { data: { messageId, status: "sent", timestamp } }
message.delivered → { data: { messageId, status: "delivered", timestamp } }
message.failed    → { data: { messageId, status: "failed", reason } }
```

### Signature webhook (optionnelle)
```
INFINIREACH_WEBHOOK_SECRET vide = mode permissif (aucune validation)
INFINIREACH_WEBHOOK_SECRET défini = HMAC-SHA256(rawBody, secret)
Header attendu : X-Signature ou X-Infinireach-Signature
```

---

## 6. Système de routage (messageRouter.js)

**Décision de routage** :

| Destinataire | Route | Transport | Action |
|---|---|---|---|
| UID OmniSMS connu | `OMNISMS` | — | Firestore + Socket.IO |
| Numéro non trouvé dans OmniSMS | `SMS_EXTERNE` | `sms_gateway` (défaut) | Firestore + INfiniReach Z Fold2 |
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

**Fallback INfiniReach → Infobip** (si `OFFLINE_SMS_FALLBACK_TO_INFOBIP=true`) :
- Si INfiniReach échoue → tente Infobip immédiatement avant d'entrer en queue BullMQ

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
  providerMessageIds: [],  // IDs INfiniReach/Infobip pour DLR
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
  smsMessageId  : "ir-xxx" | "infobip-id" | null,
  smsProvider   : "sms_gateway" | "infobip" | null,   // transport utilisé
  deviceId      : "zfold2-xxx" | null,                // device INfiniReach
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
| POST | `/api/webhooks/sms-gateway/inbound` | HMAC opt. | **SMS entrant Z Fold2 INfiniReach (principal)** |
| GET | `/api/webhooks/sms-gateway/status` | Aucune | Statut webhook + guide config INfiniReach |
| POST | `/api/webhooks/infobip/inbound` | HMAC opt. | SMS entrant Infobip (standby) |
| GET | `/api/webhooks/infobip/inbound/status` | Aucune | Statut webhook Infobip |
| POST | `/api/sms/send` | Firebase JWT | SMS direct via Infobip |
| GET | `/api/sms/infobip/status` | Aucune | Statut Infobip |
| GET | `/health` | Aucune | Santé backend |

---

## 11. Variables d'environnement (Render)

### INfiniReach Z Fold2 (Transport principal Offline)

| Variable | Requis | Défaut | Description |
|---|---|---|---|
| `INFINIREACH_API_KEY` | **OUI** | — | Clé API INfiniReach |
| `INFINIREACH_FROM_NUMBER` | **OUI** | — | Numéro SIM du Z Fold2 (champ "from", E.164, ex: +22600000000) |
| `INFINIREACH_API_URL` | non | `https://api.infinireach.io` | URL de base API INfiniReach |
| `INFINIREACH_ENABLED` | non | `true` | Activer/désactiver le transport INfiniReach |
| `INFINIREACH_WEBHOOK_SECRET` | non | `''` | HMAC secret webhook (vide = mode permissif) |
| `INFINIREACH_REQUIRE_SIGNATURE` | non | `false` | Bloquer si signature HMAC absente/invalide |
| `OFFLINE_SMS_PROVIDER` | non | `sms_gateway` | `sms_gateway` (INfiniReach) ou `infobip` |
| `OFFLINE_SMS_FALLBACK_TO_INFOBIP` | non | `false` | Fallback automatique sur Infobip si INfiniReach échoue |

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

## 12. Configuration Z Fold2 INfiniReach (actions utilisateur)

### Dans l'application INfiniReach sur Z Fold2

1. **Installer** l'application INfiniReach sur le Z Fold2
2. **Se connecter** et enregistrer le device — noter les identifiants
3. **Configurer le webhook** dans l'app INfiniReach :
   - URL : `https://omnisms-backend.onrender.com/api/webhooks/sms-gateway/inbound`
   - Event : `message.inbound` (et optionnellement `message.delivered`, `message.failed`)

### Dans Render (variables d'environnement)

```
INFINIREACH_API_KEY=votre_cle_api_infinireach
INFINIREACH_FROM_NUMBER=+226xxxxxxxx       # numéro SIM Z Fold2 en E.164
INFINIREACH_API_URL=https://api.infinireach.io
INFINIREACH_ENABLED=true
INFINIREACH_WEBHOOK_SECRET=               # vide pour premier test
INFINIREACH_REQUIRE_SIGNATURE=false
OFFLINE_SMS_PROVIDER=sms_gateway
```

---

## 13. Règles absolues

1. **Ne pas toucher au système de paiement** (`routes/payment.leekpay.js`, `services/leekpay.js`)
2. **Ne pas casser le mode Online** (`makeConversationId`, `routeMessage` branche OMNISMS)
3. **Ne pas réécrire ce qui fonctionne** — étendre, corriger, compléter
4. **Toujours utiliser `process.env` pour les secrets** — jamais de hardcode, ne jamais logger `INFINIREACH_API_KEY`
5. **Valider les webhooks** avec HMAC si `INFINIREACH_WEBHOOK_SECRET` configuré
6. **Déduplication systématique** des webhooks entrants par `data.messageId` (Redis ou Map mémoire)
7. **Normaliser les numéros** via `phoneNormalizer.normalizePhone()` systématiquement
8. **Ne pas supprimer Infobip** — conserver en standby, activable via `OFFLINE_SMS_PROVIDER=infobip`
9. **Ne pas inventer d'API** — utiliser uniquement les endpoints documentés officiellement
10. **`smsProvider` = 'sms_gateway'** pour tous les messages INfiniReach (rétrocompatibilité Firestore)
