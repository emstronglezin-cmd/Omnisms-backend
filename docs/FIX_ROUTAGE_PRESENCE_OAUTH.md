# Correction routage + présence + OAuth APK — rapport de fin
**Date** : 2026-10-14 · Commits : `3e86b94` (présence) · `ef94025` (routage offline) · `1db130e` (OAuth APK) — locaux sur `main`, **non poussés** (attendre validation).
**Périmètre respecté** : PWA préservée, passerelle SMS intacte, paiements intouchés, aucun secret, aucun SMS réel envoyé (stubs uniquement).

---

## 1. Causes racines (audit du code réel)

### Problème 1 — Présence
**Cause racine mesurée** : la présence `online_ttl:{uid}` (TTL 5 min, `services/socketService.js`) n'était renouvelée **que** par l'événement applicatif `heartbeat` envoyé par le client (ou à la connexion). Une app qui n'émet pas `heartbeat` (ou qui a l'écran éteint/WS inactif > 5 min) passait **offline alors que le socket était vivant** → `messageRouter` la jugeait hors ligne → SMS. Secondary : la décision « offline » au `disconnect` ne vérifiait que `fetchSockets()` après 3 s — sans registre par appareil ni garde multi-source.

### Problème 2 — Routage
**Cause racine** : politique historique codée en dur — destinataire OmniSMS **résolu mais hors ligne → SMS automatique vers son vrai numéro** (`messageRouter.routeMessage` §3 ; et copie SMS au propriétaire hors ligne dans le webhook entrant). Toute hésitation de présence (problème 1) devenait donc un SMS. Pas d'état « en attente » récupérable, pas de distinction présence inconnue.
**Résolution d'identité** : auditée (`userResolver`, multi-variantes E.164, usernames `#`) — **saine, non modifiée** (pas de supposition ajoutée).

### Problème 3 — OAuth APK
**Cause racine (documentée dans PRESENTATION_PROJET.md §9)** : la variante « app » acceptait **n'importe quel https** comme retour. Or `GOOGLE_FLUTTER_REDIRECT_URI` sur Render a été **écrasé par une URL PWA Vercel** → le callback 302 envoyait le résultat vers la PWA ; l'APK ne recevait jamais le code d'échange. Le mécanisme APK (défaut = scheme `omnisms://` + `POST /api/auth/google/exchange`, code 43 car. hashé TTL 2 min usage unique) **existait déjà** — pas de nouvelle route ni variable nécessaire.

## 2. Fichiers réellement modifiés

| Commit | Fichiers |
|---|---|
| `3e86b94` | `services/socketService.js`, `test/presence-hardening-tests.js` |
| `ef94025` | `services/messageRouter.js`, `services/socketService.js` (`deliverPendingMessages`), `routes/sms.gateway.inbound.js`, `test/routing-offline-hold-tests.js`, `.env.example` (doc du flag, **render.yaml intouché**) |
| `1db130e` | `services/googleOAuth.js`, `routes/auth.google.js`, `test/google-oauth-tests.js` (18→26 vérifications) |

## 3. Ce qui a été implémenté

**Présence** : `getPresenceState(uid)` → `online`/`offline`/`unknown` (Redis en panne = unknown, jamais « online » par défaut) ; une room Socket.IO vivante = preuve engine-level → **auto-réparation du TTL** ; sweep serveur 60 s (TTL + registre `user_sessions:{uid}`, un champ par socket/appareil) → la présence ne dépend plus du client ; déconnexion = retrait de SA session puis offline **uniquement si** room locale + `fetchSockets()` (multi-instances via adapter) + registre de sessions sont tous vides → les déconnexions tardives ne marquent plus offline un utilisateur actif ailleurs ; sync best-effort `users.lastSeenAt` dans Firestore.

**Routage (flag `ROUTE_OFFLINE_HOLD`, défaut `false` = comportement historique inchangé)** : avec le flag **activé** — destinataire OmniSMS résolu hors ligne → message **conservé en interne** (`channel:'app'`, `status:'pending'`, conversation interne déterministe) et **poussé à la reconnexion** ; **aucun SMS** pour un simple délai de réponse (accusé tardif ≠ SMS) ; externes (sans compte) → SMS exactement comme avant ; `OFFLINE_PUSH_BEFORE_SMS` reste prioritaire (tentative de réveil puis re-vérification) ; webhook entrant : plus de copie SMS au propriétaire hors ligne avec le flag. **Idempotence livraison** : claim `pending→sent` AVANT l'émission Socket.IO — reconnexion rapide/retry/événement répété ne livrent pas deux fois ; émission ratée → rattrapage par l'historique Firestore. Statuts conservés : `pending` (en attente), `sent` (envoyé interne ou parti SMS), `delivered`/`seen` (accusés), `failed` — mapping UI documenté pour l'app.

**OAuth** : garde-fou `safeAppRedirect(app)` — https pointant une origine PWA connue du projet (`omnisms(-frontend)*.vercel.app`, `omnisms*.netlify.app`, `omnisms.web.app`) → **503 `GOOGLE_REDIRECT_MISCONFIGURED` immédiat** + log diagnostic (host + variable à corriger) au lieu d'un 302 silencieux ; `startLogin` applique le fail-fast aux deux variantes ; https « universel » sur domaine propre (App Links) toujours permis ; PWA (`?target=web`) inchangée ; state usage unique/TTL, redirect_uri **uniquement depuis la config serveur** (jamais du client), secret jamais exposé à l'APK (échange de code backend — PKCE non requis pour un client confidentiel serveur).

## 4. Tests exécutés (résultats vérifiables)

| Suite | Résultat |
|---|---|
| `test/presence-hardening-tests.js` (nouveau) | **16 PASS** |
| `test/routing-offline-hold-tests.js` (nouveau) | **11 PASS** (connecté/interne, flag OFF = SMS historique, hold sans SMS, externe inchangé, retour en ligne, claim-avant-émission, 0 double livraison) |
| `test/google-oauth-tests.js` (étendu) | **26 PASS** (dont APK défaut, PWA rejetée en variante app, domaine propre accepté, PWA acceptée en variante web, state usage unique) |
| Régression : 17 suites (routage×5, quota-402, crédits×3, ratestore, metrics, pool, firestore-utils, account-deletion, presence, hold, oauth) | **toutes vertes** |
| Exclues (casse préexistante, prouvée) | session6/10/12/13 (deps manquantes) ; session11-notification (lit un fichier du dépôt frontend absent) |

## 5. Variables d'environnement (aucune nouvelle requise, une à ACTIVER)

| Variable | Où | Valeur |
|---|---|---|
| `ROUTE_OFFLINE_HOLD` | Render (Environment) | `true` pour activer la nouvelle politique (attente interne). **Absent/false = ancien comportement** — activation réversible à tout moment. Aucune migration Firestore (réutilise `messages`, statuts existants ; requêtes à égalité simple → pas d'index composite nouveau). |

## 6. Configurations à effectuer (valeurs attendues, à ne pas inventer)

1. **Render (variables renseignées par l'exploitant, lues en PRIORITÉ par le code depuis `1db130e`+config APK)** :
   - `GOOGLE_FLUTTER_REDIRECT_URI_APK` = `omnisms://auth/google/callback`
   - `GOOGLE_FLUTTE_CONTACT_REDIRECT_URI_APK` = `omnisms://auth/google/contacts/callback` — ⚠️ **coquille probable « FLUTTE »** (sans le 2ᵉ T) dans le nom tel que renseigné ; le code accepte **les deux graphies** (ainsi que `GOOGLE_FLUTTER_CONTACT_REDIRECT_URI_APK`). Recommandation : renommer proprement en `GOOGLE_FLUTTER_CONTACT_REDIRECT_URI_APK` côté Render pour éviter les pièges futurs — le code continue de marcher dans tous les cas.
   - Repli : anciens noms `GOOGLE_FLUTTER_REDIRECT_URI` / `GOOGLE_CONTACTS_FLUTTER_REDIRECT_URI` (si une _APK est absente). Vérifier que l'ancien `GOOGLE_FLUTTER_REDIRECT_URI` ne contient plus l'URL Vercel (ou l'ignorer : les _APK passent avant).
   - Laisser `GOOGLE_FLUTTER_REDIRECT_URI_WEB` / `GOOGLE_CONTACTS_FLUTTER_REDIRECT_URI_WEB` = URLs https de la PWA (parcours PWA préservé).
   - Le garde-fou anti-PWA s'applique aussi aux valeurs _APK (une _APK pointant vers Vercel/Netlify/web.app → 503 `GOOGLE_REDIRECT_MISCONFIGURED`).
2. **Google Cloud Console** (Client OAuth **Web** existant) : Authorized redirect URIs = les callbacks backend (`/api/auth/google/callback`, `/api/auth/google/contacts/callback`) — **rien d'autre à ajouter** ; le scheme `omnisms://` n'est PAS déclaré côté Google (c'est un retour applicatif géré par le backend).
3. **Android (APK)** : intent-filter du deep link `omnisms://auth/google/callback` (+ `/auth/google/contacts/callback`) dans l'app Flutter ; si un retour https universel est souhaité plus tard → Android App Links avec `assetlinks.json` sur le domaine **propre** du projet.

## 7. Tests manuels indispensables AVANT toute mise en prod réelle

1. APK : connexion Google → retour dans l'APK (deep link) → session créée.
2. PWA : `?target=web` → retour PWA intact.
3. APK→PWA et PWA→APK : variante imposée par l'appelant, jamais par une URL fournie.
4. Destinataire connecté sur l'APK → message **jamais** parti en SMS (vérifier les logs `[ROUTING] … recipientOnline:true`).
5. Destinataire connecté sur la PWA → idem.
6. Destinataire hors ligne avec `ROUTE_OFFLINE_HOLD=true` → `routingDecision: omnisms_held`, zéro SMS, puis reconnexion → `deliverPendingMessages` livré, une seule fois (reconnexion rapide ×2).
7. Multi-appareils : téléphone A + tablette B ; fermer A → l'utilisateur reste online (log « pas de passage offline »).
8. Avion 30 s pendant un envoi → message en attente → part au retour.
9. Destinataire externe (sans compte) → SMS part normalement (chemin inchangé).
10. Panne Redis simulée → présence `unknown` → routage dégradé sûr (pas de SMS au hasard).

## 8. Limites (honnêteté)

- Validé par **tests unitaires/intégration locaux sur stubs** — cela ne prouve PAS la fiabilité à grande échelle ni le comportement réel multi-instances (adapter Redis actif) : à re-vérifier en staging avec 2 appareils réels + vrai Redis avant d'activer le flag en prod.
- `deliverPendingMessages` est mono-instance-correct ; en multi-instances, deux instances pourraient lire les mêmes `pending` simultanément — le claim `pending→sent` fait que le client peut recevoir au pire un doublon d'événement (dédup par `messageId` côté app recommandée, le document Firestore reste la vérité).
- La présence sweep (60 s) et le TTL 5 min restent heuristiques ; un appareil en doze profond peut mettre >60 s à répondre → considéré offline (correct pour le produit : il n'est pas joignable en temps réel).
