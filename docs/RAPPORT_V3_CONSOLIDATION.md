# RAPPORT FINAL — OMNISMS BACKEND V3 (consolidation SMSGate, routage, push, sécurité)
**Date** : 2026-11-06 · Commits locaux non poussés : `ebd4ae6` (push V3), `83a9b9d` (alignement SMSGate), `1ea57bc` (test isolation). **Aucune simulation déguisée en succès ; tout ce qui n'a pas été vérifié réellement est marqué NON TESTÉ.**

## 1. Architecture backend auditée
Node/Express + Firestore + Socket.IO + BullMQ/ioredis (dormant sans quota) + transports SMS pluggables (android_gateway outbox Firestore > SMSGate > INfiniReach) + registre push FCM/APNs. `selectTransport()`/`getProviderStatus()` sont les points de vérité irrigués par `isEnabled()`.

## 2. Fichiers modifiés (missions V3, tous commits)
`services/smsGateProvider.js` (aliases SMS_GATEWAY_* + auth auto JWT→Basic + activation par credentials) · `services/smsProvider.js` · `server.js` (health/diag) · `services/pushService.js` (nouveau) · `routes/notifications.js` (préférences originales préservées + register/unregister/devices) · `services/messageRouter.js` (push offline fire-and-forget) · `services/smsQueueWorker.js`/`services/otpService.js` (transports) · `services/androidGateway.js`+`routes/gateway.js` (passerelle Android, mission précédente) · `.env.example`, `docs/*` · tests : `smsgate-aliases` (13), `smsgate-routing-isolation` (11), `push-notifications` (20), `android-gateway` (24), et suites mises à jour.

## 3. Problèmes détectés
1. Le provider SMSGate dormait : le code attendait `SMSGATE_*` + `OFFLINE_SMS_PROVIDER=smsgate`, pas tes 4 noms Render. 2. Le mode strict du webhook était ignoré sans secret (corrigé plus tôt le 06/11). 3. `/api/diag` non protégé (corrigé, gated par ADMIN_KEY — vérifié 401 en prod). 4. Mon premier patch push avait écrasé le routeur de préférences — détecté et fusionné proprement. 5. Risque nouveau lié à l'activation par credentials : un message interne aurait pu être détourné vers SMSGate → **prouvé non** (test isolation §5).

## 4. Problèmes corrigés
Voir §2/§3 — tous corrigés et couverts par tests. Aucune route supprimée, aucun contrat Flutter/PWA modifié, aucune donnée touchée, aucune variable Render renommée.

## 5. Intégration SMSGate — résultat RÉEL
- **Variables** : les 4 noms Render (`SMS_GATEWAY_LOGIN/PASSWORD/DEVICE_ID/SERVER_ADDRESS`) sont lus en priorité — **13/13** + **boot réel : `📡 SMS provider: ✅ smsgate`, `activeProvider: smsgate`**.
- **Sonde réelle du cloud officiel** (`api.sms-gate.app`, depuis le sandbox) : `GET /3rdparty/v1/health` → **200** `{"status":"pass","version":"1.52.5…"}` ; `POST /auth/token` avec faux identifiants → **401** (endpoint JWT réel présent). **Aucun SMS envoyé.**
- **Auth** : mode auto (JWT d'abord, repli Basic permanent si le serveur n'expose pas /auth/token) — compatible cloud ET serveurs privés ; identifiants jamais loggés (testé).
- **Device ID** : transmis dans chaque payload d'envoi (testé).
- **Connexion avec TES valeurs réelles** : NON TESTÉ (les valeurs sont dans Render ; je ne les demande jamais).

## 6. Test SMS externe réel : **NON TESTÉ**
Aucun téléphone de test autorisé ne m'a été fourni, aucun SMS envoyé. Procédure prête après déploiement : `curl -X POST …/api/diag/sms-test -H "x-admin-key: …" -d '{"to":"+226TONNUMÉRO"}'` → le SMS doit arriver sur ton téléphone (routé SMSGate) ; vérifier le statut via l'app SMSGate. Je ne l'exécute pas sans ton numéro + ton accord.

## 7. Messagerie interne : **RÉUSSI** (tests comportementaux)
Interne en ligne → Socket.IO `message:receive`, Firestore, **0 SMS** ; hors ligne → attente interne (offline-hold), **0 SMS** ; livraison reconnexion sans doublon (claim-before-emit). Preuve : routing-presence (16), routing-offline-hold (11), **isolation SMSGate 11/11** (aujourd'hui, avec SMSGate activé).

## 8. Notifications Socket.IO : **RÉUSSI — intactes**
Aucune modification du canal temps réel ; régression complète verte incluant les suites realtime. Le push n'intervient QUE pour les appareils sans socket (arrière-plan/fermé).

## 9. Notifications FCM/APNs : serveur prêt — **NON TESTÉ sur appareil**
Endpoints tokens (20/20 tests, JWT obligatoire, isolation inter-comptes, invalidation auto, préférence `notificationsEnabled` respectée) + dispatcher multicast (FCM simulé). **NON TESTÉ** : envoi FCM réel (exige app Android avec firebase_messaging + console Firebase) ; APNs (exige clé .p8 console + app iOS). Socket.IO non remplacé.

## 10. Sécurité
**Corrigés** : webhook strict fail-closed (INFINIREACH_REQUIRE_SIGNATURE respecté) · `/api/diag` gated ADMIN_KEY (401 vérifié en prod) · `/metrics` gate METRICS_TOKEN (prêt, variable à poser) · tokens push hashés/masqués, 403 inter-comptes · secrets jamais loggés (vérifié par test sur le chemin SMSGate) · JWT/bcrypt inchangés · validation des entrées conservée.
**Restants (variables propriétaire)** : `METRICS_TOKEN` à poser pour fermer /metrics ; `INFINIREACH_WEBHOOK_SECRET` (+REQUIRE_SIGNATURE=true) tant qu'INfiniReach existe ; BACKEND_URL recommandé (fallback en place). Aucun secret dans le dépôt (scan 0).

## 11. Tests exécutés (résultats réels)
**27/27 suites vertes** aujourd'hui, dont : aliases SMSGate **13/13**, isolation routage SMSGate **11/11** (aujourd'hui), legacy SMSGate **19/19** (sémantique nouvelle), push **20/20**, passerelle Android **24/24**, redis-quota 19, photos 19, OTP 17+25, OAuth 31… **Sonde réseau réelle** api.sms-gate.app : health 200, auth 401 (faux identifiants) — aucun SMS.

## 12. Statut déploiement Render
Prod actuelle = `7a0d61f` (les 3 commits V3 ne sont PAS encore poussés — j'attends ton ordre). Après push : CI + deploy auto ; vérifications post-deploy que je ferai : `/health` → `activeProvider: "smsgate"` ; `/api/diag` 401 sans clé ; 0 erreur au boot (uptime croissant).

## 13. Variables manquantes éventuelles (noms seulement, jamais de valeurs)
`METRICS_TOKEN` · `INFINIREACH_WEBHOOK_SECRET` · `INFINIREACH_REQUIRE_SIGNATURE` · `BACKEND_URL` (recommandé) — **les 4 SMSGATE `SMS_GATEWAY_*` sont reconnues telles quelles** ; rien à renommer.

## 14. Points restant à traiter
1. Push → push ces 3 commits, puis **test SMS réel** (ton numéro, §6). 2. Vérifier que le `SERVER_ADDRESS` de ton app est joignable depuis Render (cloud ou serveur privé public — une adresse LAN ne l'est pas). 3. App Android passerelle (contrat `docs/ANDROID_GATEWAY.md` §7) si tu veux la stratégie android_gateway ; sinon SMSGate suffit. 4. Console Firebase + intégration Flutter pour le push réel. 5. `npm audit fix` (25 vulnérabilités). 6. Redis : REPORTÉ (le mode inline + outbox tient la charge actuelle sans dépense).
