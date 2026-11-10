# Notifications push distantes V3 (FCM / APNs) — rapport
**Date** : 2026-11-06 · Commit local (non poussé) · FCM **simulé** dans les tests — aucune notification réelle envoyée.

## 1. Statuts RÉELS (distinction obligatoire)

| Mécanisme | Statut | Preuve / limite |
|---|---|---|
| Notifications locales Socket.IO | ✅ **Opérationnel — INTACT** | Aucune modification du canal temps réel ; régression 25/25 suites (routing-presence, offline-hold, session11…) vertes. App au premier plan : `message:receive` via socket, comme avant |
| Enregistrement des tokens | ✅ **Implémenté et testé (20/20)** | `POST /notifications/register` (201, upsert, ré-assignation au compte, masquage), `/unregister` (403 si autre compte), `/devices` — serveur réel + Firestore simulé |
| Push distant Android (FCM) | 🟠 **Prêt côté serveur, NON validé sur appareil réel** | Dispatcher multicast (priorité haute) + invalidation auto des tokens morts testés sur FCM **simulé** ; l'envoi réel exige une app Android intégrant le SDK Firebase (aucune n'est encore connectée) |
| Push distant iOS (APNs) | 🟠 **Prêt côté serveur (même chemin, `platform:'ios'`), NON opérationnel de bout en bout** | Backend identique via FCM ; MAIS exige (1) clé APNs `.p8` chargée dans la console Firebase — **action console du propriétaire**, (2) l'app iOS avec SDK Firebase (inexistante à ce jour) |

**Rappel honnêteté** : aucun test réel FCM/APNs n'a été possible (aucun appareil, aucun projet Firebase configuré pour le messaging ici).

## 2. Architecture implémentée
- **Registre** : collection Firestore `device_tokens` (1 doc/token, id = sha256(token)) : `uid, token, platform (android|ios|web), deviceId, createdAt/updatedAt`. Ré-assignation automatique si l'appareil change de compte ; tokens JAMAIS loggés ni renvoyés (masqués `abcdefgh…1234`).
- **Endpoints** (JWT obligatoire — ajoutés au routeur **existant** `/notifications`, dont les endpoints préférences `PUT /toggle`, `PUT|GET /preferences` sont **préservés à l'identique**) :
  - `POST /notifications/register {token, platform, deviceId?}` → 201
  - `POST /notifications/unregister {token}` → 200 (403 si le token appartient à un autre compte)
  - `GET /notifications/devices` → liste masquée
- **Dispatch** : `services/pushService.sendPushToUser(uid, {title, body, data})` — multicast (`sendEachForMulticast`, Android `priority: high`, APNs `apns-priority: 10`), **invalidation automatique** des tokens rejetés (désinstallation), respect de la préférence **`notificationsEnabled`** (toggle existant), échec jamais bloquant.
- **Déclenchement** : message interne vers un utilisateur **hors ligne** (app en arrière-plan/fermée — branche offline-hold du routeur) → push « OmniSMS / aperçu du message » avec `{type:'new_message', messageId, conversationId, senderId}`. App en ligne → Socket.IO uniquement (pas de doublon local+push).
- **Coexistence garantie** : Socket.IO (temps réel, premier plan) ET FCM/APNs (arrière-plan/fermé) cohabitent ; ni l'un ni l'autre remplacé.

## 3. Problème détecté et corrigé au passage
Mon premier patch avait **écrasé** `routes/notifications.js` (routeur de préférences existant depuis v2.4, monté sur `/notifications`) — **détecté immédiatement, restauré** : les préférences originales sont intactes et mes endpoints ont été **fusionnés** dans le même routeur. Régression verte (§5).

## 4. Fichiers modifiés
| Fichier | Changement |
|---|---|
| `services/pushService.js` (**nouveau**) | Registre tokens + dispatcher multicast + invalidation + préférence `notificationsEnabled` |
| `routes/notifications.js` | Endpoints préférences **originaux préservés** + `register`/`unregister`/`devices` ajoutés |
| `services/messageRouter.js` | Push fire-and-forget dans la branche offline-hold (destinataire sans socket) |
| `test/push-notifications-tests.js` (**nouveau**) | 20 checks (§5) |

## 5. Tests exécutés — résultats réels
**20/20 PASS** : 401 sans auth (×2) · 400 token court / platform invalide · 201 register Android (token lié au compte authentifié + deviceId) · upsert rafraîchissement (created:false) · register iOS (platform ios) · **ré-assignation** au nouveau compte · listing **masqué** · multicast 2 appareils + priorité haute · `no_devices` sans erreur · **invalidation auto** (tokens « not-registered » supprimés) · `PUT /toggle` original 200 · **push désactivé si `notificationsEnabled=false`** · `GET /preferences` original 200 · unregister **403** (autre compte) / 200 propriétaire + suppression.
**Régression : 25/25 suites vertes** (incluant les suites Socket.IO/temps réel — canal local intact). FCM simulé : **zéro notification réelle**.

## 6. Ce qui MANQUE pour que FCM/APNs soient réellement opérationnels
1. **Console Firebase** : activer Cloud Messaging ; enregistrer l'app Android (package + empreinte SHA-1) → `google-services.json` pour l'équipe Flutter.
2. **iOS** : charger la **clé APNs (.p8)** (Apple Developer) dans la console Firebase + enregistrer l'app iOS (bundle ID) — sans cela, les tokens iOS n'aboutissent jamais.
3. **App Flutter** : intégrer `firebase_messaging` (permissions Android 13 POST_NOTIFICATIONS, demande runtime), obtenir le token et l'envoyer à `POST /notifications/register` (avec le JWT session) à chaque lancement/rotation ; afficher la notification en arrière-plan ; appeler `/unregister` au logout. iOS : demande de permission APNs.
4. **Test réel** (après 1–3) : envoyer un message à un appareil en arrière-plan → notification reçue ; désinstaller l'app → token auto-purgé au prochain envoi. **Aucune de ces validations n'a été faite — je ne déclare PAS le push opérationnel.**

## 7. Variables d'environnement
**Aucune nouvelle variable backend.** `FIREBASE_SERVICE_ACCOUNT_JSON` est déjà configuré en prod (vérifié via /api/diag, valeur masquée) — c'est la même clé qui autorise l'envoi FCM une fois le messaging activé dans la console. Côté apps : `google-services.json` (Android) / `GoogleService-Info.plist` (iOS) — fournis par la console Firebase, jamais dans le dépôt backend.
