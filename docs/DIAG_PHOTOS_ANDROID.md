# Diagnostic photos de profil Android — rapport final
**Date** : 2026-10-23 · Commit : `b1ecfa3` (local, non poussé) · Précédent correctif contrat : `6160a18` (déployé, run #71).

## 1. Cause précise (audit complet, sans supposition)

**La photo EST enregistrée** (POST /me/avatar → data URI dans Firestore, confirmé code + tests), **et l'API la renvoie** — mais :

1. **Le correctif précédent ne couvrait pas toutes les routes.** `routes/users.js` et `routes/groups.js` sérialisaient encore le document **brut** — et ces deux routeurs sont montés **à la racine** (`/users`, `/groups`, SANS préfixe `/api`), contrairement à `/api/me` et `/api/contacts`. Si l'APK lit `avatarUrl`/`photoUrl` sur ces écrans (profil via `GET /users/:userId`, groupes, `POST /users/link`), il recevait `null` → « toujours pas de photos » malgré le correctif #71.
2. **Incohérence historique du champ photo de GROUPE** : stocké sous `image`, renvoyé `imageUrl` — jamais exposé sous `avatar`/`avatarUrl`.
3. **Limite de taille (potentiel contributeur côté APK)** : l'upload accepte 10 Mo en multipart mais **rejette au-delà de 800 Ko de base64** (`413 IMAGE_TOO_LARGE`). Une photo d'appareil photo Android non compressée dépasse ce seuil → **jamais persistée** alors que l'app peut croire l'avoir envoyée. La PWA compresse probablement côté client → d'où la différence de comportement.
4. **Limite Firestore 1 Mo/document** : l'avatar (data URI ≤ 800 Ko) partage le document user avec `contacts_synced` → au-delà, l'écrit **échouait avec un 500 générique** (échec peu explicite). Désormais : `413 AVATAR_DOC_TOO_LARGE` honnête, et **testé que la photo n'est PAS persistée en cas d'échec** (jamais de faux succès).
5. **URLs** : l'API renvoie des **data URI auto-contenues** (pas de fichiers publics, pas d'URL signées à expiration, pas de domaine à configurer) ; les rares URLs relatives (`/uploads/…`) sont absolutisées avec `BACKEND_URL`. **Aucune divergence Web/Android possible côté serveur** sur les URLs.
6. Bonus audit : flocon `om-recharge` (2 échecs rares observés) = **assertion de test trop stricte** (deux lectures d'horloge distinctes, ±1 ms) — corrigée (±5 ms), 20/20 verts ensuite. **Pas un bug produit.**

## 2. Fichiers backend modifiés (ciblés, compatibles clients existants)

| Fichier | Changement |
|---|---|
| `routes/users.js` | `GET /users/:userId` + `POST /users/link` (2 branches) → contrat `avatar`+`avatarUrl`+`photoUrl` |
| `routes/groups.js` | Liste, détail, ajout/suppression membres, `GET /:id/members` (photos des MEMBRES), upload photo groupe → même contrat ; champ `image` mappé (`image \|\| avatar`) |
| `routes/me.js` | Échec d'écrit Firestore (doc > 1 Mo) → `413 AVATAR_DOC_TOO_LARGE` explicite (au lieu de 500 générique) |
| `test/profile-photos-tests.js` | **19 checks** (voir §3) |
| `test/om-recharge-tests.js` | Assertion floconneuse ±5 ms |

**Non modifié volontairement** : authentification, messagerie, règles d'accès (`GET /users/:id` reste « soi uniquement », 403 vérifié par test), files Redis, config production.

## 3. Tests réellement exécutés et résultats

`test/profile-photos-tests.js` — **19/19 PASS** (serveur réel local, Firestore simulé, aucune donnée prod) :
upload base64 + persistance · `GET /me`, `GET /auth/me`, `POST /users/link`, `GET /users/:id (soi)` avec alias · `GET /users/:id` d'un autre = **403 conservé** · profils sans photo = 3 champs `null` · contacts avec 2 avatars distincts + alias · photo de groupe (champ `image`) + **photos des membres** · `>800 Ko` → `413 IMAGE_TOO_LARGE` · échec Firestore → `413 AVATAR_DOC_TOO_LARGE` + **photo non persistée** · URL relative → absolue.
Régression : **22/22 suites vertes** · `om-recharge` : 20/20 après fix du flocon.

## 4. Verdict honnête

- **Le backend fournit désormais une référence exploitable et homogène sur TOUTES les réponses** : `avatar` = `avatarUrl` = `photoUrl` (data URI `data:image/…` ou URL https absolue, `null` explicite). C'est vérifié par 19 tests automatisés, pas seulement par un HTTP 200.
- **Si l'APK n'affiche toujours pas après ce déploiement**, la cause restante est côté Flutter. Checklist exacte pour l'équipe mobile :
  1. Lire `avatarUrl` **ou** `avatar` (identiques) sur : `POST /api/auth/login`, `GET /api/me`, `GET /api/auth/me`, `POST /users/link`, `GET /users/:userId`, `POST /api/contacts/sync`, `GET /groups`, `GET /groups/:id`, `GET /groups/:id/members`.
  2. **Compresser la photo avant upload** (≤ ~600 Ko binaire / ~800 Ko base64), sinon `413 IMAGE_TOO_LARGE` — l'erreur doit être affichée, pas avalée.
  3. Traiter `413 AVATAR_DOC_TOO_LARGE` (doc user > 1 Mo avec contacts) → réduire l'image.
  4. Upload : `POST /api/me/avatar` (multipart `avatar` **ou** JSON `{avatarBase64:"data:image/…;base64,…"}`) **ou** `PUT /api/me/profile {avatar:…}`.
  5. Ne jamais construire d'URL relative : les URL renvoyées sont complètes.
- **Non testé ici** : l'APK réel (pas de projet Flutter dans ce dépôt) et la prod avec un vrai jeton — vérifiables seulement après déploiement.
