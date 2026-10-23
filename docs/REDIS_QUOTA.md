# Quota Redis Upstash épuisé — audit, correctifs, évaluation Render Key Value
**Date** : 2026-10-23 · Commits : voir `git log` (local, non poussé).

## 1. Cause précise de la consommation excessive (prouvée, pas supposée)

**Ce n'est pas le trafic. Ce sont les workers BullMQ au repos.**

Mesures faites sur la source installée (`node_modules/bullmq` **5.76.10**) :

| Source de commandes | Fréquence | Par mois (par worker) |
|---|---|---|
| Boucle de fetch bloquant `BZPOPMIN` sur le marker (`drainDelay: 5` défaut) | 1 cmd / 5 s **même sans aucun job** | **≈ 518 400** |
| Vérification « stalled » (`stalledInterval: 30000` défaut) | 1 script / 30 s | ≈ 86 400 |
| **Total par worker à vide** | | **≈ 605 000** |

Le web service Render démarre **2 workers** (`sms` via `smsQueueWorker`, `transcription` via `workers/transcriptionWorker.js` — aucun worker séparé dans `render.yaml`) :

> **≈ 1,21 M commandes/mois à vide** pour un quota Upstash gratuit de **500 000** → quota épuisé en ~2 semaines, sans un seul message réel.

Ensuite, la boucle d'erreurs : chaque commande rejetée par Upstash (`ERR max requests limit exceeded`) redéclenche fetch/erreurs → logs « Worker error », « Unhandled promise rejection », warning ioredis « missing 'error' handler » (connexions dupliquées internes de BullMQ).

**Aucune fonctionnalité spécifique à Upstash n'est utilisée** (ioredis + BullMQ standards, pas d'API HTTP/qStash) — vérifié dans tout le dépôt.

## 2. Correctifs appliqués

| Fichier | Contenu |
|---|---|
| `services/queueService.js` | **Disjoncteur de quota** : détection (`ERR max requests limit exceeded`…) sur les 2 connexions ET les events `error` des workers → `shutdownForQuota()` = arrêt propre des workers (`close()`), déconnexion Redis (**0 commande consommée ensuite**), bascule **inline** des futurs jobs (le SMS part quand même, jamais de faux succès : `queued:false, inline:true` ou `error` explicite) ; **sonde de rétablissement** (1 PING / 10 min, `QUEUE_AUTO_RECOVER`, plancher 60 s) → reconnexion + re-création automatique des workers (specs mémorisées) ; **logs bornés à 1/min par clé** (`logLimited`) ; workers créés avec **`skipStalledCheck: true`** (défaut, économise ~86 k cmd/mois/worker ; `QUEUE_SKIP_STALLED_CHECK=false` pour réactiver) ; `retryStrategy` plafonnés (pas de boucles de reconnexion) ; `getQueueStatus()` expose `mode` (`redis`/`inline-quota`/`inline-forced`/`inline-fallback`), `quotaExhausted` → repris par `/health` |
| `server.js` | `unhandledRejection` journalisé **1/min max** (anti-spam) |
| `workers/smsWorkerProcess.js` | Arrêt propre SIGTERM (`shutdownQueues()`) + rejection handler borné |
| `.env.example` | `QUEUE_MODE`, `QUEUE_AUTO_RECOVER`, `QUEUE_PROBE_INTERVAL_MS`, `QUEUE_SKIP_STALLED_CHECK` documentés |
| `test/redis-quota-tests.js` + `helpers/redis-quota-fakes.js` + `redis-quota-phases.js` | **19 checks** (voir §4) |

**Anti-doublons SMS préservés** : `jobId: sms-{messageId}` (dédup BullMQ) toujours transmis (testé), retries exponentiels ×3 conservés, exécution inline unique par appel, dédup fournisseur intact (suites smsgate/quota-402 vertes). Aucune file ni donnée supprimée.

## 3. Budget commandes après correctif (si Upstash gratuit conservé)

Même avec `skipStalledCheck`, la boucle `BZPOPMIN` (drainDelay 5 s, plafond 10 s dans BullMQ) reste : **518 k/mois/worker à vide**. Conclusion honnête : **le gratuit Upstash ne peut PAS nourrir 2 workers BullMQ 24/7**, quelles que soient les optimisations logicielles. Options gratuites : `QUEUE_MODE=inline` (0 commande, SMS synchrones — transcription devient synchrone, latency risk Groq) ou n'avoir qu'un seul worker (`sms`) = 518 k → toujours >500 k.

## 4. Résultats réels des tests

- `test/redis-quota-tests.js` : **19/19 PASS** — boot redis, dédup `jobId` transmis, backoff exponentiel ×3, `skipStalledCheck`+lock 120 s, erreur quota → `inline-quota` + workers `close()` + 2 déconnexions, retry → **inline (SMS part quand même)**, aucune file ajoutée après quota (pas de tempête), échec honnête sans handler, quota en plein `addJob` → inline, **0 boucle (0 ping, 0 cmd en 400 ms)**, sonde → reprise auto (mode redis restauré, workers re-créés, 1 ping), `QUEUE_MODE=inline` → 0 client Redis.
- Régression : **22/22 suites vertes** (×2 runs consécutifs). Note transparence : 1 échec transitoire de `om-recharge` observé UNE fois à froid (juste après réinstall `node_modules`), non reproduit en 3 exécutions (isolé ×1, boucle complète ×2) — probable échauffement/timing, non lié de façon déterministe aux changements.
- Aucune vraie commande Redis en test (fakes ioredis/bullmq), aucun SMS réel.

## 5. Évaluation Render Key Value (docs vérifiées oct. 2026)

| Critère | Verdict |
|---|---|
| Compatibilité code | ✅ « compatible with virtually all Redis clients » ; ioredis officiellement documenté (`render.com/docs/connecting-to-redis-with-ioredis`) ; `new Redis(REDIS_URL)` tel quel |
| BullMQ (commandes bloquantes) | ✅ protocole Redis réel (moteur Redis/Valkey 8) — BZPOPMIN/lua OK ; **facturation forfaitaire → le polling BullMQ ne coûte rien de plus** |
| URLs | Interne `redis://red-xxx:6379` (même région, sans TLS, sans auth par défaut) ; externe `rediss://…:PASSWORD@host` (TLS obligatoire) — `tlsOptsFor()` gère déjà les deux |
| Persistance jobs | ✅ disque sur plans payants (les SMS en file survivent à un redémarrage) ; **gratuit = 25 MB sans persistance** |
| Coût | **Starter 256 MB = $10/mois** ; 1 GB $20/mois (baisses du 01/10/2026) ; gratuit 25 MB (50 connexions, non persisté) |
| Wiring | `render.yaml` : `fromService: type: keyvalue, property: connectionString` possible |

**Recommandation argumentée** : migrer vers **Render Key Value Starter ($10/mois)** plutôt que rester sur Upstash :
1. **$10 forfaitaires** vs Upstash PAYG ≈ $2/mois (0,20 $/100 k au-delà du gratuit) — le PAYG Upstash est *moins cher* mais imprévisible en cas de spike ; le Fixed Upstash 250 MB vaut aussi $10 sans persistance disque documentée.
2. **Réseau interne même région** : latence réduite, pas d'egress, auth interne optionnelle.
3. **Persistance** des files (jobs SMS) sur plan payant.
4. Alternative gratuite immédiate en attendant la décision : rien à faire — le disjoncteur dégrade proprement (inline) dès que le quota est épuisé.

## 6. Migration Render Key Value — plan réversible (À VALIDER, non exécutée)

1. Render Dashboard → **New → Key Value** (Starter, **même région** que `omnisms-backend`) → persistance activée par défaut.
2. Copier l'**URL interne** `redis://red-…:6379`.
3. Render → service web → `REDIS_URL` = URL interne (sauvegarder l'ancienne valeur Upstash dans `REDIS_URL_UPSTASH_OLD` **à titre de rollback uniquement**).
4. Déployer (bouton Manual Deploy) — les workers se reconnectent au nouvel stockage au boot.
5. **Données** : ne PAS copier les files Upstash (état éphémère). Contexte favorable : le quota actuel est épuisé → la file est de toute façon morte ; basculer maintenant ne perd aucun job. En temps normal : basculer à trafic bas après vidage (`getQueueStatus`).
6. Vérifier : logs `[Queue] BullMQ connecté`, `/health` → `queue.mode: "redis"`, consommation Upstash figée à ~0.
7. **Rollback** : remettre l'ancienne valeur de `REDIS_URL` → redeployer (≤2 min, aucune perte : les jobs créés côté Render KV restent là, traités au retour éventuel).

## 7. Déploiement du correctif actuel (sans migration)

1. Push → deploy auto Render (sur ta validation).
2. Comportement attendu : fonctionnement normal jusqu'à épuisement du quota ; ensuite **dégradation contrôlée** (workers stoppés, SMS inline, `/health` → `queue.mode: "inline-quota"`), plus aucune boucle d'erreurs ni consommation.
3. Variables optionnelles : `QUEUE_MODE=inline` (0 Redis dès le boot), `QUEUE_AUTO_RECOVER=true` (défaut), `QUEUE_PROBE_INTERVAL_MS` (600000), `QUEUE_SKIP_STALLED_CHECK=true` (défaut). **Aucune variable obligatoire à ajouter.**
4. Non testé en production (impossible depuis le sandbox) : le déclenchement réel du quota Upstash et la sonde face au vrai service — couverts par les tests simulés uniquement.
