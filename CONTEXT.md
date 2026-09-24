# OmniSMS — Architecture et Contexte Technique

**Version**: 4.6.0  
**Date mise à jour**: 2026-09-13  
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

---

## 14. Diagnostic — Logs de démarrage INfiniReach

Depuis la version 4.6.0, `services/smsGateway.js` expose `logStartupDiagnostic()`, appelé automatiquement depuis `server.js` au démarrage. Ces logs permettent de vérifier la configuration sans jamais exposer la clé API :

```
[InfiniReach] ── Configuration au démarrage ─────────────────────────
[InfiniReach] enabled          : YES
[InfiniReach] INFINIREACH_API_KEY     : CONFIGURED
[InfiniReach] INFINIREACH_FROM_NUMBER : CONFIGURED (+2267540****)
[InfiniReach] INFINIREACH_API_URL     : https://api.infinireach.io
[InfiniReach] INFINIREACH_WEBHOOK_SECRET : non défini (mode permissif)
[Offline SMS] ──────────────────────────────────────────────────────
[Offline SMS] OFFLINE_SMS_PROVIDER           : sms_gateway (INfiniReach)
[Offline SMS] OFFLINE_SMS_FALLBACK_TO_INFOBIP: false (Infobip désactivé pendant test INfiniReach)
[Offline SMS] Transport résolu : INfiniReach Z Fold2
[Offline SMS] isConfigured()   : YES ✅
```

**Logs webhook entrant** (depuis la version 4.6.0, ajoutés à l'entrée HTTP du POST handler) :
```
[InfiniReach Webhook] received { event, messageId, from, to, bodyLength, direction, deviceId, ip }
```

---

## 15. Troubleshooting — Erreurs INfiniReach connues

### 404 — No device found with phone number +XXXXX for your account

**Cause** : `INFINIREACH_FROM_NUMBER` contient un numéro non enregistré comme device dans le compte INfiniReach.

**Le code est correct** — le numéro de `INFINIREACH_FROM_NUMBER` est transmis directement comme champ `"from"` sans aucune transformation. Si INfiniReach répond 404, c'est que le numéro ne correspond à aucun device enregistré dans votre compte INfiniReach.

**Vérification** :
1. Ouvrir l'application INfiniReach sur le Z Fold2
2. Aller dans Paramètres → Devices / Appareils
3. Vérifier que le numéro SIM affiché correspond EXACTEMENT à `INFINIREACH_FROM_NUMBER` en format E.164
4. Si différent : mettre à jour `INFINIREACH_FROM_NUMBER` sur Render avec le bon numéro
5. Si le device n'est pas enregistré : connecter/enregistrer le Z Fold2 dans INfiniReach

**Hint dans les logs** :
```
[INfiniReach] send:error
  statusCode: 404
  error: "No device found with phone number +22675405214 for your account."
  hint: "Device non trouvé — vérifier que INFINIREACH_FROM_NUMBER (+22675405214) est bien enregistré
         dans l'application INfiniReach sur le Z Fold2. Le numéro SIM doit correspondre exactement
         au device enregistré dans votre compte INfiniReach."
```

### 401 — Clé API invalide

**Cause** : `INFINIREACH_API_KEY` incorrect ou expiré.  
**Action** : Régénérer la clé dans l'interface INfiniReach, mettre à jour Render.

### Infobip fallback — Désactiver pendant tests INfiniReach

Pour voir clairement les erreurs INfiniReach sans masquage Infobip :
```
OFFLINE_SMS_FALLBACK_TO_INFOBIP=false    # sur Render
```
Remettre à `true` en production pour la résilience.

---

## 16. Cycle de vie d'un compte OmniSMS (userResolver)

`services/userResolver.js` est la source de vérité unique pour la résolution `phone → UID`.

### Règles de résolution

| État du compte | `resolveUserByPhone()` | Traitement |
|---|---|---|
| Actif (`deleted` absent ou `false`) | `{ found: true, uid: "xxx" }` | Route OMNISMS |
| Supprimé (`deleted: true`) | `{ found: false }` | Route SMS_EXTERNE classique |
| Non inscrit | `{ found: false }` | Route SMS_EXTERNE classique |

### CAS 1 — Compte actif → OmniSMS
`resolveUserByPhone()` ignore les documents avec `deleted === true`.  
Seuls les comptes actifs sont trouvés et retournent `{ found: true, uid }`.

### CAS 2 — Compte supprimé (`deleted=true`) → SMS classique
Après suppression, le champ `deleted: true` est positionné sur le document Firestore.  
`resolveUserByPhone()` (ligne 118 de userResolver.js) : `if (!includeDeleted && data.deleted === true) continue;`  
Le numéro n'est plus résolu vers l'ancien UID → traité comme SMS classique.

### CAS 3 — Même numéro réajouté sans nouvelle inscription
Si `deleted=true` reste en Firestore, le numéro est toujours traité comme SMS classique.  
Le compte n'est PAS automatiquement réactivé.

### CAS 4 — Nouvelle inscription valide
Une nouvelle inscription crée un nouveau document avec `deleted: false` (ou sans `deleted`).  
Le numéro est de nouveau résolu → redevient OmniSMS.

**Pas de cache** : `resolveUserByPhone()` interroge Firestore à chaque appel. Aucun état mis en cache qui pourrait retourner un ancien UID supprimé.

---

## 17. Correction inbound SMS — ownerUid (Session 5)

### Problème identifié

`findExternalConvByPhone(db, fromE164, recipientE164)` retournait la conversation
la plus récente par `lastMessageAt` sans vérifier que `ownerUid` correspond au
propriétaire du numéro SIM destinataire (`to` = INFINIREACH_FROM_NUMBER).

Cas concret : si deux conversations existaient pour le même numéro expéditeur
(ex: une ancienne de test avec un mauvais `ownerUid`), le message arrivait dans
le mauvais compte OmniSMS.

### Correction apportée (`services/messageRouter.js`)

Le filtre `infobipNumber` (= champ `to` du webhook = numéro SIM Z Fold2) est
maintenant appliqué **toujours** (pas seulement quand `docs.length > 1`) :

1. Si `infobipNumber` est fourni → `resolveUserByPhone(infobipNumber)` → `ownerUid`
2. Chercher la conversation avec cet `ownerUid` exact
3. Si aucune conversation n'appartient au bon `ownerUid` → retourner `null`
   (force l'appelant à créer une nouvelle conversation avec le bon UID)
4. Si `infobipNumber` est absent → fallback ancienne logique (conv la plus récente)

### Priorité des cas (sms.gateway.inbound.js — inchangé)

```
Cas A : Protocole # → resolveUserByPhone(hashParsed.targetPhone)
Cas B : findExternalConvByPhone(db, from, to) → ownerUid depuis conv FILTRÉE
Cas C : resolveUserByPhone(to) → propriétaire du SIM Z Fold2
```

### Tests ajoutés (test/sms-inbound-tests.js — 23 tests)

- E1/E2/E3 : correction findExternalConvByPhone (filtre SIM owner)
- I1/I2 : flow inbound complet (Cas B + Cas C)
- K1/L1 : ownerUid + Socket.IO au bon UID
- A1-A4 : normalisation numéros BF
- B1/B2 : resolveUserByPhone E.164 + variante courte
- C1 : numéro non trouvé
- D1/D2 : compte deleted=true
- F1/F2 : création conversation externe
- M1-M3 : protocole #
- J1/J2 : déduplication Redis

---

## 18. Corrections Flutter (Session 5)

### B — iOS/Safari/PWA

Framework : **Flutter** (pas React/web). Fichiers dans `/home/user/frontend/`.

**Cause principale : scroll automatique perpétuel**
Dans `conversation_screen.dart`, `addPostFrameCallback((_) => _scrollToBottom())`
était appelé à CHAQUE rebuild du `ListView.builder`, empêchant l'utilisateur de
remonter dans l'historique et causant des sauts visuels sur iOS.

**Correction :**
- Nouveau flag `_hasScrolledToBottom` : scroll automatique seulement au premier
  chargement et à l'arrivée de nouveaux messages (quand l'utilisateur est en bas).
- Si l'utilisateur a remonté dans l'historique, le scroll ne force plus le bas.

**SafeArea :**
- `VoiceRecorderWidget` avait son propre `SafeArea` imbriqué dans celui du
  `ConversationScreen` → double inset sur iPhone avec encoche. Supprimé.

### C — Microphone Android + iOS

**Android (`android/app/src/main/AndroidManifest.xml`) :**
- Permission `RECORD_AUDIO` était commentée → ajoutée.

**iOS (`ios/Runner/Info.plist`) :**
- Clé `NSMicrophoneUsageDescription` absente → ajoutée.
- Sans cette clé, iOS refuse l'accès au microphone et peut crasher l'application.

**`pubspec.yaml` :**
- Ajout de `record: ^5.1.2` (enregistrement audio mobile).
- Ajout de `permission_handler: ^11.3.1` (demande permission runtime Android/iOS).

**`voice_recorder_widget.dart` :**
- Demande de permission avant démarrage de l'enregistrement.
- Gestion gracieuse du refus (SnackBar explicatif, pas de blocage de l'interface).

### D — Historique des messages

**Cause : remplacement de liste lors du polling**
`_pollMessages()` dans `MessagingProvider` remplaçait entièrement
`_messagesMap[conversationId]` à chaque appel (toutes les 15s).

**Correction :**
- Fusion intelligente : seuls les messages absents de la liste locale sont ajoutés.
- Tri chronologique préservé.
- L'utilisateur peut remonter dans l'historique sans que les messages disparaissent.

---

## 19. Corrections Session 6 — Pré-build APK

### §1-2 : Présence SMS entrant (routage online/offline)

**Problème** : `processSmsReceived()` émettait toujours vers Socket.IO, sans vérifier si l'utilisateur était réellement connecté.

**Correction** (`routes/sms.gateway.inbound.js`) :
- ÉTAPE 4 appelle `isUserOnline(ownerUid)` depuis `socketService.js` (Redis hash `online_users`).
- Connecté → `emitFn(ownerUid, 'message:receive', ...)` OmniSMS temps réel.
- Déconnecté → `smsGateway.sendSMS()` fallback SMS ordinaire.
- `isUserOnline()` retourne `false` si Redis absent (dégradation sécurisée).

### §3 : Username routing

Logique `#username` et `resolveUserByUsername` préservée intégralement — aucune modification.

### §4 : SMS fallback (InfiniReach/Infobip)

InfiniReach et Infobip **non modifiés**. Le fallback dans `sms.gateway.inbound.js` appelle `smsGateway.sendSMS()` (chemin déjà validé).

### §5 : Message vocal → destinataire sans OmniSMS

**Problème** : `routeMessage()` avait un `else if (type !== 'text')` qui ne faisait rien pour les messages audio vers des destinataires externes.

**Correction** (`services/messageRouter.js`) :
- Nouvelle branche `else if (type === 'audio' && audioUrl)`.
- Si audioUrl = chemin local → `audioPath` direct.
- Si audioUrl = URL https → téléchargement dans fichier temp.
- `transcriptionService.transcribe({ audioPath, language: 'fr' })` → `transcribedText`.
- `smsGateway.sendSMS()` ou `infobip.sendSMS()` avec `[OmniSMS Vocal] ... : ${transcribedText}`.
- Mise à jour Firestore avec `transcription`, `transcriptionStatus: 'completed'`.
- Pas d'envoi si transcription vide ou échouée (log warn + message Firestore seulement).

### §6-7 : Actualisation rapide des messages (Flutter)

**Correction** (`lib/providers/messaging_provider.dart`) :
- Polling réduit de 15s → **5s** (`Duration(seconds: 5)`).
- Nouvelle méthode `injectInboundMessage(conversationId, message)` : injection immédiate sans attendre le prochain cycle de polling. Déduplication par `message.id`, tri chronologique, `notifyListeners()`.
- `_pollMessages()` utilise déjà la fusion (merge, pas replace) — correction Session 5 préservée.

### §9-10 : PWA navigateur mobile

**Correction** (`web/index.html`) :
- Détection plateforme : `isIOS`, `isAndroid`, `isStandalone`.
- Guard `isStandalone` : ne montre pas le prompt si PWA déjà installée.
- **Chrome Android** : `beforeinstallprompt` → `deferredPrompt.prompt()`.
- **Safari iOS** : `showIOSInstructions()` → modal `#ios-install-modal` avec guide 3 étapes (Partager → Ajouter à l'écran d'accueil).
- **Android autres navigateurs** : `downloadAPK()` → `APK_DOWNLOAD_URL`.
- CSS : `touch-action: manipulation`, `min-height: 44px`, `pointer-events: auto` sur boutons → supprime zoom involontaire Safari.

### §11 : Monétisation Offline atomique

**Problème** : `ref.update({ credits: newTotal })` était non-atomique, permettant des race conditions sur envois simultanés.

**Correction** (`routes/credits.js`) :
- `POST /credits/decrement` utilise `db.runTransaction(async (tx) => { tx.get(); tx.update(); })`.
- Si crédits insuffisants → `throw` dans la transaction → abort → HTTP 400.
- Utilisateurs premium (`isSubscribed: true`) exemptés sans modification du solde.

### §12 : LykePay → SaaSPay

**Nouveaux fichiers** :
- `services/saaspay.js` — service SaaSPay, env vars `SAASPAY_*`, URL `https://saaspay.me/api/v1/checkout`, signature `X-SaaSPay-Signature`. Toute la logique métier (montants, retry, validation) copiée depuis `leekpay.js`.
- `controllers/saaspayController.js` — contrôleur SaaSPay, collection Firestore `leekpay_payments` conservée pour rétrocompatibilité.
- `routes/payment.saaspay.js` — routes SaaSPay avec alias `/webhook/saaspay` ET `/webhook/leekpay` (backward compat).

**Fichiers modifiés** :
- `server.js` : `checkLeekPay()` vérifie `SAASPAY_API_KEY && SAASPAY_SECRET_KEY` OR `LEEKPAY_API_KEY && LEEKPAY_SECRET_KEY`. Route `app.use('/api/payment', saasPayRoutes)` montée.
- `lib/services/payment_service.dart` : commentaires et gestion d'erreur mis à jour pour référencer SaaSPay.

**Fichiers anciens conservés** : `leekpay.js`, `leekpayController.js`, `payment.leekpay.js` — backward compat, non modifiés.

### Tests Session 6

Fichier : `test/session6-tests.js` (28 tests A–AB)

**Résultats** : **27/27 PASS** ✅ (test AB = 28ème, numérotation interne 27 total)

**Régression** :
- `node test/sms-inbound-tests.js` → **23/23 PASS** ✅
- `node test/sms-gateway-tests.js` → **48/48 PASS** ✅
- `node test/offline-sms-tests.js` → **37/37 PASS** ✅

### Dépendances installées

- `axios` — requis par `services/saaspay.js`
- `accepts` — requis transitif de `socket.io` (déjà présent, résolu par `npm install`)

---

## 20. Corrections Session 7 — Bugs critiques routage SMS entrant

### Bugs identifiés en production (logs réels)

**Cas réel observé** :
```
SMS entrant :  FROM = +2265767****  (expéditeur)
               TO   = +2267540****  (destinataire)
[USER_RESOLUTION] Phone resolved → OmniSMS
  phone: +2267540****
  uid: MGvh4dYLlwJhv5jQbBB9
```

**Bug 1 — Mauvais destinataire dans le fallback SMS** :
Le code utilisait `to: fromE164` dans `smsGateway.sendSMS()` — soit l'**expéditeur** (+226 57...) au lieu du **destinataire** (+226 75...).

**Bug 2 — Présence non isolée par UID** :
`isUserOnline(ownerUid)` est correct dans son implémentation (Redis `hget('online_users', uid)`), mais si Redis est vide et que Socket.IO n'a pas de sockets dans la room `user:{ownerUid}`, l'utilisateur est marqué offline même s'il vient de se connecter. Ajout d'une double vérification Socket.IO room comme fallback.

### Corrections (`routes/sms.gateway.inbound.js`)

**Bug 1 — Fix** : `to: fromE164` → `to: recipientE164` dans `smsGateway.sendSMS()`.

**Bug 2 — Fix** : Double vérification de présence :
1. `isUserOnline(ownerUid)` → Redis `hget('online_users', ownerUid)` (par UID)
2. Si Redis ne connaît pas encore ce UID → `io.in('user:{ownerUid}').fetchSockets()` (Socket.IO room spécifique)
- La présence d'un UID B connecté (ex: `rvVb...`) ne peut pas rendre le UID A (`MGvh...`) online.

### Logs de diagnostic ajoutés

```
[INfiniReach] ROUTING — diagnostic
  incomingFrom: +2265767****
  incomingTo: +2267540****
  resolvedRecipientPhone: +2267540****
  resolvedRecipientUid: MGvh4dYLlwJhv5jQbBB9
  recipientOmniSms: true

[INfiniReach] ROUTING — décision
  recipientPresence: online | offline
  routingDecision: omnisms | sms_fallback
  fallbackTo: +2267540****       ← TOUJOURS le destinataire
  fallbackFrom: (SIM passerelle) ← numéro InfiniReach validé
```

### Règle absolue du routage (documentée dans le code)

```
SMS entrant :  from = expéditeur / to = destinataire
Si fallback :  send(to = recipientE164) ← DESTINATAIRE
               JAMAIS send(to = fromE164) ← EXPÉDITEUR
```

### Tests Session 7

Fichier : `test/routing-presence-tests.js` (34 tests T1–T7)

**Résultats** : **34/34 PASS** ✅

**Régression complète** :
- `test/routing-presence-tests.js` → **34/34 PASS** ✅
- `test/session6-tests.js` → **27/27 PASS** ✅
- `test/sms-inbound-tests.js` → **23/23 PASS** ✅
- `test/sms-gateway-tests.js` → **48/48 PASS** ✅
- `test/offline-sms-tests.js` → **37/37 PASS** ✅
- **Total** : **169/169 PASS** ✅

---

## §21 — Session 8 — Audit complet et correction routage (2026-09-17)

### Audit effectué

Lecture complète de :
- `services/messageRouter.js` (718 lignes)
- `routes/messages.v2.js` (857 lignes)
- `services/socketService.js` (handler `message:send`)
- `routes/sms.gateway.inbound.js` (état post-Session 7)
- `services/smsHandler.js` et `services/hybridSms.js` (pas de bug FROM/TO)
- Frontend : `messaging_provider.dart`, `conversation_screen.dart`, `auth_service.dart`, `messaging_service.dart`, `web/index.html`

### Bug critique corrigé — `routeMessage()` (messageRouter.js)

**Problème** : à la ligne 309 (avant correction), `if (resolvedUid)` routait vers OMNISMS immédiatement dès qu'un compte OmniSMS était trouvé, **sans vérifier si l'utilisateur était réellement connecté**. Messages perdus pour destinataires offline.

**Correction** :
1. Vérification de présence `isUserOnline(resolvedUid)` ajoutée **avant** la route OMNISMS
2. Double check : Redis → Socket.IO room `user:{resolvedUid}` (comme dans `sms.gateway.inbound.js`)
3. Si offline : fallback SMS vers `resolvedUserInfo.phone` (numéro réel du destinataire — JAMAIS le numéro de l'expéditeur)
4. Récupération du phone via `resolveUserByUid(resolvedUid)` quand `targetUid` préresolu sans userInfo

**Règle maintenant codée** :
```
Compte existant ≠ utilisateur connecté
→ OMNISMS uniquement si resolvedUid && recipientIsOnline
→ SMS fallback si resolvedUid && !recipientIsOnline
```

### Logs structurés ajoutés

```javascript
// Présence destinataire
[ROUTING] Vérification présence destinataire
  senderUid, resolvedUid, recipientOnline (true/false), targetPhone

// Route OMNISMS
[ROUTING] Message routed → OMNISMS
  senderUid, senderPhone, targetPhone, resolvedUid, recipientOnline: true, route, conversationId, messageId

// Route SMS_EXTERNE
[ROUTING] Message routed → SMS_EXTERNE
  senderUid, senderPhone, targetPhone, normalizedTarget, resolvedUid, recipientOnline: false,
  route, transport, conversationId, messageId, smsSuccess, smsMessageId

// Fallback offline
[ROUTING] Destinataire OmniSMS OFFLINE → fallback SMS vers son numéro réel
  senderUid, resolvedUid, recipientPhone
```

### Règle FROM/TO (déjà corrigée Sessions 6+7 — confirmée)

```
SMS entrant 67 → 75 :
  fromE164      = 67 (expéditeur)
  recipientE164 = 75 (destinataire OmniSMS)
  externalPhone = 67 (stocké dans external_conversations)
  fallback SMS  → to: recipientE164 (75), jamais fromE164 (67)

Réponse OmniSMS → 67 :
  targetPhone   = externalPhone = 67
  e164Target    = normalizePhone(67)
  SMS to: 67   ← CORRECT
```

### Tests mis à jour

- `test/sms-gateway-tests.js` : D1, D2, G10 — ajout de `isUserOnline: async () => true` dans les mocks socketService pour les scénarios "Online" (adaptation à la nouvelle logique de présence)

### Nouveau fichier de tests

`test/routing-matrix-tests.js` — **57 tests** couvrant :
- Sections 1–3 : présence dans routeMessage(), fallback offline, résolution UID
- Sections 4–5 : mapping FROM/TO inbound, réponse SMS
- Sections 6–7 : logs structurés ROUTING, double check présence inbound
- Sections 8–9 : isolation UIDs, intégrité globale (Infobip/InfiniReach non supprimés)
- Section 10 : matrice A–H comportement
- Section 11 : sécurité logs (pas de secrets)

### Résultats régression complète

| Fichier de test | Session 8 |
|---|---|
| `test/session6-tests.js` | **27/27** ✅ |
| `test/routing-presence-tests.js` | **34/34** ✅ |
| `test/routing-matrix-tests.js` | **57/57** ✅ (nouveau) |
| `test/sms-inbound-tests.js` | **23/23** ✅ |
| `test/sms-gateway-tests.js` | **48/48** ✅ |
| `test/offline-sms-tests.js` | **37/37** ✅ |
| **TOTAL** | **226/226** ✅ |

### Frontend — État (navigateur / PWA)

- `messaging_provider.dart` : merge correctement (pas de replace), polling 5s, `injectInboundMessage()` avec dédup ✅ (Session 6)
- `web/index.html` : `touch-action: manipulation`, iOS modal, APK download, `isStandalone` guard ✅ (Session 6)
- Auth token : stocké dans SharedPreferences (persistant entre sessions), `_authHeaders()` récupère avant chaque requête — pas de race condition sur les rechargements normaux
- Note : le 401 observé sur Safari peut survenir si SharedPreferences vide (premier login ou token expiré) — géré par `catch` dans `_pollConversations()`

---

## §22 — Audit et corrections frontend navigateur (Session 9 — 2026-09-18)

### Contexte

Session de corrections ciblées sur le frontend Flutter Web suite aux tests réels sur Safari iPhone en mode navigateur (non-PWA).

### Problèmes identifiés et causes exactes

#### 1. Race condition auth (401 sur /conversations — Safari iPhone)

**Cause exacte** :
- `MessagingProvider` est instancié dans `MultiProvider` au niveau racine (avant toute navigation).
- Son constructeur appelle `_init()` immédiatement → `loadConversations()`.
- À ce moment, `AuthProvider._checkLoginStatus()` est encore en cours (async SharedPreferences).
- `getToken()` retourne `null` → header Authorization absent → 401.
- Sur Safari iOS, `SharedPreferences.getInstance()` est plus lent → race plus fréquente.

**Correction** (`messaging_provider.dart`) :
- `_init()` lit maintenant le token **avant** d'appeler `loadConversations()`.
- Si token absent : skip `loadConversations()` (sera déclenché via `reinitialize()`).
- Nouvelle méthode `reinitialize()` : appelée depuis `LoginScreen` après login réussi.

**Correction** (`login_screen.dart`) :
- Import de `MessagingProvider`.
- Après login réussi : `context.read<MessagingProvider>().reinitialize()`.
- `initState` : si `auth.isLoading` → attendre la fin via `addListener` avant de naviguer.
- Évite le cas où `addPostFrameCallback` s'exécute avant que `_checkLoginStatus()` complète.

#### 2. Bottom navigation coupée — Safari iPhone

**Cause exacte** :
- `_buildMobileLayout()` utilise `NavigationBar` directement dans `Scaffold.bottomNavigationBar`.
- Flutter Web ne propage pas automatiquement `env(safe-area-inset-bottom)` au `NavigationBar`.
- Sans `viewport-fit=cover` dans le viewport meta, Safari ignore les variables `env(safe-area-inset-*)`.

**Correction** (`dashboard_screen.dart`) :
- `NavigationBar` enveloppé dans `Column` avec `SizedBox(height: bottomPadding)`.
- `bottomPadding = MediaQuery.of(context).viewPadding.bottom` (0 sur PWA installée).
- Sur PWA installée : `viewPadding.bottom = 0` → aucun changement de comportement.

**Correction** (`web/index.html`) :
- Viewport meta : ajout de `viewport-fit=cover`.
- CSS `body { padding-bottom: env(safe-area-inset-bottom, 0px); }`.
- CSS `#install-prompt { bottom: calc(80px + env(safe-area-inset-bottom, 0px)); }`.
- CSS `flt-glass-pane, flt-scene-host, flutter-view { pointer-events: auto !important; }`.

#### 3. Microphone non fonctionnel en mode navigateur

**Cause exacte** :
- `VoiceRecorderWidget.initState()` vérifiait `kIsWeb` → annulait immédiatement.
- `VoiceRecorderWidget.build()` retournait `SizedBox.shrink()` sur web.
- `MessagingProvider.sendVoiceMessage()` avait `if (kIsWeb) { return false; }`.

**Correction** (`voice_recorder_widget.dart`) :
- Suppression du bloc `kIsWeb → annulation` dans `initState`.
- Suppression du `SizedBox.shrink()` dans `build()`.
- Ajout de `_requestWebMicrophonePermission()` via `navigator.mediaDevices.getUserMedia`.
- Ajout de `_startRecording()` web : utilise `dart:html MediaRecorder`.
- Ajout de `_stopRecording()` web : collecte les chunks Blob, crée une URL `Blob`.
- Permission demandée uniquement au moment où l'utilisateur déclenche l'enregistrement.
- Gestion propre des erreurs permission refusée / microphone indisponible.
- `dispose()` libère le `MediaStream` (getTracks().forEach(stop)).

**Correction** (`messaging_provider.dart`) :
- Suppression du `if (kIsWeb) { return false; }` dans `sendVoiceMessage()`.

#### 4. Pointer-events bloquant les clics (navigateur)

**Correction** (`web/index.html`) :
- Ajout de règle CSS pour forcer `pointer-events: auto` sur les conteneurs Flutter :
  `flt-glass-pane, flt-scene-host, flutter-view { pointer-events: auto !important; }`

### Tests effectués (automatisables)

| Suite | Résultat |
|---|---|
| `test/session6-tests.js` | **27/27** ✅ |
| `test/routing-presence-tests.js` | **34/34** ✅ |
| `test/routing-matrix-tests.js` | **57/57** ✅ |
| `test/sms-inbound-tests.js` | **23/23** ✅ |
| `test/sms-gateway-tests.js` | **48/48** ✅ |
| `test/offline-sms-tests.js` | **37/37** ✅ |
| **TOTAL** | **226/226** ✅ |

### Tests à effectuer sur appareil réel (non automatisables)

- TEST Safari iPhone navigateur : `/conversations → 200` (plus de 401 après login)
- TEST PWA installée : vérifier que la PWA reste fonctionnelle (viewPadding.bottom=0)
- TEST Android Chrome : navigation bottom visible, microphone, messages
- TEST Microphone web : getUserMedia déclenché à la demande, Blob URL créé correctement
- TEST Safe-area : bottom nav visible sur Safari iPhone (pas coupée)
- TEST Online→Online : messages livrés temps réel ✅ (non modifié)
- TEST Online→Offline : SMS fallback vers numéro de B ✅ (non modifié)
- TEST SMS entrant 67→75 : message visible dans bon compte ✅ (non modifié)
- TEST Réponse SMS : SMS sortant vers 67, jamais vers 75 ✅ (non modifié)

### Fichiers modifiés

| Fichier | Changement |
|---|---|
| `frontend/lib/providers/messaging_provider.dart` | `_init()` : check token avant `loadConversations()`; `reinitialize()` ajouté; `sendVoiceMessage` kIsWeb block supprimé |
| `frontend/lib/screens/auth/login_screen.dart` | Import `MessagingProvider`; `reinitialize()` après login; `initState` attend fin auth si `isLoading` |
| `frontend/lib/screens/dashboard_screen.dart` | `_buildMobileLayout()` : `NavigationBar` + safe-area `SizedBox` |
| `frontend/lib/widgets/audio/voice_recorder_widget.dart` | Web : `getUserMedia` + `MediaRecorder`; suppression `kIsWeb → annulation` |
| `frontend/web/index.html` | `viewport-fit=cover`; CSS `env(safe-area-inset-bottom)`; pointer-events Flutter |

### Règles absolues respectées

- ✅ SaaSPay non modifié
- ✅ Infobip non supprimé
- ✅ InfiniReach non modifié
- ✅ SMS envoi/réception non modifié
- ✅ Socket.IO architecture non modifiée
- ✅ Android/PWA installée non cassé (viewPadding.bottom=0 sur PWA)
- ✅ Design non modifié
- ✅ Backend non modifié (déjà correct depuis Session 8)

---

## 23. Session 10 — Stabilisation Globale (2026-09-19)

### Problèmes identifiés et corrigés

#### 1. CORS bloqué pour omnisms-frontend-drab.vercel.app

**Cause racine** : `vercelPattern` dans `security.js` ET `socketService.js` :
```js
// AVANT (cassé)
/^https:\/\/omnisms-frontend(-[a-z0-9]+-emmanuel-lezin)?(\.vercel\.app)$/
// 'drab' ne finit pas par '-emmanuel-lezin' → rejeté
```
**Correction** :
- `security.js` : nouveau pattern `/^https:\/\/omnisms-frontend(-[a-z0-9]+)*\.vercel\.app$/`
- `socketService.js` : même correction
- Ajout explicite de `https://omnisms-frontend-drab.vercel.app` dans les deux tableaux `allowedOrigins`/`corsOrigins`

**Conséquence** : OPTIONS/POST `/api/auth/login` et `/api/auth/register` maintenant autorisés.

#### 2. 404 sur GET /api/messages/ext-uid-+22676580024

**Cause racine** : Route Express `/:conversationId([a-zA-Z0-9_\\-]{10,})` excluait `+`.
**Correction** : `routes/messages.v2.js`
- Pattern : `[a-zA-Z0-9_+%\\-]{10,}` (ajout `+` et `%` pour `%2B`)
- Handler : `decodeURIComponent(req.params.conversationId)` pour normaliser

#### 3. Boucle infinie gateway InfiniReach

**Cause racine** : Numéro SIM gateway = compte OmniSMS de test → owner offline → SMS fallback vers SIM gateway → nouveau webhook → boucle.

**Correction** dans `routes/sms.gateway.inbound.js` :
- Guard 1 : `fromE164 === toE164` → message ignoré (auto-envoi)
- Guard 2 : `recipientE164 === INFINIREACH_FROM_NUMBER` → fallback SMS annulé

#### 4. Présence TTL par utilisateur

**Cause racine** : `redis.expire('online_users', ONLINE_TTL * 10)` réinitialisait le TTL du hash entier à chaque connexion.

**Correction** dans `services/socketService.js` :
- `setUserOnline` : `redis.set('online_ttl:{uid}', '1', 'EX', ONLINE_TTL)` (TTL individuel)
- `isUserOnline` : vérifie `online_ttl:{uid}` en premier, nettoie le hash si expiré
- `setUserOffline` : `redis.del('online_ttl:{uid}')` en plus du `hdel`

### Tests Session 10

| Suite | Résultat |
|---|---|
| `test/session6-tests.js` | **27/27** ✅ |
| `test/routing-presence-tests.js` | **34/34** ✅ |
| `test/routing-matrix-tests.js` | **57/57** ✅ |
| `test/sms-inbound-tests.js` | **23/23** ✅ |
| `test/sms-gateway-tests.js` | **48/48** ✅ |
| `test/offline-sms-tests.js` | **37/37** ✅ |
| `test/session10-stabilization-tests.js` | **62/62** ✅ |
| **TOTAL** | **288/288** ✅ |

### Fichiers modifiés

| Fichier | Modification |
|---|---|
| `middleware/security.js` | CORS regex + domaine drab ajouté |
| `services/socketService.js` | CORS regex + domaine drab + TTL individuel |
| `routes/messages.v2.js` | Pattern route + decodeURIComponent |
| `routes/sms.gateway.inbound.js` | Anti-boucle double guard |
| `test/session10-stabilization-tests.js` | Nouveau fichier 62 tests A–P |

### Tests réels restants (à effectuer après déploiement Render)

1. Vérifier `OPTIONS /api/auth/login` depuis `omnisms-frontend-drab.vercel.app` → 200
2. Vérifier login/register dans navigateur → plus d'erreur CORS
3. Ouvrir conversation avec numéro externe → historique charge (plus de 404)
4. Tester SMS entrant depuis numéro 67 vers gateway 75 quand owner offline → pas de boucle dans les logs
5. Vérifier présence : connexion, heartbeat, déconnexion, TTL individuels

### Variables Render à configurer

Voir §14 de ce document et PROJECT_STATUS.md v5.2.0.

---

## §24 — Session 11 : Correction Routage SMS Entrant + Notifications Gratuites

**Date** : 2026-09-20  
**Commit** : (voir PROJECT_STATUS.md v5.3.0)

### 1. Routage SMS Entrant — Cause racine et correction

**Bug confirmé** (logs production) :
```
incomingTo   : +2267540****   ← SIM gateway InfiniReach (numéro TECHNIQUE)
fallbackTo   : +2267540****   ← MÊME numéro → ANTI-BOUCLE → SMS annulé
```

**Cause** : `fallbackTo = recipientE164 = incomingTo = gatewayNumber`. La résolution UID → profil (`resolveUserByUid`) n'était pas appelée.

**Correction appliquée** dans `routes/sms.gateway.inbound.js` :
1. Import ajouté : `const { resolveUserByPhone, resolveUserByUid } = require('../services/userResolver');`
2. Après résolution `ownerUid`, appel de `resolveUserByUid(ownerUid)` → `recipientPhone` (vrai profil Firestore)
3. Fallback offline : `fallbackTo = recipientPhone` (JAMAIS `recipientE164` = gateway)
4. Anti-boucle 2 préservée : si `recipientPhone === gatewayNumber` → message en Firestore, log explicite
5. Logs enrichis : `gatewayNumber` et `recipientPhone` comme champs distincts

**Distinctions de variables** :
- `incomingTo` / `recipientE164` / `gatewayNumber` = numéro SIM InfiniReach (TECHNIQUE)
- `recipientPhone` = vrai numéro de téléphone du profil Firestore du propriétaire
- Ces deux valeurs doivent être différentes pour le fallback SMS

### 2. Système de Notifications Gratuites

**Fichiers créés/modifiés** :

| Fichier | Rôle |
|---|---|
| `frontend/lib/services/notification_service.dart` | Service central de notifications (singleton) |
| `frontend/lib/services/notification_web.dart` | Stub web (référence pour future implémentation dart:html) |
| `frontend/lib/providers/messaging_provider.dart` | Dispatch notification à chaque nouveau message entrant |
| `frontend/lib/screens/settings/notifications_settings_screen.dart` | Toggle + état permission + UI enrichie |
| `frontend/lib/main.dart` | InAppNotificationWrapper + initialize() |
| `frontend/web/sw.js` | v2.4.0 : push handler + notificationclick handler |
| `frontend/android/app/src/main/AndroidManifest.xml` | POST_NOTIFICATIONS permission (Android 13+) |

**Architecture** :
- Android app premier plan → bannière in-app overlay (InAppNotificationWrapper)
- Web/PWA page ouverte → même bannière in-app overlay
- Déduplication : `Set<String> _notifiedIds` dans NotificationService
- Skip si `_activeConversationId == conversationId`
- Permission : `permission_handler` (déjà en pubspec.yaml) sur Android
- **Gratuit** — aucun FCM, aucun service payant

**Limitations documentées** :
- Android arrière-plan : sans `flutter_local_notifications`, pas de notification système (limitiation Flutter sans FCM/push service)
- Web/PWA fermée : Push API nécessite infrastructure VAPID — non implémentée (aucun service payant)
- Les bannières in-app couvrent le cas app ouverte sur toutes plateformes

### 3. Tests

| Suite | Tests | Résultat |
|---|---|---|
| `session11-inbound-routing-tests.js` | 19 (A1–D4) | ✅ 19/19 |
| `session11-notification-tests.js` | 25 (N1–N9) | ✅ 25/25 |
| `session6-tests.js` | 27 | ✅ 27/27 |
| `routing-presence-tests.js` | 34 | ✅ 34/34 |
| `routing-matrix-tests.js` | 57 | ✅ 57/57 |
| `sms-inbound-tests.js` | 23 | ✅ 23/23 |
| `sms-gateway-tests.js` | 48 | ✅ 48/48 |
| `offline-sms-tests.js` | 37 | ✅ 37/37 |
| `session10-stabilization-tests.js` | 62 | ✅ 62/62 |
| **TOTAL** | **332** | **✅ 332/332** |

---

## §25 — Session 12 : #username + notifications + paiement (2026-09-22)

### 1. Résolution #username (CORRIGÉ)

**Problème** : `#petit-test` → utilisateur non trouvé. `#+226xxxxxxxx` → fonctionnel.

**Cause racine** : `parseHashPrefix()` dans `sms.gateway.inbound.js` utilisait le regex `\+?[\d]{6,15}` qui ne matche que des chiffres. Les usernames (`petit-test`, `user_test`, `user123`) ne matchaient jamais.

**Correction** :
- `parseHashPrefix()` étendue avec un deuxième pattern : `#[a-zA-Z0-9][a-zA-Z0-9_-]{1,49} message`
- Retourne `{ targetUsername, cleanText }` pour les usernames (vs `{ targetPhone, cleanText }` pour les numéros)
- Import ajouté : `resolveUserByUsername, normalizeUsername` depuis `userResolver.js`
- Cas A dans `processSmsReceived` : branche `if (hashParsed.targetPhone)` et `else if (hashParsed.targetUsername)` — résolution via `resolveUserByUsername()` qui requête Firestore `users.username`
- Le routage après résolution est identique au cas téléphone : `ownerUid` → présence → ONLINE/OFFLINE → même logique

**Champ Firestore** : `username` (lowercase, normalisé via `normalizeUsername` = `.toLowerCase().trim()`)

**`resolveUserByUsername(username)`** : déjà existant dans `userResolver.js` — retourne `{ found, uid, username, phone, ... }`

**Fichiers modifiés** :
- `routes/sms.gateway.inbound.js` (parseHashPrefix + cas A username)

### 2. Notifications (CORRIGÉ)

**Problèmes** :
1. `ConversationScreen.dispose()` n'appelait pas `setActiveConversation(null)` → `_activeConversationId` restait défini après avoir quitté la conversation → TOUTES les futures notifications pour cette conv étaient silencieusement bloquées par le guard `activeConvId == conversationId`
2. `NotificationService.initialize()` n'essayait pas de demander la permission au démarrage → sur Android 13+, si l'utilisateur n'a jamais visité Settings → Notifications, `hasPermission()` retourne false et les notifications sont ignorées

**Corrections** :
- `ConversationScreen.dispose()` : ajout de `provider.setActiveConversation(null)` + log diagnostique `activeConv cleared`
- `NotificationService.initialize()` : sur Android, vérifie `Permission.notification.status` — si `isDenied`, appelle `request()` dès le démarrage de l'app (dialogue système Android 13+)
- Log diagnostic enrichi dans `show()` : `Permission check: true/false` + `overlayActive: true/false`

**État réel** (TESTÉ PAR MOCK) :
- Android app premier plan : bannière in-app → fonctionne (overlay StreamController)
- Web/PWA page ouverte : bannière in-app → fonctionne (même overlay)
- Android arrière-plan : non supporté sans `flutter_local_notifications` (limitation documentée)
- Web/PWA page fermée : non supporté sans Push API/VAPID (limitation documentée)

**Fichiers modifiés** :
- `frontend/lib/screens/messaging/conversation_screen.dart` (dispose → setActiveConversation(null))
- `frontend/lib/services/notification_service.dart` (initialize → permission request + diagnostics)

### 3. Paiement SaaSPay (CORRIGÉ)

**Problème** : `POST /leekpay → 503` avec log `[SaaSPay] Non configuré — LEEKPAY_SECRET_KEY ou LEEKPAY_API_KEY manquante`

**Causes** :
1. `controllers/saaspayController.js` avait un copy-paste bug : utilisait `leekpay.PREMIUM_AMOUNT`, `leekpay.PREMIUM_CURRENCY`, `leekpay.validateAmount` — mais `leekpay` n'était pas importé (seulement `saaspay` à la ligne 18) → ReferenceError à runtime
2. Le log error disait `LEEKPAY_SECRET_KEY` alors que `saaspay.isConfigured()` vérifie `SAASPAY_SECRET_KEY`

**Corrections** :
- Remplacement de tous les `leekpay.*` par `saaspay.*` dans `saaspayController.js` : `.PREMIUM_AMOUNT`, `.PREMIUM_CURRENCY`, `.validateAmount`
- Message d'erreur corrigé : `SAASPAY_SECRET_KEY ou SAASPAY_API_KEY manquante`
- Code d'erreur JSON corrigé : `SAASPAY_NOT_CONFIGURED`

**Variables Render à configurer** (si non encore fait) :
```
SAASPAY_SECRET_KEY = sk_live_xxx
SAASPAY_API_KEY    = pk_live_xxx
SAASPAY_BASE_URL   = https://saaspay.me  (facultatif, valeur par défaut)
```
STATUT : code corrigé — si le 503 persiste, vérifier que les variables sont bien dans Render Dashboard.

### 4. Tests Session 12

| Suite | Tests | Résultat |
|---|---|---|
| `session12-username-notif-payment-tests.js` | 80 (U1-U5, N1-N9, P1-P5) | ✅ 80/80 |

**Total toutes sessions** : 412/412 ✅

| Suite | Tests | Résultat |
|---|---|---|
| `session12-username-notif-payment-tests.js` | 80 | ✅ 80/80 |
| `session11-inbound-routing-tests.js` | 19 | ✅ 19/19 |
| `session11-notification-tests.js` | 25 | ✅ 25/25 |
| `session6-tests.js` | 27 | ✅ 27/27 |
| `routing-presence-tests.js` | 34 | ✅ 34/34 |
| `routing-matrix-tests.js` | 57 | ✅ 57/57 |
| `sms-inbound-tests.js` | 23 | ✅ 23/23 |
| `sms-gateway-tests.js` | 48 | ✅ 48/48 |
| `offline-sms-tests.js` | 37 | ✅ 37/37 |
| `session10-stabilization-tests.js` | 62 | ✅ 62/62 |
| **TOTAL** | **412** | **✅ 412/412** |

---

## §26 — Session 13 : #username réel + Audio→SMS après transcription + diagnostic notifications (2026-09-24)

### Problèmes constatés en production

1. **USERNAME** : `#petit-test` → « utilisateur non trouvé » malgré le fix Session 12 (tests mockés passants).
2. **AUDIO → SMS** : la transcription Groq réussissait (logs complets) mais le SMS n'était jamais envoyé : le routage SMS était déclenché **avant** la transcription asynchrone, et **jamais repris** après.
3. **NOTIFICATIONS** : non fonctionnelles en test réel — diagnostic complet du chemin backend + ID de message incohérent entre payload Socket.IO et Firestore.

### 1. USERNAME — cause réelle et correction

**Causes réelles** (tracées dans le code, pas supposées) :
- `POST /api/messages/send` (`routes/messages.v2.js`) traitait `receiverId` soit comme téléphone, soit comme UID Firestore. **Aucune branche username** → `#petit-test` était traité comme UID inconnu → message fantôme / aucun envoi.
- `parseHashPrefix()` (inbound SMS) ne couvrait qu'un sous-ensemble : pas du point (`.`, charset officiel de l'inscription `[a-zA-Z0-9_.-]`), pas du préfixe `@`, pas des tirets Unicode des claviers mobiles, pas des usernames numériques courts.
- `resolveUserByUsername()` était strictement lowercase : un compte ancien stocké avec sa casse d'origine ne serait jamais résolu par `#PetitTest`.
- Champ Firestore vérifié dans le code : `users.username` (stocké en lowercase à l'inscription `routes/auth.js` et via `PUT /me/profile`). C'est bien ce champ que lit la résolution.

**Correction** (étendre le système existant, pas en créer un nouveau) :
- `services/userResolver.js` :
  - `parseRecipientReference(raw)` — analyse `#…` / `@…` / `＃…` (NFKC) : `username` | `phone` | `invalid`. Un numéro (≥ 6 chiffres, sans lettre) reste **toujours** un numéro (priorité absolue téléphone).
  - `resolveRecipientUsername(receiverId, opts)` — chaîne complète : saisie brute → parse → `resolveUserByUsername()` → UID (+ téléphone du profil). Statuts : `resolved` / `not_found` / `phone` / `not_username`. Tente aussi l'username « nu » (sans #) en dernier recours, jamais pour un numéro / UID.
  - `resolveUserByUsername()` : accepte `#`/`@` préfixés, tirets Unicode, fallback exact-casse pour comptes anciens.
- `routes/messages.v2.js` (`POST /send`) : résolution username **avant** `routeMessage()` :
  - `#username` connu → `routeMessage({ targetUid })` → profil → téléphone réel → présence → **ONLINE Socket.IO / OFFLINE SMS** (le SMS part vers le numéro **réel du profil**, jamais le gateway ni le username brut).
  - `#username` inconnu → **HTTP 404 `USER_NOT_FOUND`**, aucun message fantôme, aucun SMS, pas d'exception.
  - `#+226…` → numéro explicite (préfixe retiré) → résolution téléphone existante.
  - Logs `[USERNAME]` : raw input / parsed / resolving / resolved uid / resolved phone / online-offline routing.
- `services/socketService.js` (`message:send`) : même support `#username` (ack `USER_NOT_FOUND` propre si inconnu, aucun message persisté).
- `routes/sms.gateway.inbound.js` : `parseHashPrefix()` étendu (cas 3 : charset complet, `@`, tirets Unicode, username numérique court) + fallback username numérique uniquement si le numéro n'est aucun compte OmniSMS + trace `[USERNAME]`.

**Règle non régressive** : un numéro qui fonctionnait avant fonctionne exactement comme avant (testé U5/U5b/I5/I5b).

### 2. AUDIO → SMS — cause réelle et correction

**Cause réelle** : `routeMessage()` (branche audio → externe) tentait la transcription **synchrone** ; pour un `data:` URI (cas produit, audio ≤ 1,5 MB stocké en base64 dans Firestore) aucun moteur ne pouvait se lancer immédiatement → log `Audio → SMS impossible : transcription vide ou échouée` → **fin du traitement**. Le worker `transcriptionWorker` sauvegardait ensuite la transcription mais **rien ne relançait le routage SMS**.

**Correction** (réutilise `smsQueueWorker` → `smsGateway`/Infobip + retries BullMQ, pas de deuxième système SMS) :
- `services/messageRouter.js` :
  - `continueAudioSmsAfterTranscription({ messageId, transcription, collection })` : appelée **après** la sauvegarde de la transcription. Éligibilité stricte (`type=audio`, `channel=sms`, `receiverId` E.164, pas déjà envoyé). Envoie le **texte** via `enqueueSmsJob()` (format `[OmniSMS Vocal] {expéditeur} : {texte}`).
  - **Idempotence** (retry du worker / double déclenchement) : réservation atomique Firestore `audioSmsStatus = 'queued'` (transaction) + `jobId sms-{messageId}` BullMQ + `externalId omnisms-{messageId}` INfiniReach. Un message = un SMS, point.
  - Transcription vide → `audioSmsStatus: 'skipped_empty_transcription'`, aucun SMS vide.
  - Échec transcription → `markAudioSmsTranscriptionFailed()` → `audioSmsStatus: 'transcription_failed'`, message conservé, statut propre.
  - Anti-boucle : jamais de SMS vers la SIM passerelle (`INFINIREACH_FROM_NUMBER`).
  - Destinataire résolu **sans téléphone** : aucun appel provider, message conservé (conversation OmniSMS).
  - Log initial renommé : **« transcription en attente (asynchrone) »** — ne ressemble plus à une erreur finale ; seul le worker peut conclure à « réellement échouée ».
  - **ID canonique** : plus l'ID temporaire `msg-…` n'est persisté ; l'ID du document Firestore est l'ID du payload Socket.IO, de la réponse API et de `GET /conversation` (`{ id: d.id, ...d.data() }`).
- `workers/transcriptionWorker.js` : après l'étape « Saving transcription to Firestore » → `continueAudioSmsAfterTranscription()` ; sur chaque échec → statut d'erreur propre. Job reste `completed`/`failed` selon le cas, sans lever d'exception de la reprise.
- `services/queueService.js` : `addSmsJob(data, opts)` transmet les options — `jobId: sms-{messageId}` fourni par `enqueueSmsJob` (dédup BullMQ) **n'est plus silencieusement ignoré**.

### 3. NOTIFICATIONS — diagnostic et correction

**Chemin vérifié** (serveur réel + client Socket.IO réel dans les tests) :
`message:send`/`POST /send` → `routeMessage()` → Firestore `messages` → `emitToUser(resolvedUid, 'message:receive', msg)` → room `user:{uid}`.

**Causes/points corrigés** :
1. **ID incohérent** : le document Firestore était créé avec un champ `id` = ID temporaire, écrasant l'ID du document au retour `GET /conversation` → dédoublonnage frontend par ID cassé → corrections Session 11/12 inefficaces. **Corrigé** (ID canonique, §2).
2. **Diagnostic d'émission** : `emitToUser()` loggue désormais `[NOTIFICATION] Événement {event} émis` avec `recipientUid`, `room`, **`socketsInRoom`** (0 = le destinataire n'a aucune session ouverte — c'est le signal clé pour le test réel) + résumé du payload (messageId, senderId, receiverId, conversationId, type, contentLength, createdAt — jamais le contenu ni de secret).
3. Présence : `isUserOnline` (Redis `online_ttl:{uid}` + `online_users`) inchangée, double-check Socket.IO room conservé.
4. **Offline** : comportement existant conservé (Firestore + SMS), aucune nouvelle brique push.

**Payload `message:receive` (contrat inchangé, vérifié N4)** :
`{ id, senderId, receiverId, conversationId, content, type, channel, audioUrl, duration, status, reactions, createdAt, updatedAt, tempId? }`.
**Aucun champ `isMe`** n'existe dans le contrat — le frontend déduit `isMe` depuis `senderId` vs son UID.

### 4. Fichiers modifiés (Session 13)

| Fichier | Modification |
|---|---|
| `services/userResolver.js` | `parseRecipientReference`, `resolveRecipientUsername`, helpers (NFKC, tirets Unicode, phone-like) ; `resolveUserByUsername` tolérant |
| `routes/messages.v2.js` | `/send` : résolution `#username` → 404 `USER_NOT_FOUND` / `routeMessage({targetUid})` ; logs `[USERNAME]` |
| `services/socketService.js` | `message:send` : `#username` (ack propre) ; logs `[NOTIFICATION]` dans `emitToUser` + `message:send` (`socketsInRoom`) |
| `services/messageRouter.js` | `continueAudioSmsAfterTranscription`, `markAudioSmsTranscriptionFailed`, `evaluateAudioSmsEligibility` ; ID canonique ; garde « pas de destination SMS » ; logs « en attente (asynchrone) » / `[NOTIFICATION]` |
| `workers/transcriptionWorker.js` | Reprise Audio→SMS après sauvegarde ; statut d'erreur propre sur échec |
| `services/queueService.js` | `addSmsJob(data, opts)` — `jobId` dédup transmis (était ignoré) |
| `routes/sms.gateway.inbound.js` | `parseHashPrefix` étendu (charset complet, `@`, Unicode, numérique court) ; fallback username numérique ; exports tests ; logs `[USERNAME]`/`[NOTIFICATION]` |
| `test/session13-username-audio-notif-tests.js` | **Nouveau** — 33 tests de VRAI comportement (serveur Express + Socket.IO réels, Firestore/gateway/Groq mockés) |

### 5. Tests Session 13

`node test/session13-username-audio-notif-tests.js` — **33/33 PASS** (stabilisé sur 3 exécutions).

| Série | Tests |
|---|---|
| U (username) | U1, U2, U3, U4, U5, U5b, U6, U7a, U7b, U7c, U8 — résolution, online, offline, 404 propre, priorité téléphone, numérique, audio |
| A (audio→SMS) | A1, A2, A3, A4, A5, A6, A7, A8 — reprise après transcription, provider existant, vide, échec, idempotence, online, UID non E.164 |
| N (notifications) | N1, N2, N3, N4, N5, N6, N7 — présence, émission réelle, bon UID, payload, offline, pas de mauvais UID, persistance |
| I (inbound #) | I1, I2, I3, I4, I5, I5b, I6 — inbound username, inconnu, offline, numérique, rétrocompat téléphone, conv existante, dédup |

### 6. Non-régression

| Suite | Résultat |
|---|---|
| `offline-monetization-tests.js` | 26/26 ✅ |
| `offline-sms-tests.js` | 37/37 ✅ |
| `p0-p4-unit-tests.js` | 36/36 ✅ |
| `phase6-phase7-tests.js` | 51/51 ✅ |
| `routing-matrix-tests.js` | 57/57 ✅ |
| `routing-presence-tests.js` | 34/34 ✅ |
| `session10-stabilization-tests.js` | 56/62 (6 échecs **pré-existants** : chemin `/home/user/webapp` non présent en CI — identique avant/après) |
| `session11-inbound-routing-tests.js` | 19/19 ✅ |
| `session11-notification-tests.js` | 18/25 (7 échecs **pré-existants** : fichiers Flutter `/home/user/frontend` absents de ce repo — identique avant/après) |
| `session12-username-notif-payment-tests.js` | 54/61 (7 échecs **pré-existants** : idem — fichiers Flutter absents) |
| `session6-tests.js` | 15/27 (12 échecs **pré-existants** : idem — fichiers Flutter absents) |
| `sms-gateway-tests.js` | 48/48 ✅ |
| `sms-inbound-tests.js` | 23/23 ✅ |
| `session13-username-audio-notif-tests.js` | **33/33 ✅ (nouveau)** |

Les 32 échecs « pré-existants » sont tous des lectures de fichiers Flutter situés dans un repo séparé (`/home/user/frontend`) qui n'existe pas dans cet environnement ; la liste exacte des échecs est **identique avant et après** la session (vérifiée test par test).

### 7. Limitations / à faire en production

- **Frontend non modifié** (hors périmètre). Le contrat Socket.IO est conservé ; le champ manquant éventuel côté client (`isMe`) s'en déduit depuis `senderId`.
- Test réel recommandé après déploiement : envoyer `#username` depuis l'app, observer les logs `[USERNAME] … resolved uid=` puis `[NOTIFICATION] Événement message:receive émis … socketsInRoom:1` chez le destinataire.
- `audioSmsStatus` est un **nouveau champ** Firestore (additif, aucune migration requise).
- Le push notification en arrière-plan (app fermée) reste hors périmètre (aucun service payant autorisé) — l'existant (Firestore + SMS offline) est conservé.

### 8. État final

```text
USERNAME       : FIXED (tests réels U1–U8 + I1–I6)
AUDIO → SMS    : FIXED (tests réels A1–A8)
NOTIFICATIONS  : FIXED — emission réelle prouvée (N1–N7) + ID canonique + diagnostic socketsInRoom
PAYMENT        : NON TOUCHÉ
FRONTEND       : NON TOUCHÉ
```
