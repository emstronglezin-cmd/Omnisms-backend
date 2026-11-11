# Rapport final — Mission v2 (12/11) : Routage automatique SMS + SMSGate + transcription vocale

**Commit : `4986744` — POUSSÉ sur main et DÉPLOYÉ en prod** (Render redémarré, vérifié le 12/11 : uptime frais + checks verts : firebase/jwt ok, smsProvider ACTIVE, `activeProvider: smsgate` configured, transcription ACTIVE via groq-whisper, Socket.IO ACTIVE, queue inline-quota attendue)
**Exécution réelle** : code implémenté, tests écrits et exécutés, 3 bugs corrigés (dont 1 découvert par les nouveaux tests).

---

## 1. Fichiers modifiés — **RÉUSSI**

| Fichier | Modification |
|---|---|
| `services/smsFallback.js` (nouveau) | Politique **AUTO par défaut (opt-out)** : `smsFallbackEnabled === false` = désactivation explicite par le destinataire ; `phoneVerified === true` strict ; E.164 depuis le compte persisté ; coupe-circuit global ; anti-doublon 2 niveaux (marqueurs écrits **après succès seulement**) |
| `services/messageRouter.js` | Hold : texte → dispatch secours immédiat ; **audio → armement de la transcription** (politique vérifiée AVANT la dépense) ; `senderName` stocké sur le message retenu ; FIX chemin audio synchrone (voir §2) |
| `workers/transcriptionWorker.js` | Reprise restructurée : chemin externe d'abord, puis `resumeAfterTranscription` (l'ancien code était **inatteignable** — voir §2) |
| `routes/me.js` | `smsFallbackEnabled` exposé (PUT /me/profile), commentaire défaut AUTO |
| `test/sms-fallback-tests.js` (nouveau) | 24 vérifications couvrant la table des 10 scénarios de la mission |

## 2. Fonctionnalités corrigées — **RÉUSSI**

1. **CAS B prioritaire** : un compte OmniSMS hors ligne est désormais joint par SMS ordinaire (SMSGate) au lieu d'un hold systématique sans examen. Posséder un compte n'empêche plus le SMS.
2. **Vocaux hors ligne** : transcription (pipeline existant, Groq) puis `[OmniSMS Vocal] {expéditeur} : {texte}` via SMSGate. Audio original **jamais supprimé** ; transcription vide → **aucun SMS** + erreur enregistrée + message reprisable ; échec Groq → message conservé en attente, reprisable.
3. **Bug découvert par les tests** : le chemin audio externe synchrone ne connaissait que `sms_gateway`/`infobip` — avec SMSGate actif, le texte transcrit n'était **pas envoyé, en silence**. Corrigé (branche `smsgate`).
4. **Bug d'inatteignabilité** : `resumeAudioSms` retournait normalement avant d'atteindre la reprise du secours. Corrigé (structure `if (action !== 'skipped') return`).
5. **CAS C** : externe sans compte → SMSGate direct au numéro (mécanisme SESSION 13 existant, complété), pas de compte artificiel.
6. **CAS A préservé** : connecté → Socket.IO interne uniquement, jamais de SMS en doublon (testé).

## 3. Fonctionnement final — **RÉUSSI** (en simulé)

- Texte, destinataire connecté → interne Socket.IO. Texte, hors ligne ou sans compte → SMS SMSGate (si politique OK) sinon hold conservé avec motif.
- Vocal, connecté → audio original, transcription seulement à la demande. Vocal, hors ligne/sans compte → armement → transcription → SMS texte.
- Statuts granulaires conservés : `smsFallback` (sent/failed/skipped+raison), `smsAfterTranscription` (pending/sent/failed/skipped_empty_transcription/…). Jamais « envoyé » sans confirmation fournisseur.

## 4. État transcription — **RÉUSSI (simulé) / réel NON TESTÉ**

Pipeline existant réutilisé (aucune reconstruction) : `queueService.addTranscriptionJob` (inline sans Redis) → worker → Groq. Groq réel **NON TESTÉ** depuis ce backend (aucun appel réel).

## 5. État SMSGate — **RÉUSSI (contrat) / envoi réel NON TESTÉ**

Intégration existante réutilisée (pas de 2e intégration), 4 vars `SMS_GATEWAY_*` intactes. Contrat confirmé sur le serveur réel le 10/11 (`api.sms-gate.app` /health 200 v1.52.5). Auth auto JWT→Basic. **Aucun SMS réel envoyé à ce jour.**

## 6. Problèmes Redis restants — **CONTOURNÉ (reporté)**

Prod en `inline-quota` (Redis saturé, sms_gateway paused) : sans impact sur le routage (jobs inline). Aucune perte silencieuse : message non traité = doc `pending` identifiable + motif. Pas de doubles envois (dédup sur id pré-généré ET id Firestore).

## 7. Tests + résultats — **RÉUSSI (simulé)**

- `test/sms-fallback-tests.js` : **24/24 PASS** (SMSGate + Groq simulés, 0 SMS réel, 0 quota prod).
- Régression complète : **28/28 suites vertes** (routage, SMSGate, quota, crédits, push, photos, OTP…).

## 8. À tester sur vrai téléphone — **NON TESTÉ** (checklist)

1. Destinataire OmniSMS **hors ligne** (vérifié, AUTO par défaut) → envoyer texte depuis un autre compte → le Z Fold2 (SIM passerelle) doit émettre un SMS `OmniSMS — {expéditeur} : …`.
2. Opt-out : `PUT /api/me/profile {"smsFallbackEnabled": false}` → plus aucun SMS, motif `recipient_opted_out` dans les logs.
3. Vocal réel → vérifier transcription Groq réelle puis SMS `[OmniSMS Vocal] …`.
4. SMSGate coupé (app fermée sur le Z Fold2) → statut `failed`, message conservé, pas de faux succès.
5. Sonde admin : `POST /api/diag/sms-test` (header `x-admin-key`, body `{to, text}`) — numéro autorisé uniquement.

## 9. Variables Render manquantes (noms seuls) — **RÉUSSI (recensement)**

`METRICS_TOKEN` · `INFINIREACH_WEBHOOK_SECRET` · `INFINIREACH_REQUIRE_SIGNATURE` · `BACKEND_URL`
(Les 4 `SMS_GATEWAY_*` sont déjà posées — rien à renommer, rien à recréer.)

## 10. Commandes de test / déploiement — **RÉUSSI (fournies)**

```bash
# Tests locaux (simulés, sans SMS réel)
npm install && node test/sms-fallback-tests.js

# Déploiement — EFFECTUÉ le 12/11 :
git push origin main   # 9fce62b..4986744 → Render : redémarrage vérifié (/health vert)
```

---

## Bilan des statuts

| Composant | Statut |
|---|---|
| Implémentation routage auto (3 cas + vocaux) | **RÉUSSI** |
| Tests simulés (24/24 + régression 28/28) | **RÉUSSI** |
| Envoi SMS réel (Z Fold2 → SMSGate) | **NON TESTÉ** |
| Transcription Groq réelle | **NON TESTÉ** |
| Push FCM/APNs réel | **NON TESTÉ** (hors périmètre v2) |
