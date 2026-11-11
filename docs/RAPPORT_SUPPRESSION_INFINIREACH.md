# Rapport — Suppression définitive des configurations obsolètes INFINIREACH

**SMSGate exclusivement** · Statut : nettoyage effectué et testé (simulé) · Commit local en attente de « pousse ».

---

## 1. Références INFINIREACH trouvées (code actif vs historique)

**Code actif (supprimé/neutralisé)** :
- `services/smsGateway.js` — le **client API INfiniReach** complet (https://api.infinireach.io, `X-API-Key`, `INFINIREACH_API_KEY/FROM_NUMBER/API_URL/ENABLED/WEBHOOK_SECRET/REQUIRE_SIGNATURE`, envoi direct, statuts) ; lu aussi par `smsProvider`, `messageRouter` (branches `sms_gateway`), `smsQueueWorker`, webhook entrant, diagnostic démarrage.
- `services/smsProvider.js` — fallback automatique vers INfiniReach + détection par vars.
- `services/messageRouter.js` — sélection transport `infiniReachSelected`/`useGateway`, branches d'envoi `sms_gateway` et `infobip`, hint « Configurer INFINIREACH_API_KEY… ».
- `services/smsQueueWorker.js` — branche retry `sms_gateway`.
- `server.js` — défaut historique `OFFLINE_SMS_PROVIDER || 'sms_gateway'`, diagnostic « [InfiniReach] Configuration au démarrage ».
- `routes/sms.gateway.inbound.js` — route `/sms-gateway/status` qui guidait encore vers INFINIREACH_API_KEY/FROM_NUMBER.
- `.env.example` — bloc INFINIREACH complet + `OFFLINE_SMS_PROVIDER=sms_gateway`.
- `package.json` — description « SMS Infobip ».
- Tests : suite dédiée `test/sms-gateway-tests.js` (51 références) ; stubs de transport sur `smsGateway.js` dans quota-402 / credits-hooks / routing-offline-hold / session13.

**Historique (conservé, sans effet)** : docs/ (SMSGATE_MIGRATION, RUNBOOK_*, STABILISATION…), CHANGELOG/CONTEXT/PROJECT_STATUS, commentaires de données (`infobipNumber`, champ Firestore de conversations — renommer casserait les données), tags de logs DLR, `test/session10|11` (commentaires/copie locale), `loadtest/node-runner.js` (commentaire).

## 2. Configurations supprimées

- **Client INfiniReach supprimé** : `services/smsGateway.js` réécrit en répartiteur générique — plus aucune variable `INFINIREACH_*` lue, plus aucune URL/clé/appel vers api.infinireach.io. Interface publique conservée (nom de fichier historique gardé : harnais et modules l'injectent).
- **Fallbacks automatiques supprimés** : `smsProvider.sendSMS` → SMSGate uniquement ; `messageRouter` et `smsQueueWorker` → plus aucune branche `sms_gateway`/`infobip` ; `isSmsGatewayProvider()` retourne `false` (plus aucune sélection possible).
- **Messages de démarrage remplacés** — le backend annonce désormais :
  ```
  SMS PROVIDER: SMSGATE
  LEGACY PROVIDER: INFINIREACH DISABLED
  ```
  (aucun secret loggé : booléens de configuration uniquement).
- `.env.example` : bloc INFINIREACH supprimé ; `OFFLINE_SMS_PROVIDER=smsgate` ; par défaut du code = `smsgate` (plus `sms_gateway`).
- Signature webhook passerelle : mêmes sémantiques (permissif par défaut, échec fermé en mode strict), variables génériques optionnelles `SMS_GATEWAY_WEBHOOK_SECRET` / `SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE` (alias d'en-tête historique toléré en transition).

## 3. Variables Render à supprimer MANUELLEMENT (pas d'accès à Render)

À **supprimer** du dashboard Render si présentes :
`INFINIREACH_API_KEY` · `INFINIREACH_FROM_NUMBER` · `INFINIREACH_API_URL` · `INFINIREACH_ENABLED` · `INFINIREACH_WEBHOOK_SECRET` · `INFINIREACH_REQUIRE_SIGNATURE`

À **vérifier** : si `OFFLINE_SMS_PROVIDER` existe et vaut `sms_gateway` → le remplacer par `smsgate` ou le **supprimer** (défaut du code = `smsgate`). **Ne pas toucher** aux 4 var `SMS_GATEWAY_LOGIN/PASSWORD/DEVICE_ID/SERVER_ADDRESS`.

Nouvelles variables **optionnelles** (aucune obligation, rien à créer pour que ça marche) : `SMS_GATEWAY_DEVICE_NUMBER` (anti-boucle, numéro SIM passerelle) et `SMS_GATEWAY_WEBHOOK_SECRET`/`SMS_GATEWAY_WEBHOOK_REQUIRE_SIGNATURE` (sécurisation webhook).

## 4. Fichiers modifiés

`services/smsGateway.js` (réécrit) · `services/smsProvider.js` (réécrit) · `services/messageRouter.js` · `services/smsQueueWorker.js` · `routes/sms.gateway.inbound.js` (route /status réécrite SMSGate) · `server.js` · `.env.example` · `package.json` (description) · `test/infinireach-removal-tests.js` (nouveau, 26 checks) · `test/sms-gateway-tests.js` (SUPPRIMÉ — testait le client retiré) · stubs mis à jour : `test/quota-402-tests.js`, `test/credits-hooks-tests.js`, `test/routing-offline-hold-tests.js`, `test/session13-username-audio-notif-tests.js`, `test/stabilisation-phases.js`.

## 5. Éléments SMSGate conservés (intacts)

`services/smsGateProvider.js` (aucune ligne modifiée) · les 4 variables `SMS_GATEWAY_*` · le service générique d'envoi (`smsProvider.sendSMS`, désormais SMSGate-exclusif) · routage des messages (3 cas, hold + secours auto) · résolution UID→numéro vérifié · files/inline + retries · historique & statuts de livraison (DLR) · idempotence/anti-doublon · transcription Groq · `androidGateway`/`gatewayPool` (passerelle Android propriétaire — non INfiniReach) · webhook entrant (format historique conservé, l'app passerelle le publie).

## 6. Tests

- **`test/infinireach-removal-tests.js` : 26/26 PASS** — scans source (plus aucune lecture `INFINIREACH_*` dans le code actif, hors fallback de transition documenté) · bannière exigée présente · vars legacy posées + sélection `sms_gateway` → **aucune activation** (`activeProvider: none`, 0 appel réseau) · SMSGate configuré → actif même avec `OFFLINE_SMS_PROVIDER=sms_gateway` · routage offline (compte legacy) et sans compte → SMSGate appelé · webhook strict/permissif.
- **Régression complète : 31/31 suites vertes** (routage, isolation, hold, inbound, OTP, crédits, quota-402, push, photos, SMSGate provider/aliases/restore/fallback v2/v3, pool, redis…).
- **3 suites préexistantes cassées AVANT la mission** (vérifié par `git stash` sur HEAD) : `session6` (13 échecs — fichiers Flutter/PWA absents du dépôt), `session10` (6 échecs — chemins `/home/user/webapp` absents), `session13` (devDependency `socket.io-client` manquante). Sans rapport avec INFINIREACH ; non traitées hors périmètre.
- **Simulé** : SMSGate = serveur HTTP local mock. Aucun SMS réel, aucun quota.

## 7. Références INFINIREACH restantes (justifiées)

1. `services/messageRouter.js` + `routes/sms.gateway.inbound.js` : lecture de **secours** `process.env.INFINIREACH_FROM_NUMBER` derrière la nouvelle var générique `SMS_GATEWAY_DEVICE_NUMBER` — simple numéro SIM passerelle pour l'anti-boucle (jamais SMS vers la SIM elle-même) ; **ne constitue pas une configuration fournisseur** et ne peut rien activer ; supprimable après avoir posé `SMS_GATEWAY_DEVICE_NUMBER`.
2. Clé `sms_gateway` dans la réponse `/health` (`smsProvider.getProviderStatus`) : conservée pour compatibilité des lectures existantes, désormais inerte (`configured:false, disabled:true`).
3. Docs historiques, commentaires (dont champs `infobipNumber` du modèle de données Firestore — renommer casserait les conversations existantes), `loadtest/node-runner.js` (commentaire).

## 8. Vérifications routage demandées (§5 de la mission) — RÉUSSI (simulé)

Offline (numéro vérifié disponible) → SMSGate appelé · sans compte → SMSGate · téléphone passerelle via SMSGate · nouvelles tentatives après indisponibilité (marqueurs succès-seul) · vocal → transcription → SMS texte. `ROUTE_OFFLINE_HOLD` ne bloque plus l'envoi externe quand le numéro vérifié est disponible (corrigé en mission v3, re-testé ici).
