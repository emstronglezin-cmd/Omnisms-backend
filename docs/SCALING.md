# OmniSMS — Audit de montée en charge & fiabilité

*Établi le 13/10/2026 par audit de code (`main`, après `3c0326f`). Objectif : tenir
plusieurs milliers d'utilisateurs actifs, publication Google Play. Chaque affirmation
renvoie à une observation de code mesurée ; ce qui n'est pas mesuré est dit tel quel.*

---

## 1. Résumé exécutif

L'architecture est **fonctionnelle et bien dégradée en petit régime** (fallbacks mémoire
partout), mais elle repose sur des **états en mémoire进程 unique** et des
**dépendances optionnelles** qui deviennent des **points de défaillance uniques (SPOF)**
ou des **incohérences multi-instances** dès que l'on scale horizontalement ou que Redis
est absent. Le goulot primaire de capacité n'est **pas** le CPU : c'est
**l'infrastructure SMS physique** (appareils/SIM, quota fournisseur) et **Firestore**
(patron d'accès docs chauds, requêtes non paginées).

## 2. Goulots & SPOF identifiés (mesuré)

| # | Constat (code) | Impact à l'échelle | Sévérité |
|---|---|---|---|
| S1 | **Redis entièrement optionnel** — `services/redis.js` bascule sur un `MemoryStore` si `REDIS_URL` absent/injoignable. Présence (`online_ttl:*`, `online_users`), dédup webhooks (`omnisms:gateway:dedup:*`) et queues BullMQ basculent alors **en mémoire locale** (`services/queueService.js` : exécution inline). | 1 instance = OK ; **≥2 instances = incohérences** (présence fausse → faux routage SMS, doublons webhooks, queues non partagées). Redis Down ≠ alerte : un simple warn au boot. | 🔴 Critique |
| S2 | **Socket.IO mono-process, sans adaptateur Redis** — émissions `emitToUser()` locales uniquement (`services/socketService.js`). | Impossible de load-balancer le WebSocket (sticky sessions + même instance obligatoire) → plafond ≈ capacité d'1 instance Render. | 🔴 Critique |
| S3 | **File SMS : pas de DLQ, pas de jitter, pas de priorités** — `smsQueueWorker.js` : 3 tentatives backoff exponentiel strict (3/9/27 s), job perdu des « failed » sans ré-essaiPossible, aucun `priority` ; transcription lockDuration 120 s OK. | Un pic (webhook burst, quota) sature la file sans priorisation (une confirmation de paiement attend derrière des messages) ; échecs définitifs non audités séparément. | 🟠 Majeur |
| S4 | **Passerelle SMS mono-appareil** — `smsGateway.js` : un seul `INFINIREACH_FROM_NUMBER`/device. **Modèle de capacité réel non modélisé.** | Capacité = 1 SIM (cadence anti-blocage non gérée, ~quelques centaines de SMS/jour selon forfait). 1 000 utilisateurs actifs ≫ capacité. Pas de failover automatique (Infobip = fallback optionnel). + **quota gratuit fournisseur 402 déjà atteint (11/10)** : aujourd'hui, **aucun SMS ne part**. | 🔴 Critique (métier) |
| S5 | **Limites de débit et compteurs en mémoire** — `express-rate-limit`/`express-slow-down` (mémoire), `rechargeService._cmdWindow` (Map), `creditBilling._insufficientNotify` (Map), antifraude (`antifraud.js`, Maps IP/phone). | Reset à chaque redéploiement, non partagé entre instances, contournable si ≥2 instances (round-robin). | 🟠 Majeur |
| S6 | **Firestore : requêtes non paginées et docs chauds** — lecture `GET /api/messages` par conversation sans curseur explicite (limites présentes mais offset inconnu), `reconcile-expired` scanne `credit_ledger` (limit 200), `updateExternalConvLastMessage` = **1 écriture/conversation/message** (doc chaud sur conversations actives > 1 écriture/s), `om_daily_usage` idem par téléphone en journée de recharge, listeners : Flutter écoute Firestore en direct (frontend, à confirmer). | Throttling Firestore (limite ~1 écriture/s/doc soutenue), latence ↑, coût ↑. | 🟠 Majeur |
| S7 | **Pas d'endpoint liveness/readiness ni de métriques** — `/health` existe (diagnostic complet, riche) mais mélange les deux rôles ; aucune métrique Prometheus ; aucune alerte structurée (files, appareil offline, quota 402 = logs uniquement). | MTTR ↑ ; dérive de capacité invisible (file qui s'accumule, appareil mort). | 🟠 Majeur |
| S8 | **Plan Render free** — cold start ~1 min (mesuré session du 10/10 : timeout 20 s sur première requête), une seule instance, pas d'instance always-on, pas de workers séparés. | Indisponibilité périodique ; impossible de séparer workers/API. | 🔴 Critique (déploiement) |
| S9 | **Worker & API même processus** — `startSmsWorker()`/transcription lancés dans `server.js`. | Un pic de transcription (CPU) dégrade la latence API et les sockets. | 🟡 Moyen |
| S10 | **Pas de CI, Dockerfile minimal** (root, npm install, pas de HEALTHCHECK), pas d'environnement de staging documenté, pas de sauvegarde Firestore planifiée documentée. | Risque de régression au push (le push = deploy), pas de retour arrière formalisé. | 🟠 Majeur |

## 3. Capacité réelle SMS (modèle)

```
capacité_jour ≈ appareils × min(forfait_SIM/jour, cadence_sûre × heures_actives)
cadence_sûre (anti-blocage SIM, hypothèse opérateur à valider) : 1 msg / 20–60 s
→ 1 appareil ≈ 500–1 500 SMS/jour (fourchette prudente, non mesuré terrain)
```
| Utilisateurs actifs (hyp. 2 SMS externes/utilisateur/jour) | Appareils nécessaires (fourchette) |
|---|---|
| 1 000 | 2–4 |
| 5 000 | 7–10 |
| 20 000 | 27–40 |

→ **La montée en charge est d'abord un approvisionnement SIM** (et un accord
fournisseur payant), pas un problème logiciel. Le pool multi-appareils (partie A.3)
est le prérequis logiciel de cette mise à l'échelle.

## 4. Estimation coût Firestore (hypothèses explicatives, prix publics US)

Hypothèses/user/jour : 20 messages envoyés (dont 60 % internes), 40 lectures
conversations, 1 écriture profil/presence-approx. Prix : lecture 0,06 $/100k,
écriture 0,18 $/100k, suppression 0,02 $/100k, stockage 0,18 $/Gio. **Estimation
grossière, à recalibrer avec les métriques réelles (partie A.6).**

| Utilisateurs actifs | Lectures/j | Écritures/j | Coût/j (produits) | Coût/mois ≈ |
|---|---|---|---|---|
| 1 000 | 40 k | 14 k | ~0,05 $ | **~1,5 $** |
| 5 000 | 200 k | 70 k | ~0,25 $ | **~7,5 $** |
| 20 000 | 800 k | 280 k | ~1,00 $ | **~30 $** |

Le coût Firestore n'est **pas** le facteur limitant ; le sont la **cohérence des écritures
par doc** (S6) et l'architecture (S1/S2). NB : le plan Blaze (facturation à l'usage)
est **requis** dès que l'on sort des quotas gratuits.

## 5. Risques classés (priorité d'action)

1. 🔴 **P0 — SMS hors service aujourd'hui** (quota 402, cf. incident 11/10) : upgrade
   fournisseur / plan payant + pool multi-appareils. Sans cela, « plusieurs milliers
   d'utilisateurs » est impossible par construction.
2. 🔴 **P0 — Redis obligatoire + requis au démarrage** en production : `REDIS_REQUIRED=true`,
   adaptateur Socket.IO, readiness qui échoue si Redis absent (A.1).
3. 🔴 **P0 — Instance always-on** (Render starter +2) : zéro cold start, 2 instances min
   derrière load balancer (nécessite S1/S2 corrigés).
4. 🟠 **P1 — Files robustes** : workers séparés, DLQ, jitter, priorités (A.2).
5. 🟠 **P1 — Observabilité** : /metrics, alertes file/appareil/quota/5xx, suivi d'erreurs (A.6).
6. 🟠 **P1 — Durcissement Firestore** : compteurs shardés, pagination curseur, cache Redis
   des lectures chaudes, TTL (A.4).
7. 🟠 **P1 — CI + Dockerfile durci + staging** (A.8) ; rollback = redeploy du commit précédent (runbook §8).
8. 🟡 **P2 — Conformité Play** (partie B) : bloquants = politique confidentialité + suppression
   de compte + formulaire données ; targetSdk 36 (obligatoire depuis 31/08/2026).

## 6. Ce qui est déjà bon (à ne pas casser)

- Graceful degradation systématique (Redis/BullMQ/ stubs Firebase) — excellente en petit régime.
- Logs JSON avec `requestId` de corrélation (`middleware/logger.js`), masquage secrets.
- Idempotence déjà présente : dédup webhook (messageId), `externalId` fournisseur,
  jobId `sms-{messageId}`, ledger de crédits idempotent.
- Webhook signé HMAC (option à activer), validation stricte d'entrées partielle, CORS
  allowlist, helmet, compression, limites payload 10 Mo (à réduire), rate-limit global/auth.
- Graceful shutdown SIGTERM 30 s (`server.js`).
- Quota 402 en échec immédiat sans retry (depuis 11/10) — protège la file.

## 7. Plan d'implémentation (commits atomiques de cette série)

1. `docs/SCALING.md` (ce document).
2. Observabilité : `/metrics`, `/livez`, `/readyz`, validation d'env au boot (warn par défaut).
3. État partagé : store de taux Redis (limiteurs, commandes crédits, notifications) + adaptateur Socket.IO conditionnel.
4. Workers : processus séparé optionnel, DLQ, backoff+jitter, priorités, concurrence réglable.
5. Pool de passerelles Android : registre, routage least-loaded, failover, circuit breaker, cadence, alertes (flag).
6. Firestore : compteurs shardés, batch borné, pagination curseur, cache Redis des résolutions chaudes (flag).
7. Tests de charge : scripts k6 + harnais Node, exécution locale réelle et rapport p95/p99 (résultats locaux, pas de prod).
8. Play : suppression de compte (endpoint + page web + purge), docs conformité (décision paiements, checklist).
9. CI (GitHub Actions) + Dockerfile durci.

**Honnêteté** : les numéros de capacité SIM et les coûts Firestore sont des **modèles
d'hypothèses**, pas des mesures terrain ; la charge testée en local (§7) n'est **pas**
représentative de Render production ; l'adaptateur Socket.IO et le pool multi-appareils
seront **derrière des flags désactivés** tant qu'ils ne sont pas validés sur un vrai
Redis multi-instances et avec le support INfiniReach (multi-device).
