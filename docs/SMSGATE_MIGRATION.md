# Migration SMS → SMSGate (open source) — rapport d'audit & plan
**Date** : 2026-10-14 · **Décisions opérateur** : (1) Infobip **retiré entièrement** du projet ; (2) INfiniReach **isolé et mis en pause** (code conservé, plus jamais sélectionné automatiquement) ; (3) SMSGate = fournisseur cible, réversible par configuration.
**Source du contrat** : docs officielles docs.sms-gate.app (API + authentification) et fichiers d'exemples officiels du serveur (`api/requests.http`, `api/local.http`, dépôt `android-sms-gateway/server`) — endpoints vérifiés, pas inventés.

---

## 1. Contrat SMSGate vérifié (source officielle)

| Élément | Valeur officielle |
|---|---|
| API cloud | `https://api.sms-gate.app` (préfixe `/3rdparty/v1`) — serveur privé auto-hébergé : mêmes routes sur ton instance (préfixe configurable, `SMSGATE_API_PREFIX`) |
| Auth (recommandée) | **JWT** : `POST /3rdparty/v1/auth/token` (Basic `user:pass`, body `{ttl, scopes}`) → `{access_token, refresh_token, expires_at}` ; refresh `POST /3rdparty/v1/auth/token/refresh` (Bearer refresh) avec **rotation** (l'ancien couple est révoqué) ; scopes demandés : `messages:send`, `messages:read`, `devices:list` |
| Auth legacy | Basic (fallback `SMSGATE_AUTH_MODE=basic`) |
| Envoi | `POST /3rdparty/v1/messages` — body `{message, phoneNumbers:[…], ttl?, withDeliveryReport:true, deviceId?}` → identifiant(s) retourné(s) (`id` string ou tableau) |
| Statut | `GET /3rdparty/v1/messages/{id}` → état terminal **`Delivered`/`Failed`**, intermédiaires **`Pending`/`Sent`** |
| Santé | `GET /3rdparty/v1/health` |

**Choix serveur privé vs public pour l'OTP** (exigé) : l'API **publique** transmet contenu + numéros via l'infrastructure SMSGate cloud → **non recommandée pour les OTP** (données sensibles, pas de contrôle du périmètre). Recommandation documentée : **serveur privé auto-hébergé** (dépôt `android-sms-gateway/server`, Docker) pour tout, OTP en particulier ; `SMSGATE_BASE_URL` pointera ton instance. La variable accepte les deux — c'est une décision de configuration, pas de code.

## 2. Audit du dépôt (fichiers concernés, vérifiés un par un)

**Envoi SMS actuel** : point d'entrée unique `services/smsGateway.js` (`sendSMS()`), appelé par `services/messageRouter.js` (fallback offline + SMS externes), `routes/sms.gateway.inbound.js` (copie SMS propriétaire hors ligne), `services/otpService.js` (transport `gateway`), `services/smsQueueWorker.js` (retry BullMQ). Sélection : `OFFLINE_SMS_PROVIDER` (`sms_gateway`=INfiniReach défaut | `infobip`) + fallback `OFFLINE_SMS_FALLBACK_TO_INFOBIP`.

**Infobip — empreinte complète (22 fichiers référencent, à traiter)** :
- À **supprimer** : `services/infobip.js`, `routes/infobip.inbound.js` (webhook entrant Infobip), `routes/sms.infobip.js` (routes diag), montages `server.js` (329/346/357), diagnostics `server.js` (`checkInfobip`, bloc `infobipDetails`, `/api/diag/sms-test`), `services/smsProvider.js` (wrapper « Infobip only »), logique de fallback dans `smsGateway.js`/`messageRouter.js` (bloc `OFFLINE_SMS_FALLBACK_TO_INFOBIP`), transport dans `otpService.js`, variables `INFOBIP_*` de `render.yaml` et `.env.example`.
- **Conservés tels quels** (noms de champs historiques, pas un usage du fournisseur) : champ Firestore `infobipNumber` des `external_conversations` (nom de colonne = compatibilité données/frontend — renommer casserait l'historique), mentions dans commentaires/tests.

**INfiniReach — mise en pause (pas de suppression)** : `services/smsGateway.js` (client HTTP + webhook entrant existants) reste **intact** ; il n'est sélectionné que si `OFFLINE_SMS_PROVIDER=sms_gateway` explicitement. Aucun fallback automatique vers lui ni vers quiconque.

**Non concerné (vérifié)** : messages internes Socket.IO, présence, OTP (règles métier/limites), crédits, paiements, webhooks gateway entrants (`routes/sms.gateway.inbound.js` reste pour INfiniReach ET pour les accusés SMSGate si `withDeliveryReport` + webhooks configurés plus tard).

## 3. Risques

1. **Doublons en cas d'ambiguïté** (timeout après acceptation) → traité : le provider mémorise `messageIdOmniSMS → idSMSGate` et, à une nouvelle tentative du même message, **vérifie le statut avant de renvoyer**.
2. **OTP via l'API publique** → documenté (§1) : serveur privé recommandé ; config uniquement, pas de code spécial.
3. **Casser les tests** qui injectent un stub Infobip → les tests tournent avec `infobip` absent (les `try/require` du routeur dégradent proprement) ; régression complète relancée.
4. **Webhook entrant Infobip supprimé** → Infobip n'étant plus utilisé, aucune perte ; l'entrant INfiniReach (et plus tard SMSGate via webhooks) reste.
5. **Contrats Flutter/frontend** : aucun endpoint consommé par les apps ne disparaît (`/api/sms/infobip/*` était du diagnostic interne, retiré de la carte `/health`).

## 4. Plan (commits atomiques)

1. **Rapport** (ce fichier).
2. **Retrait Infobip + pause INfiniReach** : nettoyage des sélections de transport, suppression fichiers/montages/variables, `smsProvider.js` neutre. Défaut `OFFLINE_SMS_PROVIDER` **inchangé** (`sms_gateway`) → la prod ne change pas tant que la config Render n'est pas modifiée.
3. **`services/smsGateProvider.js`** : JWT (token+refresh avec rotation, cache, scopes minimaux), envoi, statuts, timeouts, anti-doublon, journalisation sans secrets ; délégation depuis `smsGateway.sendSMS` quand `OFFLINE_SMS_PROVIDER=smsgate` ; **tests** avec serveur SMSGate simulé local (aucun SMS réel).
4. **Docs** : variables Render exactes, étapes manuelles SMSGate, test téléphone réel, déploiement progressif, rollback.

## 5. Réversibilité

Retour à l'ancien monde = **une variable** : `OFFLINE_SMS_PROVIDER=sms_gateway` (INfiniReach redevient actif s'il est configuré) — aucun code à redéployer. `SMSGATE_*` retirées = SMSGate hors service. Jamais d'envoi simultané par deux fournisseurs.

---

## 6. Livraison — fichiers modifiés (commits `8bcc931`, `18aeb03`, `ed?…`)

| Fichier | Rôle |
|---|---|
| `services/smsGateProvider.js` (**nouveau**) | Fournisseur SMSGate : JWT (token+refresh avec rotation, scopes minimaux), envoi `POST /messages`, statuts `GET /messages/{id}` (Pending/Sent/Delivered/Failed), timeout configurable, 429 géré, anti-doublon sur résultats ambigus, zéro secret dans les logs |
| `services/smsGateway.js` | Délégation à SMSGate quand `OFFLINE_SMS_PROVIDER=smsgate` (point d'entrée unique : routeur, webhook entrant, OTP) ; `isInfobipFallbackEnabled()` → false (déprécié) ; INfiniReach intact mais **jamais appelé** dans ce mode |
| `services/messageRouter.js` | Sélection : smsgate > sms_gateway (si explicitement choisi) > none ; fallbacks Infobip supprimés ; branche smsgate d'envoi direct |
| `services/smsQueueWorker.js` | `selectTransport()` : smsgate prioritaire ; plus aucun fallback fournisseur |
| `services/otpService.js` | `OTP_PROVIDER=auto|smsgate` → SMSGate ; valeur `infobip` → avertissement sans effet |
| `services/smsProvider.js` | Réécrit neutre (statut/envoi par fournisseur actif) |
| `server.js` | Infobip retiré (montages, `/health`, diag, carte des routes) ; `smsProvider` rapporté à la place |
| **Supprimés** | `services/infobip.js`, `routes/infobip.inbound.js`, `routes/sms.infobip.js` |
| `render.yaml`, `.env.example` | `INFOBIP_*` retirés ; `SMSGATE_*` + `OFFLINE_SMS_PROVIDER` documentés (sync:false, aucune valeur) |
| `test/smsgate-provider-tests.js` (**nouveau**) | 18 checks contre serveur SMSGate simulé local |
| `test/routing-matrix-tests.js` | Test 9.i inversé : Infobip doit être ABSENT |

## 7. Variables d'environnement exactes (Render)

| Variable | Valeur | Obligatoire |
|---|---|---|
| `OFFLINE_SMS_PROVIDER` | `smsgate` | ✅ (sinon INfiniReach historique) |
| `SMSGATE_BASE_URL` | `https://api.sms-gate.app` (cloud) ou l'URL de ton serveur privé | ✅ |
| `SMSGATE_USERNAME` | identifiant du compte/panel SMSGate | ✅ |
| `SMSGATE_PASSWORD` | mot de passe (**secret Render**, jamais ailleurs) | ✅ |
| `SMSGATE_DEVICE_ID` | id d'un appareil précis | ❌ (omis = n'importe quel appareil en ligne) |
| `SMSGATE_REQUEST_TIMEOUT_MS` | `10000` | ❌ |
| `SMSGATE_AUTH_MODE` | `jwt` (défaut) ou `basic` | ❌ |
| `SMSGATE_API_PREFIX` | `/3rdparty/v1` (défaut ; `''` uniquement si serveur local de l'app) | ❌ |
| Retrait Infobip | supprimer `INFOBIP_API_KEY`, `INFOBIP_BASE_URL`, `INFOBIP_SENDER_ID`, `OFFLINE_SMS_FALLBACK_TO_INFOBIP` de Render | recommandé |

## 8. Étapes manuelles SMSGate (à faire de ton côté)

1. **Installer l'app** « SMS Gateway for Android » sur le téléphone Android dédié, l'ouvrir, accepter SMS/téléphone.
2. **Choisir le mode** : (a) **recommandé OTP** = serveur privé auto-hébergé (dépôt `android-sms-gateway/server`, Docker : `docker run -p 8000:8000 ...`, créer le compte dans le web panel, HTTPS obligatoire devant) → `SMSGATE_BASE_URL` = ton instance ; (b) cloud public `https://api.sms-gate.app` → créer un compte (⚠️ les SMS OTP transiteraient par l'infrastructure tierce — acceptable seulement après ta décision explicite).
3. Noter **identifiant/mot de passe** → variables Render.
4. Récupérer l'**ID de l'appareil** (web panel ou `GET /3rdparty/v1/devices`) si tu veux l'épingler → `SMSGATE_DEVICE_ID`.
5. Désactiver la batterie optimisée pour l'app sur Android (fiabilité).

## 9. Test sur ton vrai téléphone (avant toute activation prod)

1. Variables SMSGATE remplies + `OFFLINE_SMS_PROVIDER=smsgate` sur le service **staging** (ou local avec ton instance).
2. `POST /api/diag/sms-test` (header `x-admin-key`, body `{"to":"+226XXXXXXXX"}`) → le SMS doit arriver sur un vrai numéro → vérifier l'accusé dans SMSGate (état Delivered).
3. Inscription OTP de test si `PHONE_VERIFICATION_REQUIRED=true` → recevoir le code.
4. Message externe via l'app (destinataire sans OmniSMS) → reçu en SMS.
⚠️ **Tant que ce test réel n'est pas fait, la migration ne peut pas être déclarée fonctionnelle en production.**

## 10. Déploiement progressif

1. Staging d'abord (`OFFLINE_SMS_PROVIDER=smsgate`) → §9 OK.
2. Prod : remplir `SMSGATE_*` **sans** changer `OFFLINE_SMS_PROVIDER` → déployer (aucun changement de comportement, provider inactif).
3. Basculer `OFFLINE_SMS_PROVIDER=smsgate` → surveiller 24 h : `[SMSGate]` dans les logs, `/health` → `checks.smsProvider`, taux de `pending`/`failed`.
4. Supprimer ensuite les variables `INFOBIP_*` de Render.

## 11. Retour arrière (< 2 min, sans déploiement)

Render → `OFFLINE_SMS_PROVIDER=sms_gateway` (+ `INFINIREACH_*` valides) → le service redéploie/reboot → INfiniReach redevient le transport. SMSGate peut être neutralisé en vidant `SMSGATE_BASE_URL`. Aucun changement de code nécessaire.

## 12. Résultats réels des tests (locaux, serveur SMSGate simulé, aucun SMS réel)

- `test/smsgate-provider-tests.js` : **18 PASS** (auth JWT + Bearer/Basic, id tableau géré, 4 états, numéro invalide rejeté localement, 500/timeout = ambigu, **retry sans doublon vérifié**, 429, délégation smsGateway, OTP branché).
- Régression : **20 suites vertes** (routage, quota-402, crédits, OTP 17+25, OAuth 31, présence 16, offline-hold 11, account-deletion 16, etc.).
- Boot réel vérifié : `/health` 200 avec `smsProvider` actif/inactif correct.
- **Non testé (impossible en sandbox)** : SMS réel vers un vrai numéro, serveur SMSGate réel (cloud ou privé), DLR réels de bout en bout, multi-appareils. À faire via §9 avant production.
