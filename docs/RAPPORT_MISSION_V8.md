# Rapport — Mission v8 : fiabilité du secours (outbox Firestore) + qualité de transcription Groq

**Statut : implémenté et testé (18/18 dédiés, régression 36/36) — commité et poussé.**
**Note branche** : aucune branche `dev` n'existe dans le dépôt — commité sur `main`.
**SMS classique et parcours audio → transcription → SMS : préservés (re-testés, aucune modification de la configuration ni du fournisseur).**

---

## 1. Audit (avant modification) — synthèse

- **Normal** : jobs dans BullMQ (files `transcription`, `sms`, `sms_dlq`) sur Redis, workers dédiés, retries BullMQ (backoff exponentiel), `jobId: sms-{messageId}` (dédup).
- **Inline** : Redis absent/quota épuisé → exécution immédiate par handlers inline (v7 : enregistrés avant fermeture des workers), résultats honnêtes.
- **Transcription** : Groq/Whisper (`whisper-large-v3-turbo`, `language:fr`, `verbose_json`, timeout 120 s) → doc message (`transcription`, `transcriptionStatus`) → reprise SMS (`resumeAudioSms`).
- **SMS** : envoi direct synchrone → échec → `enqueueSmsJob` (BullMQ/inline) ; statuts et marqueurs anti-doublon succès-seul ; DLR SMSGate (v7).
- **Risques identifiés** : ① les tâches exécutées INLINE en cas d'échec (gateway/Groq en panne) ou de crash du process étaient **perdues** (rien ne les reprendait après redémarrage — le sweep v7 ne couvrait que les vocaux) ; ② Groq : pas de `temperature` ni de `prompt` (hallucinations possibles), texte vide = abandon sans nouvelle tentative.

## 2. Corrections — fichiers modifiés

| Fichier | Modification |
|---|---|
| `services/fallbackOutbox.js` (**nouveau**) | Outbox durable Firestore `queue_fallback/{kind}:{id}` : enregistrement AVANT exécution, `done` après succès, retry **borné à délais progressifs** (30 s → 1 h, max 4), bail `claimUntil` (anti-simultané), `lastError` (traçabilité), `alreadyDone` (anti-doublon), jamais bloquant |
| `services/queueService.js` | `_runInlineTracked` (les 2 chemins inline enregistrent/exécutent/marquent) ; `recoverFallbackTasks` (reprise due-tasks, preferQueue pour réintégrer BullMQ au retour Redis) ; `startFallbackRecovery` (cycle différé au boot + 1/min) ; reprise déclenchée aussi au retour de Redis (sonde) |
| `workers/transcriptionWorker.js` | Texte vide/manifestement incomplet → **1 nouvelle tentative de transcription** (jamais de l'envoi → aucun SMS en double) |
| `services/transcriptionService.js` | Paramètres API Groq réels : `temperature=0` (déterministe, moins d'hallucinations) + `prompt` contexte français (surchargeable `GROQ_PROMPT`) |
| `server.js` | Démarrage de la reprise outbox au boot (non bloquant) |
| `test/v8-tests.js` (**nouveau**) | 18 vérifications |

## 3. Comportement final (architecture inchangée)

- **Redis OK** → files BullMQ normales, workers inchangés, **aucune écriture outbox**.
- **Redis indispo** → inline + tâche enregistrée dans l'outbox AVANT exécution → succès : `done` ; échec SMS (`success:false` ou exception) : `pending` avec `nextAttemptAt` progressif → repris automatiquement (1/min au boot + périodique) → succès : `done` ; 4 échecs : `failed` + `lastError`.
- **Redémarrage serveur** → les `done` ne sont JAMAIS ré-exécutés ; les non-terminés sont repris (bail anti-concurrent).
- **Retour Redis** → les tâches dues sont réintégrées dans les files BullMQ normales (`preferQueue`), sinon exécutées inline.
- **Parcours audio** : chaque étape a un état identifiable (`transcriptionStatus`, `smsAfterTranscription`, `smsFallback`, `smsMessageId`, `smsAcceptedAt`/`deliveredAt`) ; erreur de transcription → audio conservé, message reprisable ; erreur SMS → pas de nouvelle transcription ; reprise → jamais de double SMS (bail + `alreadyDone` + marqueurs succès-seul + claim audioSms).

## 4. Tests réellement exécutés (`test/v8-tests.js` : 18/18) + régression 36/36

1. **SMS Redis indisponible** → inline + outbox `done` ✓ 2. **SMS inline échec** → `attempts=1` + backoff, pas « done » ✓ 3. **Reprise après erreur** (échéance simulée) → ré-exécuté UNE fois → `done` ✓ 4. **Transcription Redis indispo** → inline + outbox ✓ 5. **Tâches simultanées** → chacune exécutée une seule fois ✓ 6. **Bail valide** → pas de traitement concurrent ✓ 7. **Max attempts** → `failed` + `lastError`, plus jamais retenté ✓ 8. **Retour Redis** (`preferQueue`, chemin inline testé) → réintégrée puis `done` ✓ 9. **Redémarrage** (modules rechargés) → `done` jamais ré-exécutés, aucun doublon ✓ 10. **Groq texte vide** → 2 appels (1 re-tentative) → SMS envoyé UNE fois avec le texte, statuts complets, audio conservé ✓ 11. Paramètres Groq (`temperature=0`, `prompt`) vérifiés dans le multipart réel ✓.

**Avant/après mesurable** : avant, un crash pendant un échec inline = tâche perdue (statut pending à jamais) ; après, la tâche est dans `queue_fallback` et reprise au boot — vérifié par test (§9).

## 5. Statuts

| Élément | Statut |
|---|---|
| Audit avant modification | **RÉUSSI** |
| Secours durable (outbox Firestore) : record/done/retry/bail/failed | **RÉUSSI** (simulé) |
| Reprise après erreur / redémarrage / simultané / max-attempts | **RÉUSSI** (simulé) |
| Retour de Redis : réintégration (chemin inline testé) | **RÉUSSI** (simulé) — reprise BullMQ réelle NON TESTÉ (pas de Redis réel dans le sandbox) |
| SMS avec Redis DISPONIBLE (file BullMQ réelle) | **NON TESTÉ** (pas de Redis réel ici) — code inchangé sur ce chemin |
| Groq : temperature/prompt + re-tentative texte vide | **RÉUSSI** (simulé) — Groq réel NON TESTÉ |
| Anti-doublons SMS/transcription | **RÉUSSI** (simulé) |
| Non-régression (36 suites) | **RÉUSSI** |

## 6. Risques restants

- Panne Redis réelle + crash simultané du process : tâche perdue si elle n'a jamais atteint l'outbox (fenêtre très réduite ; atténué par le sweep vocaux v7 + re-routes idempotentes).
- Re-transcription possible d'un même fichier lors d'une reprise (jamais de double SMS : claim + marqueurs) ; transcription idempotente sur le même audio.
- La reprise outbox lit ≤ 40 docs/scan (borné) : au-delà de ~40 tâches en attente simultanées, le drain prend plusieurs cycles (1/min).

*Simulé uniquement : Groq et SMSGate mockés — aucun SMS réel, aucun appel Groq réel.*
