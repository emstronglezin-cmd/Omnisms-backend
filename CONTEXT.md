# OmniSMS — Architecture et Contexte Technique

**Version**: 4.3.0  
**Date mise à jour**: 2026-09-05  
**Backend URL**: https://omnisms-backend.onrender.com

---

## 1. Vue d'ensemble

OmniSMS est une plateforme de messagerie hybride permettant :
- La messagerie **en temps réel** entre utilisateurs OmniSMS (mode Online, Socket.IO)
- La messagerie **SMS classique** vers/depuis des numéros non-inscrits (mode Offline, Infobip)
- La **transcription audio** (Groq Whisper)
- Les **paiements** Premium (LeekPay Mobile Money)

---

## 2. Architecture globale

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENTS                                  │
│  PWA (Frontend Vercel) │ Flutter Android │ SMS classique        │
└────────────┬───────────┴────────┬────────┴──────────────────────┘
             │                    │                    │
             │ REST + Socket.IO   │ REST              │ via Gateway
             ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                  BACKEND OMNISMS (Render)                        │
│                   Express.js v4.21 / Node 18+                   │
│                                                                 │
│  routes/messages.v2.js  ──▶  services/messageRouter.js         │
│         │                         │                            │
│         │              ┌──────────┴──────────┐                │
│         │         resolveUserByPhone()    normalizePhone()     │
│         │              │                      │               │
│         │         ┌────▼────┐           ┌────▼────┐          │
│         │         │OMNISMS  │           │INFOBIP  │          │
│         │         │(app)    │           │(sms)    │          │
│         │         └────┬────┘           └────┬────┘          │
│         │           Socket.IO           Infobip API           │
│         │                                    │               │
│  routes/infobip.inbound.js ◀────────────────┘               │
│    (webhook SMS entrant + déduplication)                       │
│                                                                 │
│  services/queueService.js + smsQueueWorker.js                  │
│    (BullMQ retry 3×, inline fallback sans Redis)               │
│                                                                 │
│  services/firebase.js → Firestore (messages, external_convs)   │
└─────────────────────────────────────────────────────────────────┘
             │                    │
             ▼                    ▼
      Google Firestore       Infobip SMS API
      (persistence)          (INFOBIP_API_KEY)
```

---

## 3. Mode Online (OmniSMS ↔ OmniSMS)

**Flux** :  
OmniSMS user A → `POST /api/messages/send` → `messageRouter.routeMessage()` → `resolveUserByPhone()` → UID trouvé → Firestore `messages` + `Socket.IO emitToUser()`

**ConversationId** :  
`[UID_A, UID_B].sort().join('-')` — déterministe, jamais de numéro de téléphone

**Règle** : Ne jamais modifier ce flux. Il est fonctionnel.

---

## 4. Mode Offline (OmniSMS → SMS externe)

### 4.1 Flux sortant

```
OmniSMS user
   ↓ POST /api/messages/send { receiverId: "phone_number" }
messageRouter.routeMessage()
   ↓ resolveUserByPhone(phone) → { found: false }
   ↓ makeExternalConvId(ownerUid, e164) → "ext-{ownerUid}-{e164}"
   ↓ getOrCreateExternalConv(db, ownerUid, e164) → Firestore external_conversations
   ↓ db.collection('messages').add({ channel: 'sms', status: 'pending' })
   ↓ infobip.sendSMS({ to, text: "[OmniSMS] Nom : contenu" })
   ↓ succès → update status='sent', smsMessageId
   ↓ échec → enqueueSmsJob() → BullMQ retry 3×, backoff exponentiel 3s/9s/27s
```

**ConversationId externe** : `ext-{ownerUid}-{e164Phone}` (stable, unique par propriétaire OmniSMS)

### 4.2 Flux entrant (webhook Infobip)

```
SMS classique
   ↓ Infobip reçoit le SMS
   ↓ POST /api/webhooks/infobip/inbound
   ↓ Déduplication : isAlreadyProcessed(messageId) → Redis SETNX ou Map mémoire
   ↓ Cas A : textRaw.startsWith('#') → parseHashPrefix → resolveUserByPhone(targetPhone)
   ↓ Cas B : findExternalConvByPhone(from) → ownerUid depuis external_conversations
   ↓ Cas C : resolveUserByPhone(item.to) → ownerUid depuis numéro Infobip
   ↓ getOrCreateExternalConv(db, ownerUid, fromE164, null, infobipNumber)
   ↓ db.collection('messages').add({ direction: 'inbound', channel: 'sms' })
   ↓ emitToUser(ownerUid, 'message:receive', payload)
   ↓ Si ownerUid offline → message en Firestore, récupéré à la reconnexion
```

---

## 5. Système de routage (messageRouter.js)

**Décision de routage** :

| Destinataire | Route | Action |
|---|---|---|
| UID OmniSMS connu | `OMNISMS` | Firestore + Socket.IO |
| Numéro non trouvé dans OmniSMS | `INFOBIP` | Firestore + Infobip SMS |

**Résolution** : `services/userResolver.js` → `resolveUserByPhone(phone)` → variantes E.164 → Firestore `users`

**Normalisation** : `services/phoneNormalizer.js` → librairie `phone` npm → E.164 robuste avec fallback simple

---

## 6. Résilience et Queue

**Composants** :
- `services/queueService.js` : BullMQ + Redis, fallback inline si Redis absent
- `services/smsQueueWorker.js` : Worker SMS (retry 3×, backoff exponentiel 3s)
- `services/redis.js` : ioredis + MemoryStore fallback automatique

**Déduplication inbound** :
- Redis SETNX avec TTL 24h (si Redis disponible)
- Map mémoire fallback (non distribué, OK pour instance unique Render)

**Retry outbound** :
- Si `infobip.sendSMS()` échoue → `enqueueSmsJob()` → BullMQ `sms` queue
- JobId = `sms-{messageId}` → idempotent si messageId défini

---

## 7. Conversations externes (Firestore)

**Collection** : `external_conversations`

```
{
  conversationId    : "ext-{ownerUid}-{e164Phone}",
  ownerUid          : "UID_OMNISMS",
  externalPhone     : "+22670000000",
  externalName      : "Jean Dupont" | null,
  infobipNumber     : "+22600000000" | null,
  channel           : "sms",
  createdAt         : ISO8601,
  updatedAt         : ISO8601,
  lastMessageAt     : ISO8601,
  lastMessage       : "...",
  providerMessageIds: [],  // IDs Infobip pour DLR
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
  smsMessageId  : "infobip-id" | null,
  createdAt     : ISO8601,
}
```

---

## 8. Mode hybride SMS USSD (hybridSms.js)

Permet à des utilisateurs **sans smartphone** d'utiliser OmniSMS via SMS USSD :

- `*NOM NUMERO message` → Premier message, enregistre alias
- `*NOM message` → Message suivant, résout alias
- `#NOM NUMERO message` → Identique avec préfixe `#`
- `DÉMARRER` / `START` → Instructions d'inscription

**Webhook** : `POST /sms/hybrid/incoming` (Africa's Talking, Twilio, Orange)

---

## 9. Endpoints clés

| Méthode | URL | Authentification | Description |
|---|---|---|---|
| POST | `/api/messages/send` | Firebase JWT | Envoyer message (Online ou Offline) |
| GET | `/api/messages` | Firebase JWT | Lister conversations (OmniSMS + SMS) |
| GET | `/api/messages/:convId` | Firebase JWT | Historique conversation |
| POST | `/api/webhooks/infobip/inbound` | HMAC opt. | SMS entrant Infobip |
| GET | `/api/webhooks/infobip/inbound/status` | Aucune | Statut webhook |
| POST | `/api/sms/send` | Firebase JWT | SMS direct via Infobip |
| GET | `/api/sms/infobip/status` | Aucune | Statut Infobip |
| GET | `/health` | Aucune | Santé backend |

---

## 10. Variables d'environnement (Render)

| Variable | Requis | Description |
|---|---|---|
| `INFOBIP_API_KEY` | **OUI** | Clé API Infobip (SMS sortant + webhook) |
| `INFOBIP_BASE_URL` | **OUI** | URL Infobip (ex: `xxx.api.infobip.com`) |
| `INFOBIP_SENDER_ID` | non | Nom expéditeur (défaut: `OmniSMS`) |
| `INFOBIP_WEBHOOK_SECRET` | optionnel | HMAC secret pour valider signature webhook |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **OUI** | JSON service account Firebase |
| `JWT_SECRET` | **OUI** | Secret JWT pour authentification |
| `REDIS_URL` | optionnel | Redis pour BullMQ (fallback inline si absent) |
| `RENDER_EXTERNAL_URL` | non | URL backend (défaut: `https://omnisms-backend.onrender.com`) |
| `DEFAULT_PHONE_COUNTRY` | non | Code pays défaut normalisation (défaut: `BF`) |

---

## 11. SMS Gateway / Architecture Z Fold2

**BLOCKER ⚠️** : L'architecture cible mentionne un Samsung Z Fold2 comme gateway physique.

Dans l'implémentation actuelle, **ce rôle est joué par Infobip** :
- Infobip agit comme l'intermédiaire entre le backend et le réseau SMS physique
- Infobip gère les SIM cards côté réseau
- Aucun téléphone Android n'est actuellement intégré dans le backend

**Si l'objectif est d'utiliser le Z Fold2 avec une application SMS Gateway** (ex: SMSGatewayHub, Android SMS Gateway, KarmaAPI, etc.) **au lieu d'Infobip** :

Les informations suivantes sont **REQUISES avant toute implémentation** :
1. Nom de l'application SMS Gateway installée sur le Z Fold2
2. URL d'API exposée par l'application (IP locale ou URL publique ngrok/Cloudflare Tunnel)
3. Méthode d'authentification (Bearer token, Basic auth, API key header ?)
4. Format de l'API pour **envoyer un SMS** (méthode, endpoint, body JSON)
5. Format du **webhook entrant** (comment le gateway notifie le backend des SMS reçus)
6. Disponibilité réseau (le Z Fold2 doit être accessible depuis Render)

**Ces informations ne peuvent pas être inventées. Elles doivent être fournies par l'utilisateur.**

---

## 12. Règles absolues

1. **Ne pas toucher au système de paiement** (`routes/payment.leekpay.js`, `services/leekpay.js`)
2. **Ne pas casser le mode Online** (`makeConversationId`, `routeMessage` OMNISMS branch)
3. **Ne pas réécrire ce qui fonctionne** — étendre, corriger, compléter
4. **Toujours utiliser `process.env` pour les secrets** — jamais de hardcode
5. **Valider les webhooks** avec `INFOBIP_WEBHOOK_SECRET` si configuré
6. **Déduplication systématique** des webhooks Infobip (Redis ou Map mémoire)
7. **Normaliser les numéros** via `phoneNormalizer.normalizePhone()` systématiquement
