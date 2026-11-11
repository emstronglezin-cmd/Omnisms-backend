# Rapport — Résolution centrale du numéro vérifié + secours SMSGate (mission v5)

**Statut : cause identifiée, corrections implémentées, 23/23 tests dédiés + 32/32 suites vertes (simulé). Commit local en attente de « pousse ».**

---

## 1. Cause exacte de `phone_unverified`

Le correctif v3 exigeait, pour un compte **pré-OTP** (champ `phoneVerified` absent), que `status === 'active'`. Or les comptes créés avant l'introduction du champ `status` peuvent n'avoir **ni `phoneVerified` ni `status`** → la condition échouait → skip `phone_unverified` → hold sans SMSGate. Deuxième cause possible (correcte par conception) : `phoneVerified: false` **explicite** (inscription à l'époque du flag OTP ON, OTP jamais achevé) — ce cas reste bloqué, la vérification n'est jamais contournée.

## 2. Source de vérité du numéro vérifié (examen des sources)

- **Firebase Auth : pas une source de numéro dans ce projet** — l'inscription est custom (email/mot de passe + profil Firestore) ; aucun numéro n'y est stocké.
- **Source de vérité unique : Firestore `users/{uid}`** :
  - `phone` (E.164, écrit à l'inscription `routes/auth.js`, confirmé par OTP `routes/otp.js`) ; `phoneNumber` accepté en alias défensif (aucune écriture actuelle ne l'utilise) ;
  - `phoneVerified` (true/false), `phoneVerifiedAt` (preuve d'achèvement OTP), `verificationRequired`, `status`.

**Nouvelle fonction centrale : `resolveVerifiedPhoneByUid(uid)`** dans `services/userResolver.js` — priorité documentée `phone` → `phoneNumber` → normalisation E.164 (défaut BF) ; règles de vérification (mécanisme existant, jamais contourné) :
1. `phoneVerified === true` → vérifié (`otp_verified`) ;
2. `phoneVerifiedAt` présent → vérifié (`otp_verified_at`) ;
3. `phoneVerified === false` → **NON vérifié** (OTP en attente) — un false explicite bloque toujours, aucun numéro n'est auto-déclaré vérifié ;
4. `phoneVerified` absent (pré-OTP) → vérifié si `status` absent **ou** `'active'`, ou `verificationRequired === false` (`legacy_active`) — convention du dépôt (`auth.js` « `!== false` », `userResolver` « false EXCLUS par défaut »).
Sinon : `{found:false, reason: user_not_found | no_phone | phone_unverified | invalid_phone}` → message **conservé** + statut explicite, jamais d'UID utilisé comme numéro.

## 3. Fichiers modifiés

| Fichier | Modification |
|---|---|
| `services/userResolver.js` | **Nouveau** `resolveVerifiedPhoneByUid` (résolution centrale, source de vérité unique) |
| `services/smsFallback.js` | `checkEligibility` délègue au résolveur (1 seule lecture doc, opt-out évalué après résolution) |
| `routes/messages.js` | **`/send`** : destinataire hors ligne → secours `evaluateAndDispatch` (SMSGate), anti-doublon partagé, réponse inchangée |
| `services/socketService.js` | Gestionnaires d'erreur sur l'adaptateur Redis Socket.IO (pub+sub) — log débit-limité, plus de rejets « Connection is closed » non gérés |
| `test/phone-resolution-tests.js` | **Nouveau** — 23 vérifications |
| `test/sms-fallback-tests.js`, `test/smsgate-restore-tests.js`, `test/infinireach-removal-tests.js` | Stubs `userResolver` complétés (miroir des règles du résolveur) |

## 4. Fonctionnement du routage (inchangé dans son architecture)

- **Cas A (en ligne)** → Socket.IO interne, jamais de SMS (testé).
- **Cas B (hors ligne)** → hold (historique + push FCM) → résolveur central → numéro vérifié E.164 → `[SMSGATE] Sending SMS` ; statut réel enregistré (`smsFallback` sent/failed/skipped:raison) ; skip = motif explicite dans les logs.
- **Cas C (sans compte)** → numéro fourni validé → SMSGate.
- **Cas D (SMSGate indispo)** → tentative réelle, `failed` honnête, message conservé, **retentable sans doublon** (marqueurs succès-seul).
- **`/send` (route historique)** appelle désormais le même adaptateur SMSGate pour un destinataire hors ligne éligible.

## 5. Preuve que SMSGate est déclenché hors ligne

`test/phone-resolution-tests.js` — le serveur SMSGate simulé **enregistre la requête POST** reçue :
```
PASS  scénario 2 : hors ligne vérifié → SMSGate APPELÉ (preuve POST)
      → POST /3rdparty/v1/messages { phoneNumbers:['+22670000001'], message:'OmniSMS — Ali : …' }
PASS  /send : destinataire hors ligne → SMSGate déclenché (preuve POST)
      → POST reçu avec le texte envoyé via /send
```
(Simulé : mock HTTP local — **aucun SMS réel**.)

## 6. Tests

- **`test/phone-resolution-tests.js` : 23/23** — résolveur (10 unités : true / phoneVerifiedAt / false bloquant / **pré-OTP sans status → CORRECTIF PROD** / pending_verification bloqué / flag OFF / normalisation `70 12 34 56` / alias phoneNumber / sans numéro / supprimé) + les 10 scénarios de mission (en ligne, hors ligne vérifié, sans numéro, non vérifié, sans compte, gateway down, retry, Redis inline réel, pas de doublon, statut `delivered` réel) + `/send` → SMSGate.
- **Régression : 32/32 suites vertes.**
- Préexistant (hors périmètre, inchangés) : session6/10/13 (fichiers Flutter/PWA et `/home/user/webapp` absents, devDependency `socket.io-client` manquante).

## 7. Variables Render

**À AJOUTER** : `BACKEND_URL` = `https://omnisms-backend.onrender.com` (supprime l'avertissement `[ENV]` au démarrage ; tous les usages ont déjà ce fallback en dur — aucune fonctionnalité n'en dépend).

**À CONSERVER À L'IDENTIQUE** : `SMS_GATEWAY_LOGIN`, `SMS_GATEWAY_PASSWORD`, `SMS_GATEWAY_DEVICE_ID`, `SMS_GATEWAY_SERVER_ADDRESS` (une seule intégration SMSGate).

**À SUPPRIMER MANUELLEMENT** (plus lues par le backend — SasPay est le fournisseur de paiement actif, son intégration n'a pas été touchée) :
`LEEKPAY_API_KEY`, `LEEKPAY_SECRET_KEY`, `LEEKPAY_PUBLIC_KEY` (si présente), `LEEKPAY_BASE_URL`, `LEEKPAY_WEBHOOK_SECRET`, `LEEKPAY_PREMIUM_AMOUNT`, `LEEKPAY_PREMIUM_CURRENCY`, ainsi que les restes `INFINIREACH_*` (mission v4) et `OFFLINE_SMS_PROVIDER` s'il vaut `sms_gateway`.

## 8. Redis/BullMQ (§5) — état

Quota épuisé → inline **direct** sans commande Redis + fermeture propre avant déconnexion (v3) ; **nouveau** : gestionnaires d'erreur sur l'adaptateur Socket.IO (fin des rejets non gérés) ; sonde de rétablissement 1 PING/10 min (reconnexion propre workers+queues) ; tâche non exécutable = `jobId:null` + erreur explicite (jamais de faux succès) ; idempotence SMS inchangée (marqueurs succès-seul).

## 9. Reste à tester avec un véritable téléphone — **NON TESTÉ**

1. SMS réel offline (Z Fold2) vers un compte pré-OTP sans `status` (le cas prod) → SMS reçu + `smsFallback: sent`.
2. Compte avec `phoneVerified:false` réel → aucun SMS (blocage attendu) puis, après validation OTP → SMS.
3. Gateway volontairement déconnecté → `failed` honnête puis retry après reconnexion (sans doublon).
4. DLR réel → `[SMSGATE] SMS delivery confirmed`.
5. Sonde : `POST /api/diag/sms-test` (x-admin-key).
