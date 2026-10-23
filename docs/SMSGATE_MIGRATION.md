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
