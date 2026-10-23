# Vérification du numéro de téléphone à l'inscription — audit, contrat API, activation
**Date** : 2026-10-14 · Commits : `885e5c4` (service OTP durci) · `bae4b51` (politique + API) — locaux, **non poussés**.
**Principe** : aucune dépendance payante ajoutée ; aucun envoi réel en test ; rien d'activé en production sans décision explicite.

---

## 1. Audit des solutions OTP disponibles (code réel inspecté)

| Solution | Verdict |
|---|---|
| **Infobip** (déjà intégré, `services/infobip.js`, clé déjà ACTIVE en prod — vérifié sur `/health`) | ✅ **Recommandé**. SMS standard suffit : `sendSMS({to, text, from})` déjà opérationnel, DLR via webhook existant (`/api/webhooks/infobip/inbound`), indépendant du téléphone passerelle. Service « Verify » dédié (≈ 0,05 $/auth, source : smsapicompare.com 05/2026) inutile ici : le SMS simple fait le même travail sans nouvelle intégration. |
| **INfiniReach (passerelle Android)** | ❌ Déconseillé pour l'OTP : dépend du téléphone passerelle (hors ligne = plus aucune inscription possible) ; **quota 402 actuel = aucun SMS ne part** ; pas de distinction fiable accepté/délivré sans DLR. Disponible en repli explicite uniquement (`OTP_PROVIDER=gateway` + `OTP_ALLOW_GATEWAY_TRANSPORT=true`). |
| **Twilio / autres agrégateurs** | Coûts vers le Burkina Faso nettement supérieurs (≈ 0,30–0,35 $/SMS, source : sent.dm 04/2026) → pas de raison de changer. |
| **Coûts connus vers le Burkina Faso** | Agrégateurs ≈ **0,04–0,11 $/SMS** (esmsafrica.io 10/2026 : XOF 20–30 ≈ 0,043 $ ; unimtx.com : 0,1076 $ ; prelude.so : 0,1717 €). Prix exact Infobip BF : **à confirmer dans le portail Infobip** (prix par réseau, non publié). Ordre de grandeur : 1 000 inscriptions ≈ 40–110 $ (1 SMS/inscription, renvois inclus ≤ 5/h/numéro). |
| **Firebase Phone Auth** | Écarté : doublonnerait l'auth existante (JWT maison + Google OAuth), coût par vérification SMS facturé par Google, et migration des sessions. |

**Décision** : transporter = **Infobip existant** (aucune nouvelle dépendance) derrière l'interface abstraite `OTP_PROVIDER` (auto/infobip/gateway/none) — le jour où un fournisseur dédié est validé, seul le transport change.

## 2. Politique implémentée

- **Flag `PHONE_VERIFICATION_REQUIRED`** (défaut **false** = comportement actuel inchangé).
- Flag ON : nouveaux comptes (inscription classique **et** première connexion Google) → `phoneVerified:false`, `verificationRequired:true`, `status:'pending_verification'` + **`pendingToken`** (JWT 15 min, `purpose:'phone_verification'`, aucune opération privilégiée). Fonctionnalités d'envoi bloquées (HTTP 403 + Socket.IO) tant que non vérifié.
- **Comptes historiques : jamais re-bloqués** (le blocage repose sur le claim JWT émis uniquement aux comptes pending ; pas de migration, pas de suppression, sessions conservées). On ne marque PAS les numéros historiques comme vérifiés — ils restent sans le champ, traités comme vérifiés par les règles existantes (`!== false`), sans jamais devoir repasser par un OTP.
- L'**email Google n'est jamais une preuve de téléphone** → un nouveau compte Google doit définir puis vérifier son numéro (parcours `send-otp` avec numéro → unicité contrôlée).
- La vérification reste **unique à l'inscription** : aucune OTP systématique aux connexions suivantes.

## 3. Contrat API (frontend PWA + APK)

Toutes les routes sont sous `/api/auth` (limiteur anti brute-force 30 req/15 min/IP appliqué). Le `pendingToken` s'envoie en `Authorization: Bearer …` comme un JWT.

| # | Endpoint | Corps | Réponses |
|---|---|---|---|
| 1 | `POST /api/auth/register` (existant) | `{name, phone, password, username?}` | flag OFF : `201 {message, token, user}` (historique). **Flag ON : `201 {userId, phone, requiresVerification:true, pendingToken, user}`** — pas de session complète |
| 2 | `POST /api/auth/send-otp` | `{}` (numéro = celui du compte) ou `{phone}` si le compte n'en a pas encore (Google) | `200 {success, message, phone}` · `429 OTP_COOLDOWN {cooldown}` · `429 OTP_RATE_LIMITED` · `503 OTP_PROVIDER_UNAVAILABLE / SMS_SEND_FAILED` · `401 VERIFICATION_TOKEN_REQUIRED` · `409 NOT_PENDING / PHONE_ALREADY_USED` · `400 PHONE_REQUIRED` |
| 3 | `POST /api/auth/verify-otp` | `{code}` | `200 {token (session complète), user{…, phoneVerified:true}}` · `400 OTP_INVALID {triesRemaining}` · `410 OTP_EXPIRED` · `429 OTP_MAX_TRIES` · `404 OTP_NOT_FOUND / OTP_CONSUMED` · `409 NOT_PENDING` |
| 4 | Renvoi | = endpoint 2 (cooldown 60 s géré côté serveur) | idem 2 |
| 5 | `GET /api/auth/phone/verify/status` | — | `200 {phoneVerified, verificationRequired, status, phone(masqué), needsPhone}` |
| 6 | `POST /api/auth/phone/change` | `{phone}` (compte en attente uniquement) | `200 {success, phone}` → puis endpoint 2 · `409 PHONE_ALREADY_USED / NOT_PENDING` · `400 PHONE_UNCHANGED` |

**Login d'un compte en attente** (flag ON) : `200 {requiresVerification:true, pendingToken, phone(masqué), needsPhone, user}` au lieu du token complet.
**Erreurs de blocage** : `403 {code:'PHONE_VERIFICATION_REQUIRED'}` sur `POST /api/messages/send` (HTTP) et ack `PHONE_VERIFICATION_REQUIRED` sur l'événement Socket.IO `message:send`.

## 4. Fichiers modifiés / migrations

| Commit | Fichiers |
|---|---|
| `885e5c4` | `services/otpService.js` (réécrit durci), `test/otp-service-tests.js` (17 checks) |
| `bae4b51` | `routes/auth.js` (register/login pending), `routes/otp.js` (réécrit + **monté** dans `server.js`), `middleware/requirePhoneVerified.js` (nouveau), `middleware/security.js` (knob `AUTH_RATE_LIMIT_MAX`, défaut 30 inchangé), `services/socketService.js` (guard envoi), `services/googleOAuth.js` (nouveaux comptes Google pending + claim session), `server.js` (montages), `.env.example`, `test/phone-verification-tests.js` (25 checks) |

**Migrations Firestore** : **aucune** — champs additifs sur `users` (`phoneVerified` existait déjà, `verificationRequired`, `status`, `phoneVerifiedAt`) ; collection `otp_codes` réutilisée (documents désormais **hashés** ; les anciens docs en clair expirent d'eux-mêmes à leur TTL, suppression au prochain passage). Index : aucun nouveau (requêtes à égalité simple).

## 5. Variables d'environnement (documentées dans `.env.example`)

`PHONE_VERIFICATION_REQUIRED` (false) · `OTP_PROVIDER` (auto) · `OTP_ALLOW_GATEWAY_TRANSPORT` (false) · `OTP_CODE_TTL_MINUTES` (5) · `OTP_RESEND_COOLDOWN_SECONDS` (60) · `OTP_MAX_VERIFY_ATTEMPTS` (5) · `OTP_MAX_PER_PHONE_PER_HOUR` (5) · `OTP_MAX_PER_IP_PER_HOUR` (20) — toutes optionnelles, défauts sûrs. **Aucune nouvelle variable obligatoire au démarrage.**

## 6. Tests exécutés (locaux, transporteur injecté, zéro SMS réel)

- `test/otp-service-tests.js` : **17 PASS** (empreinte HMAC uniquement, jamais de code exposé/loggé, incorrect/expiré/consommé/max-essais, cooldown, 5/h/numéro, fournisseur en panne → jamais marqué vérifié, codes distincts).
- `test/phone-verification-tests.js` : **25 PASS** (parcours complet : pending signup → blocage → code → session ; Google nouveau/existant ; JWT historique jamais bloqué ; cooldown ; conflit/changement de numéro ; fournisseur indisponible ; demandes concurrentes ; double inscription refusée).
- Régression : **19 suites vertes** (routage, quota-402, crédits, ratestore, metrics, pool, firestore-utils, account-deletion, présence, offline-hold, OAuth 31 checks…).

## 7. Étapes manuelles AVANT activation en production

1. **Confirmer le prix SMS Infobip Burkina Faso** dans le portail Infobip (réseaux Orange/Moov/Telecel) et créditer le compte.
2. **Test réel contrôlé de bout en bout** (staging ou Render avec `PHONE_VERIFICATION_REQUIRED=true` temporaire) : inscription avec un VRAI numéro burkinabè → réception du SMS → validation → session. ⚠️ **Tant que ce test réel n'est pas fait, la vérification ne peut pas être déclarée fonctionnelle en production.**
3. Configurer `OTP_PROVIDER=infobip` (ou laisser `auto`), régler `OTP_CODE_TTL_MINUTES`/cooldown si besoin.
4. Frontend (PWA + APK) : implémenter le parcours d'après le contrat §3 (register → pendingToken → send-otp → verify-otp → token), écran « saisie du numéro » pour les comptes Google, écran « changer de numéro » si 409.
5. Activer `PHONE_VERIFICATION_REQUIRED=true` sur Render → surveiller les logs `[OTP]`/`[AUTH]` 24 h.
6. **Non testé / limites** : DLR Infobip (succès accepté ≠ délivré — le code reste valide 5 min quoi qu'il arrive) ; délivrabilité réelle vers les 3 opérateurs BF ; comportement à grande échelle (le « 30 req/15 min/IP » du bloqueur `/api/auth` peut plafonner une campagne d'inscriptions derrière un NAT — augmenter `AUTH_RATE_LIMIT_MAX` si nécessaire).
