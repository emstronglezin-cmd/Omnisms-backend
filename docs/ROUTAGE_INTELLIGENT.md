# Routage intelligent V3.1 — cascade interne → push → SMS de secours consenti
**Date** : 2026-11-06 · Commit `1a444fc` (local, non poussé) · Régression **28/28 suites vertes** · SMSGate simulé dans les tests — **aucun SMS réel envoyé**.

## 1. Le constat, expliqué
`recipientOnline:false → route: OMNISMS (hold), aucun appel SMSGate` était le **comportement conçu** (politique offline-hold) : jamais de SMS sans consentement. Ce qui manquait, c'est le **3e étage** : le secours SMS **optim-in du destinataire**. Il est maintenant implémenté.

## 2. Architecture de routage (définitive)
| Cas du destinataire | Ce qui se passe |
|---|---|
| OmniSMS **connecté** | Socket.IO `message:receive` + Firestore — **jamais de SMS** (prouvé : isolation 11/11) |
| OmniSMS **hors ligne** (arrière-plan/fermé) | 1) message en conversation (`pending`) · 2) **push distant** si token valide (`pushService`) · 3) **SMS de secours via SMSGate** SI ET SEULEMENT SI : `smsFallbackEnabled===true` (opt-in destinataire) **ET** `phoneVerified===true` (strict) **ET** numéro E.164 valide **ET** transport disponible. Sinon : message conservé + **motif honnête** dans la réponse (`smsFallback: skipped:<raison>`) |
| **Numéro externe** (sans compte) | SMS externe existant → SMSGate (actif en prod depuis `SMS_GATEWAY_*`) |

La présence n'a pas été réécrite : elle est déjà fiable (TTL 5 min renouvelé par heartbeat client + sweep serveur 60 s + sessions multi-appareils + reconnexion synchronisée — 16 tests dédiés). Ne pas considérer un utilisateur hors ligne pour un simple silence = exactement ce que fait le TTL/heartbeat (pas de détection par « réponse à un événement »).

## 3. Fichiers modifiés / créés
- `services/smsFallback.js` (**nouveau**) — moteur de politique : interrupteur global `SMS_FALLBACK_ENABLED`, opt-in destinataire, numéro vérifié **strict**, numéro lu depuis le compte persisté (**jamais déduit de l'UID**), texte « OmniSMS — {expéditeur} : … » borné à 160 caractères (**le SMS part de la SIM du téléphone passerelle Z Fold2, pas de la SIM personnelle de l'expéditeur** — d'où l'expéditeur nommé), **anti-doublon double niveau** (statut dans le message + marqueurs logiques écrits **uniquement après confirmation d'envoi** — un échec reste reprenable volontairement).
- `services/messageRouter.js` — cascade branchée dans offline-hold ; `smsFallback` (statut honnête + raison) retourné dans le résultat de routage.
- `routes/me.js` — `PUT /me/profile` accepte `smsFallbackEnabled` (le consentement est réglable par l'utilisateur ; **défaut = non consenti**).
- `test/sms-fallback-tests.js` (**nouveau**) — 17 checks.

## 4. Endpoints (aucune rupture de contrat)
- Existants conservés : `POST /api/messages|/send` (réponse enrichie de `smsFallback`), Socket.IO inchangé, `POST /notifications/register|unregister`, `GET /notifications/devices`.
- Enrichi : `PUT /api/me/profile {smsFallbackEnabled: true|false}`.
- Nouvelles collections Firestore (créées à la volée, aucune migration destructive) : `sms_fallback_dedup`.

## 5. Tests effectués — résultats réels
**Cascade (17/17, SMSGate simulé)** : hors ligne + consenti → **1 seul POST SMSGate** avec Device ID, numéro persisté (jamais l'UID), texte ≤160 c avec expéditeur nommé · re-route du même message logique → `already_handled`, **0 doublon** · sans consentement → `skipped:no_recipient_consent`, 0 SMS · consenti mais numéro non vérifié → `skipped:phone_unverified`, 0 SMS · `SMS_FALLBACK_ENABLED=false` → `skipped:disabled_globally` · consentement activé plus tard → le secours fonctionne · externe → SMS direct inchangé.
**Régression : 28/28 suites vertes** (présence 16, isolation SMSGate 11, push 20, passerelle Android 24, OTP, OAuth, crédits…).
**NON TESTÉ (honnêteté)** : SMS réel reçu sur un téléphone (aucun numéro de test fourni) ; push FCM/APNs réel (console Firebase + apps requises) ; comportement du vrai serveur SMSGate du propriétaire avec ses vraies valeurs.

## 6. Fiabilité intégrée
Anti-doublons (2 niveaux + dédup SMSGate existante), pas de boucle de routage (marqueurs + hold), statuts `queued/sent/delivered/failed` **uniquement sur confirmation du fournisseur** (déjà le cas du provider), jamais d'envoi sans consentement, jamais vers un numéro non vérifié, jamais de perte (hold + reprise reconnexion), jamais de confusion UID/téléphone.

## 7. Variables (noms seulement)
`SMS_FALLBACK_ENABLED` (optionnel, défaut on) — les 4 `SMS_GATEWAY_*` déjà en prod ; rien à renommer.

## 8. Pour tes tests réels (quand tu veux)
1. `PUT /api/me/profile {"smsFallbackEnabled":true}` avec le compte destinataire (numéro vérifié obligatoire).
2. Envoyer un message à ce compte, app fermée → **push** (si token enregistré) + **SMS du Z Fold2** vers son numéro.
3. Réception sur le téléphone = preuve. Sans ça, je marque : **SMS de secours réel : NON TESTÉ**.
