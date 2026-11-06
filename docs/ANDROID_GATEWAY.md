# Passerelle Android OmniSMS — architecture finale (stratégie SMS retenue)
**Date** : 2026-11-06 · Commits : voir `git log` (local, NON poussés — déploiement soumis à ta validation).
**Décisions appliquées** : Redis/Upstash REPORTÉ (0 $) · SMS = **passerelle Android propriétaire** · INfiniReach conservé comme alternative documentée · messagerie Internet inchangée · PWA compatible (24/24 suites).

---

## 1. Problèmes détectés (audit de cette mission)
1. Sans Redis (quota épuisé), les jobs SMS tombaient en **exécution inline immédiate** : si la passerelle était indisponible, le job échouait **sans file persistante** — aucun mécanisme de « tâches en attente survivant au redémarrage ».
2. La stratégie SMS dépendait d'INfiniReach (app tierce) — la décision retenue exige une **passerelle Android maîtrisée** avec appareils autorisés, révocables.
3. Aucun endpoint d'enregistrement/authentification d'appareils passerelle.
4. (Hérités, déjà corrigés le 06/11 matin) : webhook strict fail-closed, `/api/diag` gated, fallback URL photos — **vérifiés à nouveau**.

## 2–3. Fichiers modifiés / corrections effectuées
| Fichier | Contenu |
|---|---|
| `services/androidGateway.js` (**nouveau**) | **Outbox persistante Firestore** (`sms_outbox`) : 1 tâche par messageId (id = messageId, set-merge idempotent) ; statuts `pending → claimed → sent / (retry →) failed` ; **claim transactionnel** (2 appareils ne peuvent jamais obtenir la même tâche) ; `claimedBy` vérifié sur le résultat (un appareil ne conclut pas les tâches d'un autre) ; **retries bornés** (`GATEWAY_MAX_ATTEMPTS`, défaut 3) ; **reprise automatique** des tâches abandonnées (`GATEWAY_STALE_MS`, défaut 5 min) ; appareils : jeton 256 bits affiché UNE fois, stocké **hashé SHA-256**, comparaison timing-safe, révocation immédiate ; journaux sans secrets (numéros masqués, contenu jamais loggé) |
| `routes/gateway.js` (**nouveau**) | `POST /api/gateway/register` (x-admin-key) → `{deviceId, token}` ; `POST /api/gateway/devices/:id/revoke` (x-admin-key) ; `GET /api/gateway/devices` (x-admin-key, sans hash) ; `GET /api/gateway/outbox/stats` (x-admin-key) ; `POST /api/gateway/claim` (x-gateway-device + x-gateway-token) ; `POST /api/gateway/result` (appareil) |
| `services/smsQueueWorker.js` | Transport `android_gateway` en priorité quand `OFFLINE_SMS_PROVIDER=android_gateway` ; **statut honnête** : tâche en outbox ⇒ message interne reste `pending` avec `smsStatus=QUEUED_OUTBOX` (jamais « sent » tant que l'appareil n'a pas confirmé) ; `selectTransport` exporté (diag/tests) |
| `services/otpService.js` | Transporteur OTP `android_gateway` (`OTP_PROVIDER=android_gateway`) — l'OTP peut passer par la même passerelle |
| `server.js` | Montage `app.use('/api/gateway', gatewayRoutes)` |
| `test/android-gateway-tests.js` + `test/android-gateway-phases.js` (**nouveaux**) | 24 checks (§4) |

**Sans Redis (désactivation propre)** : le chemin `enqueueSmsJob` → handler inline → écriture outbox Firestore fonctionne **sans aucune file mémoire** ; les tâches attendent dans Firestore jusqu'au claim par l'appareil. Rien à désactiver côté code : `QUEUE_MODE=inline` ou quota épuisé ⇒ l'outbox prend le relais. **Les messages en attente survivent aux redémarrages** (testé).

## 4. Tests exécutés — résultats réels
`test/android-gateway-tests.js` : **24/24 PASS** —
admin : register 401/401/201 + token 256 bits **stocké hashé** · révocation 200 · liste sans hash · stats.
appareils : claim sans auth 401 · mauvais jeton 401 · **révoqué 401**.
flux : création 2 tâches · re-enqueue même id = toujours 1 doc (**idempotence**) · claim autorisé = 2 tâches · **2e claim = 0 (anti-doublon)** · résultat par autre appareil **403** · résultat OK → tâche sent + message interne `sent/SENT/android_gateway` · double résultat idempotent.
retries : 3 échecs → attempts 1→2→3 → **échec définitif, plus récupérable** (pas de boucle) · message `failed/FAILED`.
reprise : tâche claimée abandonnée 30 min → re-claimée automatiquement (attempts 2).
transport SANS Redis : `selectTransport → android_gateway` · tâche écrite en outbox · message interne `pending + QUEUED_OUTBOX` (honnête).
redémarrage : **nouveau process** → tâche toujours récupérable + résultat transmissible.
**Régression : 24/24 suites vertes** (routage, présence, offline-hold, OTP, OAuth, crédits, SMSGate, redis-quota, photos, stabilisation…). Aucun SMS réel envoyé.

## 5. Variables d'environnement (Render — actions propriétaire)
| Variable | Rôle | Obligatoire |
|---|---|---|
| `OFFLINE_SMS_PROVIDER=android_gateway` | Active la stratégie passerelle Android (**bascule quand ton app sera prête** — sinon INfiniReach continue) | au moment de la bascule |
| `ADMIN_KEY` | Protège register/revoke/list/stats **et** `/api/diag` | ✅ recommandé |
| `GATEWAY_MAX_ATTEMPTS` (3) · `GATEWAY_STALE_MS` (300000) | Retries / reprise | non |
| `METRICS_TOKEN` · `INFINIREACH_WEBHOOK_SECRET` · `INFINIREACH_REQUIRE_SIGNATURE=true` · `BACKEND_URL` | Sécurité/URLs (déjà prêts côté code) | recommandé |
| Redis | **Rien à faire** — REPORTÉ. Si le quota re-sature : mode inline + outbox, zéro boucle d'erreurs (prouvé en prod) | — |

## 6. Migrations
**Aucune migration destructive.** Deux nouvelles collections Firestore (`sms_outbox`, `gateway_devices`) créées à la volée au premier usage. Aucune donnée existante touchée. Aucune suppression de file/stockage.

## 7. Actions manuelles restantes (propriétaire)
1. Déployer (push sur ta validation) → CI verte attendue.
2. Créer l'appareil : `curl -X POST .../api/gateway/register -H "x-admin-key: …" -d '{"name":"Z Fold2"}'` → **noter le token (affiché une seule fois)**.
3. **Développer/configurer l'app Android** : elle doit (a) appeler `POST /api/gateway/claim` toutes les ~30 s (en-têtes `x-gateway-device`/`x-gateway-token`), (b) envoyer le SMS via SmsManager, (c) appeler `POST /api/gateway/result` avec `{messageId, success, error}`. Contrat exact : `docs/ANDROID_GATEWAY.md` §2 — l'app INfiniReach existante n'implémente PAS ce contrat (app OmniSMS à faire, ou adaptation).
4. Basculer `OFFLINE_SMS_PROVIDER=android_gateway` **après** validation du test réel (§8).

## 8. Non testé sur un vrai appareil (honnêteté)
- L'**envoi réel d'un SMS** par une app Android via ce contrat (claim → SmsManager → result) : non testé — aucun appareil physique dans ce sandbox. Le protocole de test contrôlé reste celui de `docs/STABILISATION_LANCEMENT.md` §6.
- Le comportement de la vraie app INfiniReach vis-à-vis de l'outbox (non concernée : contrat différent).
- Les requêtes Firestore transactionnelles en conditions réelles de concurrence (le stub simule la sémantique ; le SDK réel la garantit).
- iOS : ne peut jamais servir de passerelle SMS (limite plateforme) — l'app iOS consommera la messagerie Internet uniquement.
