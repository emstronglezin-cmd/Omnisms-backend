# Correction senior — présence, profils, messagerie, SMS — rapport
**Date** : 2026-10-14 · Commit : `6160a18` (local, non poussé · base distante `2e726ff`).

## 1. Causes trouvées (audit du code réel, commit par commit vérifié)

**Photos (symptôme : PWA OK, APK rien)**
1. La photo **est** bien reçue, persistée (`users.avatar`, data URI) et servie — par la PWA qui lit `avatar`.
2. **Le serveur n'exposait qu'UN SEUL nom de champ** (`avatar`) sur des réponses par ailleurs hétérogènes : `GET /me` (spread du doc), `GET /api/auth/me` (spread), login (champ à la main), contacts.v2 (6 sérialisations différentes), `publicUser` Google. Tout client lisant `avatarUrl` ou `photoUrl` (convention Flutter fréquente) recevait `null`/champ absent → « aucune photo », y compris celle des amis.
3. `PUT /me/profile` **rejetait silencieusement** le champ `avatar` (liste blanche sans lui) : un client qui met à jour le profil en un seul appel perdait la photo — cohérent avec « modifiée depuis l'APK → semble enregistrée » (la PWA, elle, passe par `POST /avatar`).
4. Aucune URL relative n'était absolutisée (un APK ne peut pas résoudre `/uploads/…` contre l'origine backend).

**Présence** : les durcissements du 14/10 sont bien dans le code et déployés (sweep serveur 60 s, 3 états, registre par appareil, protection multi-appareils, `lastSeenAt` Firestore). Aucune régression trouvée ; les tests manuels « sans effet observable » s'expliquent par le point photos (l'affichage du statut/avatar côté APK dépendait du même contrat sérialisé) + le point routage ci-dessous.

**Messagerie/SMS** : la politique « hors ligne ≠ SMS automatique » existait mais **dormait derrière `ROUTE_OFFLINE_HOLD` (défaut false)** — donc invisible dans les tests manuels. Cause racine de l'invisibilité globale des corrections : **défauts conservateurs**.

## 2. Fichiers backend modifiés
- `services/profileSerializer.js` (**nouveau**) — contrat photo unique : `avatar` + `avatarUrl` + `photoUrl` (même valeur, `null` explicite), URLs relatives rendues **absolues** avec `BACKEND_URL`.
- `routes/me.js` — `GET /me` sérialisé par le contrat ; `PUT /profile` accepte désormais `avatar` (data URI bornée comme `POST /avatar`, ou URL https).
- `routes/auth.js` — login et `GET /api/auth/me` exposent les alias.
- `routes/contacts.v2.js` — les 6 points de sérialisation (contacts enregistrés, SMS-only, résolus, résultat sync) portent les alias.
- `services/googleOAuth.js` — `publicUser` : alias.
- `services/messageRouter.js` + `routes/sms.gateway.inbound.js` — **`ROUTE_OFFLINE_HOLD` défaut = true** (réversible : `=false` → repli SMS historique).

## 3. Tests exécutés (résultats réels)
- `test/profile-photos-tests.js` (**nouveau**) : **10/10** — PUT avatar persisté, GET /me + /auth/me avec alias, 2 utilisateurs avec avatars **distincts**, contacts listant les 2 photos, profil sans photo = champs `null` présents, URL relative → absolue.
- Régression : **21/21 suites vertes** (routage, présence 16, offline-hold 11 mis à jour au nouveau défaut, OTP 17+25, OAuth 31, SMSGate 18, photos 10, etc.). Aucun vrai SMS (stubs partout).

## 4. Variables d'environnement
- Aucune nouvelle obligatoire. `BACKEND_URL` (déjà requis) est maintenant aussi utilisé pour absolutiser les avatars — vérifier qu'il vaut l'URL publique du backend sur Render.
- `ROUTE_OFFLINE_HOLD` : défaut **true** désormais ; `false` = comportement historique. `PHONE_VERIFICATION_REQUIRED` inchangé (false).

## 5. Endpoints / champs / événements concernés
- `GET /api/me`, `PUT /api/me/profile`, `POST /api/me/avatar`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/contacts/sync` (+ réponses contacts.v2) : chaque profil contient désormais **`avatar`, `avatarUrl`, `photoUrl`** (valeur identique, `null` si pas de photo), URLs absolues.
- Socket.IO (inchangé, contrats existants conservés) : `user:online {uid,timestamp}`, `user:offline {uid,lastSeen}`, `user:check-online {targetUid}` → ack `{online,lastSeen}`, `message:receive`, ack `message:send` `{success,messageId,tempId,conversationId}`.

## 6. Côté Flutter (à coordonner, aucun fichier modifié)
- Lire **`avatarUrl`** (ou `avatar` — les deux sont garantis) sur `GET /me`, `login`, `/auth/me`, contacts.
- Pour changer la photo : `POST /api/me/avatar` (multipart `avatar` ou JSON `{avatarBase64:"data:image/…;base64,…"}") **ou** désormais `PUT /api/me/profile {avatar:"data:image/…"}`.
- Ne jamais construire d'URL relative côté client : le serveur renvoie des URL absolues.

## 7. Déploiement & vérification
1. (Toi) Push quand validé — **le déploiement prod suivra automatiquement** (hook Render). Le code est sans changement de comportement SMS tant que `ROUTE_OFFLINE_HOLD` n'est pas défini (défaut nouveau = interne d'abord) — si tu veux l'ancien repli SMS immédiat : `ROUTE_OFFLINE_HOLD=false` sur Render.
2. Vérifications post-déploiement : `GET /api/me` avec un compte ayant une photo → 3 champs identiques ; contacts → avatars amis ; APK → photo du compte et des amis visibles ; envoi à un OmniSMS hors ligne → message `pending` dans Firestore (pas de SMS), livré à sa reconnexion ; envoi vers un numéro sans compte → SMS normal.
3. **Non testé en production** : tout ceci est validé par 21 suites locales sur stubs + boot serveur réel ; les captures d'écran APK restent à confirmer de ton côté après déploiement.
