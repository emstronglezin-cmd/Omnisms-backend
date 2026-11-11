# Rapport — Restauration du routage SMSGate et correction de l'envoi hors ligne

**Statut : corrigé et testé (simulé) — commit local en attente de « pousse ».**

---

## 1. Fichiers modifiés

| Fichier | Modification |
|---|---|
| `services/smsFallback.js` | **Cause corrigée** : éligibilité (comptes legacy), normalisation E.164, logs de motif sur TOUS les skips, retry autorisé après échec, `messageId` chaîné au fournisseur (anti-doublon ambigu) |
| `services/messageRouter.js` | Tags distincts `[ROUTING] Recipient online/offline` + motif du secours affiché dans le log `omnisms_held` |
| `services/smsGateProvider.js` | Tags `[SMSGATE] Sending SMS / SMS accepted / Gateway unavailable / SMS failed / SMS delivery confirmed` |
| `routes/sms.gateway.inbound.js` | DLR : `[SMSGATE] SMS delivery confirmed` / `[SMSGATE] SMS failed (accusé passerelle)` |
| `services/smsProvider.js` | Chaînage `messageId` → SMSGate (mémorisation des résultats ambigus opérationnelle) |
| `services/queueService.js` | Redis : inline DIRECT sous quota + fermeture propre avant déconnexion |
| `test/smsgate-restore-tests.js` | **Nouveau** — 17 vérifications couvrant la table des 8 scénarios |

## 2. Cause exacte de la régression

Le blocage n'était **pas** `ROUTE_OFFLINE_HOLD` lui-même (la branche hold évalue bien le secours). Trois défauts précis dans `services/smsFallback.js` :

1. **`checkEligibility()` — condition `user.phoneVerified !== true` stricte.** Les comptes créés avant le système OTP n'ont **pas de champ `phoneVerified`** dans Firestore → skip `phone_unverified` → hold **sans aucune tentative SMSGate**. La convention réelle du dépôt est « vérifié sauf false explicite » (auth.js `user.phoneVerified !== false`, googleOAuth.js, userResolver *« phoneVerified=false EXCLUS par défaut »*) — le contredire excluait tous les comptes legacy.
2. **Skips silencieux** : `evaluateAndDispatch()` retournait `{status:'skipped', reason}` **sans aucun log** → « Aucune tentative SMSGate n'apparaît dans les logs », diagnostic impossible.
3. **Retry bloqué après échec** : un marqueur doc `smsFallback.status='failed'` déclenchait `already_handled` → même le retour du gateway ne permettait pas la nouvelle tentative.

Le log `targetPhone="(uid direct)"` signifiait : l'app a transmis l'**UID** du destinataire (normal), le téléphone n'était simplement **pas résolu/affiché** — l'UID n'a jamais servi de numéro (le numéro vient du profil, testé).

## 3. Chemin de routage — avant / après

```
AVANT
POST /api/messages/v2 → routeMessage → resolvedUid (uid direct)
  → présence offline → hold → checkEligibility
     → phoneVerified absent → SKIP SILENCIEUX (aucun log)
  → ROUTE_OFFLINE_HOLD — SMSGate JAMAIS appelé
  → après un échec : already_handled → retry IMPOSSIBLE

APRÈS
POST /api/messages/v2 → routeMessage → resolvedUid
  → [ROUTING] Recipient online → interne Socket.IO (aucun SMS)
  → [ROUTING] Recipient offline → hold (message conservé + push FCM)
     → checkEligibility : opt-out ? false explicite/OTP en attente ?
        compte legacy actif → OK
     → [ROUTING] Verified phone resolved (profil → E.164, normalisé si ancien format)
     → [SMSGATE] Sending SMS → [SMSGATE] SMS accepted (id passerelle)
     → DLR → [SMSGATE] SMS delivery confirmed (jamais prétendu « livré » sur HTTP seul)
     → échec → statut failed + message conservé + NOUVELLE TENTATIVE possible
     → tout skip → motif EXPLICITE dans les logs et dans le log hold
```

## 4. Résultats des tests

- **`test/smsgate-restore-tests.js` : 17/17 PASS** — les 8 scénarios de la table de mission : en ligne (0 SMS) · hors ligne/UID direct/legacy → SMSGate appelé avec le numéro du profil E.164 + Device ID · numéro ancien format normalisé (`70 12 34 56` → `+22670123456`) · numéro introuvable (`no_valid_phone`, aucun faux envoi) · `phoneVerified=false` explicite → jamais de SMS · gateway déconnecté (tentative réelle puis `failed` honnête) · gateway reconnecté (re-route du même message → `sent`) · re-route après succès (`already_handled`, 0 doublon) · sans compte → `SMS_EXTERNE` · Redis absent → handler inline réellement exécuté + pas de faux succès sans handler · `checkStatus` → `delivered` distinct de l'acceptation HTTP.
- **Régression complète : 29/29 suites vertes** (routage, isolation, hold, inbound, OTP, crédits, quota, push, photos, SMSGate provider/aliases, fallback v2…).
- **Simulé** : SMSGate = serveur HTTP local mock ; Groq = stub. **Aucun SMS réel, aucun quota fournisseur.**

## 5. Variables Render

- **À conserver à l'identique** (déjà posées, jamais renommées) : `SMS_GATEWAY_LOGIN`, `SMS_GATEWAY_PASSWORD`, `SMS_GATEWAY_DEVICE_ID`, `SMS_GATEWAY_SERVER_ADDRESS`.
- **`BACKEND_URL` (signalée manquante au démarrage)** : **bénigne** — tous les usages (liens paiement, uploads, photos) ont un fallback en dur vers la valeur canonique. Valeur attendue si vous la posez : `https://omnisms-backend.onrender.com`.
- Ancien adaptateur INfiniReach : toujours en pause (`paused:true`), la sélection reste `smsgate` prioritaire ; aucun envoi ne peut être détourné (`selectTransport` : android_gateway > smsgate, infiniReach testé en dernier).

## 6. Commandes exactes

```bash
# Tests (simulés, sans SMS réel)
npm install
node test/smsgate-restore-tests.js      # 17/17
node test/sms-fallback-tests.js         # 24/24 (mission v2)

# Déploiement (uniquement sur votre accord « pousse »)
git push origin main

# Test réel sur téléphone
#  1. Passer le téléphone passerelle (Z Fold2) HORS LIGNE → envoyer un message
#     à un compte OmniSMS → vérifier logs : [SMSGATE] Sending SMS puis
#     [SMSGATE] Gateway unavailable, statut 'failed', message conservé.
#  2. Reconnecter l'app SMSGate → re-déclencher → [SMSGATE] SMS accepted.
#  3. Sonde admin : POST /api/diag/sms-test (header x-admin-key, body {to, text}).
```

## 7. Statuts

| Élément | Statut |
|---|---|
| Cause de la régression identifiée (fichier/fonction/condition) | **RÉUSSI** |
| Cas A en ligne / Cas B hors ligne / Cas C sans compte | **RÉUSSI** (simulé) |
| SMSGate : 4 vars, Device ID, endpoint, erreurs, timeouts | **RÉUSSI** (contrat + simulé) |
| Logs distincts [ROUTING]/[SMSGATE] + statuts accepted/sent/delivered/failed | **RÉUSSI** |
| Redis/BullMQ : rejets non gérés, inline réel, pas de doublon | **RÉUSSI** (simulé) |
| Gateway réellement déconnecté (vrai téléphone) | **NON TESTÉ** |
| SMS réel envoyé et confirmé par SMSGate | **NON TESTÉ** |
| DLR réel (webhook de l'app passerelle vers le backend) | **NON TESTÉ** |

## 8. SMS réel ?

**Aucun.** Tous les tests sont simulés (mock HTTP local). Aucun envoi vers un numéro tiers, aucun quota consommé.
