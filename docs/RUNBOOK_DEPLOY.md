# Runbook déploiement — OmniSMS

**Principe** : zéro coupure, toujours reproductible, rollback documenté. Ce runbook décrit ce qui existe **et** ce qui reste à faire ; ne rien présenter de fait qui ne l'est pas.

## 1. Ce qui existe (vérifié)

| Élément | État |
|---|---|
| CI GitHub Actions | `.github/workflows/deploy.yml` : syntaxe JS + audit npm + **suites de tests hors-ligne (bloquantes)** + deploy hook Render + vérif santé |
| Dockerfile | node:20-alpine, `npm ci --omit=dev`, non-root, `HEALTHCHECK /livez` (Render utilise render.yaml, l'image sert Back4App/run local) |
| Arrêt propre | `SIGTERM`/`SIGINT` → `gracefulShutdown` (server.js) : serveurs fermés, sockets déconnectés |
| Sondes | `/livez` (process) · `/readyz` (firebase+redis+bullmq) · `/metrics` (Prometheus, `METRICS_TOKEN`) |
| Validation env | `STRICT_ENV=true` → le boot échoue si une variable requise manque |

## 2. Environnements

| | Staging | Prod |
|---|---|---|
| Render | service séparé `omnisms-staging` | `omnisms-prod` (toujours allumé — plan payant ou cron keep-alive) |
| Secrets | clés de test OM (INfiniReach staging) | clés de prod uniquement |
| Variables | voir docs/RUNBOOK_CREDITS.md + STRICT_ENV | idem + `METRICS_TOKEN` + `REDIS_REQUIRED=true` si ≥2 instances |

⚠️ **Règle scaling** : plusieurs instances ⇒ `REDIS_URL` obligatoire (présence/dédup/queues/limites en mémoire = mono-instance uniquement).

## 3. Déploiement

1. Push `main` → CI verte (tests compris) → deploy hook Render.
2. Vérifier : `/readyz` 200 · `/metrics` accessible · logs sans `[ENV]` erreur.
3. Smoke : envoi réel via l'app de test (ne jamais valider avec le quota prod OM sans le dire).

## 4. Rollback (< 5 min)

- Render → service → **Deployments** → dernier déploiement **vert** → *Redeploy* (le hook CI ne redeployera pas tout seul : rollback manuel stable).
- Si rollback de schéma Firestore : les changements sont additifs (nouvelles collections `gateway_devices`, `counters`, `deletion_requests`, `account_deletions`, `sms_dlq`) — pas de migration destructive à annuler.
- Flags de rétraction rapide : `GATEWAY_POOL_ENABLED=false` (retour mono-appareil), `USER_CACHE_ENABLED=false`, `WORKER_IN_WEB_PROCESS=true` (worker réintégré au web process si le worker séparé est en cause).

## 5. Sauvegardes Firestore (à mettre en place — non fait)

```bash
# Export planifié (Cloud Scheduler quotidien → Cloud Function ou job) :
gcloud firestore export gs://omnisms-backups/$(date +%F) \
  --project=PROJECT_ID
# Restauration :
gcloud firestore import gs://omnisms-backups/YYYY-MM-DD --project=PROJECT_ID
```
Rétention recommandée : 30 jours (les 7 premiers en daily, le reste hebdo). À documenter dans la politique de confidentialité (durée de conservation).

## 6. Non fait / limites

- CI **non exécutée ici** (pas de runner GitHub local) : les commandes du job tests ont été validées localement une par une ; premier push déclenchera la vraie exécution.
- Backups Firestore : commandes fournies, **pas de scheduler configuré** (compte GCP requis).
- Pas de staging actif aujourd'hui (service à créer sur Render).
- Blue/green natif Render = redeploy ; pas d'orchestration k8s (hors besoin actuel).
