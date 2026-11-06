# AUDIT AVANT FINALISATION — OmniSMS Backend
**Date** : 2026-11-05 · **Mode** : lecture seule (aucun fichier modifié, aucun redéploiement, aucun SMS, aucune donnée touchée — ce rapport est créé sans commit).
**Périmètre vérifié** : dépôt local (`090fac5`, = GitHub = prod), GitHub Actions, endpoints publics de production, `/health`, `/readyz`, `/metrics`, `/api/diag` (valeurs masquées par le serveur), code source, suites de tests relancées.

---

## 1. Résumé exécutif

Le backend est **stable en HTTP** (12,4 jours d'uptime sans redémarrage, 0 erreur 5xx sur ~4 100 requêtes) et **entièrement testé** (22/22 suites vertes, relancées aujourd'hui). Les corrections des missions d'octobre sont toutes **en production** : contrat photo unifié, politique « interne d'abord » (offline-hold), disjoncteur Redis (qui a déjà prouvé son utilité, voir §3), vérification OTP dormante.

**Mais trois réalités encadrent le lancement :**
1. **Le quota Redis Upstash est épuisé depuis ~13 jours** — les files BullMQ sont à l'arrêt, les jobs (SMS retry, transcription) tournent en mode dégradé inline. Le service survit, mais ce n'est pas un état de production durable.
2. **Aucune preuve de SMS réellement envoyés en volume** : les métriques SMS sont vides. La passerelle INfiniReach est configurée et active, mais son efficacité de bout en bout n'a jamais été démontrée par un test documenté sur un vrai téléphone.
3. **iOS n'existe pas** côté vérifiable : rien dans ce dépôt ne concerne l'app iOS ; seul le backend est prêt à servir un client mobile.

**Verdict** : le backend est prêt à ~80 % pour un lancement Android au Burkina Faso. Les blocages restants sont peu coûteux (une variable Render, $10/mois de Redis, un test SMS réel) mais **indispensables avant toute publicité**.

## 2. Inventaire des services et environnements

| Élément | État (fait vérifié) |
|---|---|
| Dépôt | `emstronglezin-cmd/Omnisms-backend`, branche `main`, HEAD `090fac5` = **identique local/GitHub/prod** |
| Changements non commités | **0** (3 rapports volontairement hors git : PRESENTATION_PROJET, RAPPORT_TROIS_MISSIONS, UX_ET_PUBLICATION_PLAY) |
| CI GitHub Actions | Runs #68–#73 : tous success (le seul échec #69 du 23/10 a été corrigé par #70). Dernier : #73 le 23/10 15:03 |
| Service Render | `omnisms-backend` (web unique, workers embarqués `WORKER_IN_WEB_PROCESS=true`) — démarré 23/10 ~15h UTC, **uptime 1 071 721 s (12,4 j)** au moment de l'audit |
| Passerelle SMS | **INfiniReach** (`sms_gateway`) : configuré, non en pause, webhook entrant `routes/sms.gateway.inbound.js` monté ; **SMSGate** : non configuré (dort derrière sa config) ; **Infobip** : retiré du code et des routes (vérifié, zéro référence dans /health) |
| Base de données | Firestore (Firebase) — `readyz: firebase ok`. Accès direct aux données impossible depuis le sandbox (non vérifié : contenu, règles de sécurité Firestore) |
| Redis/Upstash | Configuré (`REDIS_URL` set) mais **quota commandes épuisé** → `inline-quota` |
| Paiements | SAASPAY configuré (`sk_l…`), LeekPay (statut dans /health : payments ACTIVE) |
| Config critique manquante en prod | **`BACKEND_URL` MISSING** (impact §8), `SMSGATE_*` absent (choix), `WHISPER_MODEL`/`GROQ_WHISPER_MODEL` absents (défaut utilisé) |
| Secrets dans le dépôt | **Aucun** détecté (scan ghp_/AIza/sk-/AKIA sur fichiers trackés : 0 résultat) |

**Impossible à vérifier depuis le sandbox** : dashboard Render (logs complets, redémarrages manuels, valeur réelle des variables), dashboard Upstash (date de reset du quota), contenu Firestore, clé API Render (non fournie).

## 3. État du serveur et incidents de production

**Faits vérifiés (production, au 2026-11-05 00:46 UTC) :**
- `/livez` 200 ×3 en ~0,25 s ; `/readyz` : firebase ok, redis ok, bullmq false.
- `/health` : tous checks `ok`/`ACTIVE` sauf queue (voir incident). JWT ok, Socket.IO actif, transcription « ACTIVE via groq-whisper ».
- `/metrics` : 4 069 requêtes cumulées — **0 en 5xx** ; 453 en 404 (scanners + routes GET inexistantes sur endpoints POST) ; ~3 500 sont des `HEAD /` (monitoring Render). **Trafic utilisateur réel estimé : ~550 requêtes en 12 jours → quasi aucun utilisateur actif.**
- **Incident n°1 (en cours)** : quota Upstash `ERR max requests limit exceeded` → depuis le disjoncteur du 23/10 : workers arrêtés proprement, jobs en exécution inline, **zéro boucle d'erreurs, zéro redémarrage**. Le service ne ment pas sur son état (`queue.mode: "inline-quota"` dans /health). Conséquence réelle : les retries SMS ne sont plus asynchrones et la transcription audio devient synchrone (risque de timeout sur audio long).
- **Incident n°2 (chronique, sans évidence d'impact)** : aucun envoi SMS visible dans les métriques — soit aucun déclenchement, soit instrumentation insuffisante. À instrumenter avant lancement.
- `/metrics` et `/api/diag` répondent **sans authentification** (valeurs masquées, mais expositions de surface : noms de variables, absence/présence de secrets, compteurs). Risque de reconnaissance faible mais inutile — à protéger.
- `INFINIREACH_WEBHOOK_SECRET` : le webhook entrant passerelle est **permissif si le secret n'est pas configuré** (accepte tout). État réel de la variable inconnu (non listée par /api/diag). Si absent, **n'importe qui peut poster de faux SMS entrants** → risque crédits/fraude. À vérifier et configurer en priorité.

## 4. Fonctionnement réel de la messagerie (chemins vérifiés dans le code)

**A. OmniSMS → OmniSMS (APK, PWA, indifférent) :**
1. Client → `POST /api/messages` (ou Socket.IO `message:send` avec ack `{success, messageId, tempId, conversationId}`).
2. `messageRouter.routeMessage` résout le destinataire (compte Firestore par téléphone/username) :
   - **en ligne** → persistance Firestore (`channel: app`, statut `sent`) + Socket.IO `message:receive` au(x) socket(s) de l'utilisateur (registre multi-appareils) ;
   - **hors ligne** → depuis le 23/10 (`ROUTE_OFFLINE_HOLD=true` par défaut) : message gardé en interne (`pending`), **jamais converti en SMS** ; livré à la reconnexion par `deliverPendingMessages` avec claim avant émission (anti-doublon, testé) ;
   - **externe** (numéro sans compte OmniSMS) → file SMS (inline en ce moment) → INfiniReach.
3. Statuts : sent/pending/delivered côté interne ; SMS : accepté/envoyé/échec selon retours réels de la passerelle. **Limite** : accusés de réception SMS de bout en bout non garantis (dépend de l'appareil passerelle).
**B. APK ↔ PWA** : même chemin serveur — aucune différence de flux (contrats Socket.IO partagés, testés).
**C. Passerelle Android → backend** : l'app INfiniReach du téléphone-passerelle reçoit les ordres d'envoi via le pool (`GATEWAY_POOL_ENABLED`, multi-appareils) et pousse les SMS **entrants** vers `routes/sms.gateway.inbound.js` (HMAC si secret configuré — cf. §3). Points de défaillance : le téléphone (batterie, réseau, SIM), l'absence d'appareil en ligne (aucun ordre d'envoi possible — en ce moment les jobs partent en inline = **envoi direct bloqué si la passerelle ne tourne pas**).
**Risques de doublons (couverts, testés)** : `jobId: sms-{messageId}` (dédup BullMQ), ledger idempotent par messageId, claim-before-emit à la reconnexion, anti-doublon SMSGate en attente d'activation.

## 5. Solution SMS : faisabilité et limites (aucun SMS envoyé pendant l'audit)

**Rôles réels** : backend = orchestration/quotas/crédits ; INfiniReach (app Android sur le téléphone du propriétaire + SIM locale) = transport sortant et entrant ; SMSGate (open source, JWT, anti-doublon intégré) = alternative passerelle prête mais non configurée ; queues = asynchronisme (dégradé inline actuellement).

**Limites Android (documentées, non réinventées)** : autorisation SMS/défaut, désactivation de l'optimisation batterie, téléphone allumé + SIM créditée + réseau. **iOS** : il est **techniquement impossible** pour une app iOS d'envoyer ou de lire des SMS programmatiquement — un iPhone ne peut jamais servir de passerelle ; l'app iOS pourra seulement envoyer des messages internes, et compter sur la passerelle Android du côté émetteur (ou un fournisseur externe) pour l'externe.

**Coûts** : connus et vérifiés — Redis $10/mois (Render KV Starter ou Upstash Fixed), Render web (plan actuel), 0 $ par SMS via SIM (hors forfait SIM BF de l'utilisateur, montant exact inconnu de moi). Inconnus : volume de SMS par utilisateur réel, coût/rentabilité à l'échelle, frais éventuels de la passerelle SMSGate cloud. **Aucun tarif inventé.**

**Options comparées** :
1. **Passerelle Android (actuelle, INfiniReach)** : coût marginal ~0, adaptée au BF (SIM locale, pas d'agrégateur), MAIS fiabilité = celle d'un seul téléphone, débit limité (~1 SMS/quelques secondes), et pas de SMS si le téléphone dort.
2. **Fournisseur externe (type Twilio/Terminus/agrégateurs locaux)** : fiable et scalable, mais coût par SMS réel au BF (à chiffrer AVANT décision — je ne l'invente pas), intégration à écrire.
3. **Hybride (recommandé)** : passerelle Android par défaut (gratuit) + interrupteur config vers un fournisseur externe en repli/montée en charge. L'architecture le permet déjà (`OFFLINE_SMS_PROVIDER`, couche d'abstraction, SMSGate prêt) — il ne manque que le choix commercial et, le cas échéant, un nouveau provider.

**Prévention doublons / reprise** : en place et testée (cf. §4). **Suivi de livraison** : partiel (statuts internes fiables ; DLR SIM non garanti).

## 6. Tableau des fonctionnalités backend

| Fonctionnalité | État | Preuve / test | Blocage éventuel | Action |
|---|---|---|---|---|
| Inscription / connexion (JWT+bcrypt, 7 j) | ✅ Vérifiée | Code + 401 en prod + suites auth ; token actif de prod fonctionne | — | — |
| Google OAuth (+ variantes APK, contacts) | ✅ Vérifiée | 31 checks ; vars `_APK` à poser côté Render (rappel ancien) | vars APK absentes ? (dashboard) | poser les 2 vars |
| Profils & photos | ✅ Vérifiée (serveur) | 19 checks, contrat sur toutes les réponses, déployé | `BACKEND_URL` manquant (avatars `/uploads` relatifs) ; >800 Ko rejeté 413 | ajouter la var ; compression côté app |
| Contacts (sync, détection OmniSMS) | ✅ Vérifiée | suites contacts/routing ; alias photos | — | — |
| Conversations & historique | ✅ Vérifiée | suites messages/routing ; persistance Firestore | — | — |
| Groupes (création, membres, photos) | ✅ Vérifiée (contrat étendu 23/10, non encore testé sur APK réel) | 19 checks photos/groupes | — | test réel APK |
| Messages internes | ✅ Vérifiée | routing-presence, offline-hold 11/11, matrix | — | — |
| SMS externes via INfiniReach | ⚠️ Partielle | configuré + actif (/health) ; zéro métrique d'envoi réel | jamais démontré de bout en bout dans les logs fournis | test réel documenté (§10) |
| Passerelle Android (webhook entrant) | ⚠️ Partielle | code + HMAC disponible | secret éventuellement absent (permissif) | configurer `INFINIREACH_WEBHOOK_SECRET` |
| SMSGate (2ᵉ passerelle, repli) | 🟡 Non activée | 18/18 tests simulés ; `configured: false` en prod | choix non fait | décision propriétaire |
| Notifications (FCM) | ⚠️ Partielle | `services/firebase.js` → `messaging.send` branché (crédits, routeur) | pas de test visible d'envoi réel ; tokens device inconnus | test réel |
| Présence (3 états, multi-appareils) | ✅ Vérifiée | 16 checks + hardening | — | — |
| OTP / vérification numéro | 🟡 Prête, dormante | 17+25 checks ; flag off par défaut | coût SMS OTP non arbitré | décision produit |
| Suppression de compte | ✅ Vérifiée | 16/16 | — | — |
| Tâches de fond (files BullMQ) | 🔴 Bloquée (dégradée) | `/health` : `inline-quota`, quota épuisé ~13 j | quota Upstash | migrer Redis ($10) |
| Transcription audio (Groq) | ⚠️ Partielle | clé présente, worker actif | synchrone tant que Redis quota épuisé | résoudre Redis |
| Paiements (SAASPAY/LeekPay) | 🟡 Partielle | secrets présents, suites offline vertes | **aucun paiement réel testé** | test transaction réelle minime |

## 7. Notes sur 5 (honnêtes, justifiées)

| Axe | Note | Justification |
|---|---|---|
| Utilité | **4/5** | Besoin réel au BF : joindre quelqu'un sans data/Internet-data ni compte OmniSMS via SMS, avec prévention des frais (interne gratuit d'abord — offline-hold). Mécanismes réellement codés et testés. |
| Différenciation | **3/5** (provisoire) | Hybride messagerie+SMS via SIM locale = vrai différenciant vs WhatsApp/Telegram (pas de SMS sortant) ; mais les apps « SMS via cloud » existent (Google Messages par satellite hors ligne, etc.) et l'exécution comptera plus que l'idée. |
| Fiabilité actuelle | **2,5/5** | HTTP très stable (12,4 j, 0 5xx) et 22/22 suites, MAIS files dégradées depuis 13 jours, zéro preuve d'envoi SMS en volume, webhook passerelle potentiellement permissif. |
| Potentiel de monétisation | **2,5/5** | Packs crédits + intents OM codés et idempotents, SAASPAY branché — mais aucun revenu prouvé, aucun paiement réel testé, et la valeur payante (SMS externe) dépend d'une passerelle mono-téléphone. |
| Préparation au lancement | **2/5** | Backend ~prêt ; il manque : Redis payant, `BACKEND_URL`, secret webhook, test SMS réel documenté, test de paiement, et toute l'app iOS (inexistante/vérifiable). Aucune publicité possible avant §10. |

## 8. Blocages classés par gravité

| # | Gravité | Blocage | Action | Coût |
|---|---|---|---|---|
| 1 | 🔴 Critique | Quota Upstash épuisé → files arrêtées, retries/transcription dégradés (depuis ~13 j) | Créer Render Key Value Starter (même région) → remplacer `REDIS_URL` (plan §6 de docs/REDIS_QUOTA.md, réversible) | $10/mois |
| 2 | 🔴 Critique (fraude) | Webhook passerelle peut-être en mode permissif (accepte tout si `INFINIREACH_WEBHOOK_SECRET` absent) | Vérifier/configurer le secret sur Render + côté app INfiniReach | 0 $ |
| 3 | 🟠 Haute | 25 vulnérabilités npm prod (3 critiques, 15 hautes : body-parser, compression, Engine.IO/Socket.IO DoS, chaîne firestore) | `npm audit fix` (sans --force d'abord), montée de version Socket.IO planifiée avec tests | 0 $ |
| 4 | 🟠 Haute | `BACKEND_URL` manquant en prod (avatars `/uploads` non absolutisés pour l'APK ; fallbacks codés en dur ailleurs) | Ajouter `BACKEND_URL=https://omnisms-backend.onrender.com` sur Render | 0 $ |
| 5 | 🟠 Haute | `/metrics` et `/api/diag` publics | Restreindre par token/admin (exigence METRICS_TOKEN déjà prévue) | 0 $ |
| 6 | 🟡 Moyenne | SMS externes jamais démontrés de bout en bout (métriques SMS vides) | Test réel documenté sur le téléphone passerelle (§10) | SMS SIM |
| 7 | 🟡 Moyenne | Paiement réel jamais testé | Une transaction minimale réelle (0,5 crédit par ex.) puis remboursement/annulation selon le PSP | ~1 transaction |
| 8 | 🟢 Basse | SMSGate non configuré (plan B), vars `WHISPER_MODEL` non fixées, 3 rapports hors git | Décisions propriétaire | 0 $ |

## 9. Plan de finalisation ordonné (aucune action exécutée pendant l'audit)

1. **Semaine 1 — socle de fiabilité (toutes actions Render = propriétaire)** : Render Key Value + `REDIS_URL` → vérifier `/health` `queue.mode: "redis"` ; ajouter `BACKEND_URL` ; configurer `INFINIREACH_WEBHOOK_SECRET` ; `npm audit fix` avec régression 22 suites ; restreindre `/metrics` + `/api/diag`.
2. **Semaine 2 — preuves réelles** : test SMS sortant + entrant documenté via INfiniReach (logs + métriques) ; test OTP sur vrai numéro si l'OTP sera activé au lancement ; test paiement réel minimal ; test APK complet (photos légères, groupes, offline-hold).
3. **Semaine 3 — instrumentation & durcissement** : métriques SMS (compteurs déjà prévus — à exposer), alerte sur `queue.mode != redis` et sur quota à 80 %, sauvegarde/restauration Firestore documentée.
4. **Semaine 4 — décision SMS & iOS** : chiffrer 2–3 fournisseurs externes BF (pas de tarif inventé ici) ; lancer l'app Flutter→iOS avec la checklist contrat (le backend est déjà compatible) ; beta fermée Android.

## 10. Tests nécessaires AVANT déploiement/publicité (checklist go/no-go)

1. SMS externe réel : interne→numéro non-inscrit via INfiniReach, reçu sur un vrai téléphone, statuts observés dans les logs.
2. SMS entrant réel : répondre au numéro passerelle → message arrivé dans la conversation OmniSMS (webhook signé).
3. OTP réel (si activé) : réception + expiration + limites.
4. Photos : upload APK d'une photo < 800 Ko → visible sur un 2ᵉ appareil ; erreur 413 claire si plus grande.
5. Offline-hold : message à un utilisateur hors ligne → aucun SMS facturé, livraison à la reconnexion.
6. Paiement : 1 transaction réelle de bout en bout (intention → OM SMS → crédit → solde), puis rejouer le SMS = pas de double crédit (idempotence).
7. Charge douce : 50 messages/min internes + 10 SMS — latence et erreurs dans les seuils.
8. Reprise : kill/redémarrage du service pendant une file active → aucun SMS en double (jobId + ledger).
9. Sécurité : webhook sans signature rejeté (après secret), `/metrics` 401, `/api/diag` protégé.

## 11. Questions au propriétaire (à répondre avant corrections)

1. **Redis** : tu valides $10/mois (Render KV ou Upstash Fixed) ? Sans cela, le lancement se fera en mode dégradé permanent.
2. **Le téléphone passerelle INfiniReach** : où est-il, est-il allumé 24/7 avec du crédit SIM ? Qui le surveille ?
3. **`INFINIREACH_WEBHOOK_SECRET` est-il configuré** sur Render et dans l'app ? (je ne peux pas le voir).
4. **OTP au lancement** : activé (coût : 1 SMS par inscription) ou différé ?
5. **Monétisation** : les crédits payants sont-ils le modèle validé ? As-tu testé SAASPAY/LeekPay en réel, et à quel tarif vends-tu les packs (les prix sont-ils déjà fixés quelque part) ?
6. **iOS** : quelle est la réalité du projet (code Flutter partagé ? budget ?) — le backend ne peut rien y faire seul.
7. **Volume cible** : combien d'utilisateurs/SMS par mois vises-tu au lancement ? (détermine passerelle seule vs hybride).
8. **Les 3 rapports hors git** (PRESENTATION_PROJET, RAPPORT_TROIS_MISSIONS, UX_ET_PUBLICATION_PLAY) : à committer, garder locaux, ou supprimer ?

---
*Faits vérifiés cités ci-dessus : endpoints publics de production interrogés le 2026-11-05, dépôt `090fac5`, suites de tests relancées (22/22), CI #68–#73. Tout ce qui relève des dashboards Render/Upstash/Firestore est explicitement marqué « impossible à vérifier » ou « inconnu ».*
