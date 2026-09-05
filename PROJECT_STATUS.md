# OmniSMS Backend — Statut du Projet

**Version**: 4.3.0  
**Date**: 2026-09-05  
**Environnement**: Production (Render)  
**URL**: https://omnisms-backend.onrender.com

---

## 1. Résumé Exécutif

### Mode Online (OmniSMS ↔ OmniSMS) : ✅ OPÉRATIONNEL

Le mode Online est complet et fonctionnel. Ne pas modifier.

### Mode Offline (OmniSMS ↔ SMS) : ⚠️ PARTIELLEMENT OPÉRATIONNEL

L'architecture Offline est implémentée via Infobip. Elle fonctionne si Infobip est configuré.
Un **BLOCKER** subsiste pour l'intégration du Z Fold2 physique comme gateway.

---

## 2. État des composants

### Backend (Render)

| Composant | Status | Notes |
|---|---|---|
| API Messages (`/api/messages`) | ✅ OK | Online + Offline |
| Auth Firebase | ✅ OK | JWT + Firebase ID Token |
| Socket.IO | ✅ OK | `message:receive`, `sms:inbound`, `sms:delivery` |
| Infobip sortant | ✅ OK si `INFOBIP_API_KEY` + `INFOBIP_BASE_URL` configurés | |
| Infobip entrant (webhook) | ✅ OK | `/api/webhooks/infobip/inbound` |
| Déduplication webhook | ✅ OK (Nouveau) | Redis SETNX + Map fallback |
| SMS Queue Worker | ✅ OK (Nouveau) | BullMQ retry 3× + inline fallback |
| messageRouter.js | ✅ OK | Routing Online/Offline |
| phoneNormalizer.js | ✅ OK | E.164 + multi-variantes |
| userResolver.js | ✅ OK | Résolution phone → UID |
| BullMQ / Redis | ✅ OK si `REDIS_URL` configuré | Inline fallback sinon |
| LeekPay paiements | ✅ OK | Ne pas toucher |
| Transcription Groq | ✅ OK | |

---

## 3. Nouvelles implémentations (session 2026-09-05)

### Phase 2 — SMS Sortant (amélioration)
**Fichier** : `services/messageRouter.js`  
**Changement** : Si `infobip.sendSMS()` échoue, le message est maintenant mis en queue BullMQ pour retry automatique (3 tentatives, backoff exponentiel 3s/9s/27s). Avant cette session, un échec était définitif.

### Phase 3 — SMS Entrant (déduplication)
**Fichier** : `routes/infobip.inbound.js`  
**Changement** : Ajout de `isAlreadyProcessed(messageId)` avant le traitement de chaque SMS entrant. Utilise Redis SETNX avec TTL 24h, avec fallback Map mémoire. Empêche les doublons lors des retries Infobip.

### Phase 6 — Worker SMS Retry
**Fichier** : `services/smsQueueWorker.js` (NOUVEAU)  
**Fonctionnement** :
- `enqueueSmsJob({ to, text, messageId, conversationId, ownerUid })` → ajoute à BullMQ `sms` queue
- `processSmsJob(job)` → worker BullMQ : appelle `infobip.sendSMS()`, met à jour Firestore
- `startSmsWorker()` → démarre le worker (appelé dans `server.js`)
- JobId déterministe `sms-{messageId}` → déduplication BullMQ automatique

**Fichier** : `server.js`  
**Changement** : Ajout du démarrage du SMS worker après le worker transcription.

### Phase 8 — Tests
**Fichier** : `test/offline-sms-tests.js` (NOUVEAU)  
**Résultats** : 37/37 tests PASS ✅

### Phase 10 — Documentation
**Fichiers créés** : `CONTEXT.md`, `PROJECT_STATUS.md` (ce fichier)

---

## 4. Résultats de tests

### Tests Offline SMS (2026-09-05)

```
37 PASS / 0 FAIL / 37 total ✅

── A. SMS Sortant OmniSMS → externe    : 6 PASS
── B. SMS Entrant externe → OmniSMS    : 4 PASS
── C. Online OmniSMS ↔ OmniSMS         : 3 PASS
── D. Numéro inconnu                   : 2 PASS
── E. Numéro déjà OmniSMS              : 2 PASS
── F. Doublon webhook                  : 3 PASS
── G. Erreur du Gateway                : 3 PASS
── H. Retry                            : 3 PASS
── I. Reconnexion Gateway              : 3 PASS
── J. Conservation de l'historique     : 3 PASS
── Bonus hybridSms.js                  : 5 PASS
```

### Tests existants (P0-P4)
Référencer le rapport `BACKEND_STATUS_REPORT.md` : 13/13 PASS (non modifiés).

---

## 5. BLOCKERS

### ⛔ BLOCKER 1 — Z Fold2 / SMS Gateway physique

**Problème** : L'architecture cible mentionne un Samsung Z Fold2 comme gateway physique. Cette intégration n'est **pas implémentée** dans le backend. L'implémentation actuelle utilise Infobip (API cloud).

**Pour intégrer le Z Fold2**, il faut fournir :
- [ ] Nom de l'application SMS Gateway sur le Z Fold2
- [ ] URL de l'API exposée (IP locale + port OU URL publique)
- [ ] Méthode d'authentification (Bearer, API key, Basic auth)
- [ ] Format exact de l'API pour envoyer un SMS
- [ ] Format exact du webhook pour recevoir des SMS
- [ ] Disponibilité réseau (accessible depuis Render ?)

**Impact** : Sans ces informations, l'implémentation Z Fold2 est impossible sans inventer une API.

### ⚠️ BLOCKER 2 — Configuration Infobip sur Render

**Requis** pour que le mode Offline fonctionne en production :
- [ ] `INFOBIP_API_KEY` configuré dans Render environment variables
- [ ] `INFOBIP_BASE_URL` configuré (format: `xxx.api.infobip.com`)
- [ ] Webhook URL configuré dans Infobip portal :  
      `https://omnisms-backend.onrender.com/api/webhooks/infobip/inbound`

### ⚠️ CONFIG OPTIONNELLE mais recommandée

- [ ] `INFOBIP_WEBHOOK_SECRET` → valider les signatures HMAC des webhooks Infobip
- [ ] `REDIS_URL` → activer BullMQ (sinon les retry SMS s'exécutent en mode inline)
- [ ] `INFOBIP_SENDER_ID` → personnaliser le nom de l'expéditeur SMS

---

## 6. Tests réels nécessitant un vrai réseau SMS (non automatisables)

Ces tests nécessitent du matériel réel (SIM, Z Fold2 ou compte Infobip actif) :

| Test | Requis | Description |
|---|---|---|
| Envoi SMS réel | Compte Infobip actif | Vérifier réception sur téléphone physique |
| Réception SMS réel | Compte Infobip + webhook accessible | Envoyer SMS vers numéro Infobip, vérifier apparition dans OmniSMS |
| Latence end-to-end | Réseau opérateur | Mesurer délai OmniSMS → destinataire |
| Tests Z Fold2 | Z Fold2 + app gateway + SIM | Si intégration gateway physique activée |
| Tests délivrance | Compte Infobip actif | Vérifier status DLR (DELIVERED, UNDELIVERABLE) |

---

## 7. Architecture des fichiers modifiés

### Fichiers modifiés (session 2026-09-05)

| Fichier | Type | Description |
|---|---|---|
| `services/smsQueueWorker.js` | **CRÉÉ** | Worker BullMQ SMS retry + enqueueSmsJob() |
| `routes/infobip.inbound.js` | **MODIFIÉ** | Déduplication isAlreadyProcessed() + getRedis() |
| `services/messageRouter.js` | **MODIFIÉ** | Retry via enqueueSmsJob() si sendSMS échec |
| `server.js` | **MODIFIÉ** | Démarrage SMS worker au boot |
| `test/offline-sms-tests.js` | **CRÉÉ** | 37 tests A-J mode Offline |
| `CONTEXT.md` | **CRÉÉ** | Architecture complète |
| `PROJECT_STATUS.md` | **CRÉÉ** | Ce fichier |

### Fichiers déjà existants (non modifiés, fonctionnels)

| Fichier | Rôle |
|---|---|
| `services/messageRouter.js` | Routing Online/Offline (base) |
| `services/infobip.js` | Client Infobip sendSMS/DLR |
| `services/phoneNormalizer.js` | Normalisation E.164 |
| `services/userResolver.js` | Résolution phone → UID |
| `services/hybridSms.js` | Mode USSD SMS (alias) |
| `services/queueService.js` | BullMQ + Redis + inline fallback |
| `routes/messages.v2.js` | API messages REST + routeMessage() |
| `routes/infobip.inbound.js` | Webhook SMS entrant Infobip |
| `routes/sms.infobip.js` | POST /api/sms/send |
| `models/Alias.js` | Alias USSD scopés par expéditeur |
| `models/Invitation.js` | Invitations utilisateurs non-inscrits |
| `services/redis.js` | ioredis + MemoryStore fallback |

---

## 8. Règles de développement

1. **Ne jamais toucher** `routes/payment.leekpay.js`, `services/leekpay.js`, `controllers/leekpayController.js`
2. **Ne jamais modifier** `makeConversationId()` dans `messageRouter.js` (brise Online)
3. **Toujours utiliser** `services/phoneNormalizer.js` pour normaliser les numéros
4. **Toujours utiliser** `services/userResolver.js` pour résoudre phone → UID
5. **Toujours démarrer** par `git status` + audit avant toute modification
6. **Tester** avec `node test/offline-sms-tests.js` après chaque modification offline
7. **Ne jamais hardcoder** de clé API, secret, token dans le code

---

## 9. Guide de déploiement Render

1. Variables d'environnement requises (Render → Settings → Environment) :
   - `INFOBIP_API_KEY`, `INFOBIP_BASE_URL`
   - `FIREBASE_SERVICE_ACCOUNT_JSON`
   - `JWT_SECRET`
   - `REDIS_URL` (optionnel mais recommandé)
   - `INFOBIP_WEBHOOK_SECRET` (optionnel, sécurité)

2. Après déploiement, configurer dans Infobip portal :
   - Channels → SMS → Default inbound webhook URL :  
     `https://omnisms-backend.onrender.com/api/webhooks/infobip/inbound`

3. Vérifier l'état : `GET https://omnisms-backend.onrender.com/health`
