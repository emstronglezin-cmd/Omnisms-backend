# Stabilisation & préparation au lancement — rapport de mission
**Date** : 2026-11-06 · Commit : `68430e0` (local, **non poussé** — aucune validation de déploiement reçue) · Base : audit `docs/AUDIT_FINALISATION.md` (2026-11-05).
**Conformité** : aucun SMS réel, aucune dépense, aucune variable de production modifiée, aucun redéploiement ; secrets masqués partout.

---

## 1. Rapport d'audit initial
Voir `docs/AUDIT_FINALISATION.md` (complet, mêmes jour). **Re-vérification au 2026-11-06** : uptime 13,7 j (aucun redémarrage), `queue.mode: "inline-quota"` (quota Upstash toujours épuisé), `smsProvider: ACTIVE` (INfiniReach), git `090fac5`→`68430e0` local propre. **Découverte supplémentaire de cette mission** : le mode strict du webhook (`INFINIREACH_REQUIRE_SIGNATURE=true`) était **ignoré** quand le secret était absent (log d'erreur… puis acceptation !) — corrigé (§3).

## 2. Causes exactes des incidents
| Incident | Cause racine (vérifiée dans le code/prod) | État |
|---|---|---|
| Files BullMQ arrêtées | Quota commandes Upstash (500 k/mois) épuisé par le polling idle des workers (≈605 k/mois/worker, voir docs/REDIS_QUOTA.md) | Contourné par disjoncteur (inline dégradé) ; résolution définitive = plan §5 |
| Webhook entrant potentiellement falsifiable | Secret `INFINIREACH_WEBHOOK_SECRET` absent (état inconnu côté Render) + **bug** : le mode strict exigé par variable était sans effet | **Corrigé** (fail-closed) ; la variable reste à poser par le propriétaire |
| Avatars `/uploads` relatifs sur l'APK | `BACKEND_URL` manquant en prod (vu via /api/diag) | **Corrigé** (fallback RENDER_EXTERNAL_URL + URL canonique) ; la variable reste recommandée |
| Pas de preuve SMS réels | Métriques SMS vides + aucun test documenté | Protocol de validation §6 |
| Aucun paiement validé | Intégration codée (suites offline vertes) mais jamais testée en réel | Test contrôlé requis (§8) |

## 3. Fichiers backend modifiés (mission stabilisation)
| Fichier | Changement |
|---|---|
| `services/smsGateway.js` | `validateWebhookSignature` : `INFINIREACH_REQUIRE_SIGNATURE=true` + secret absent → **rejet** (fail-closed, c'était le bug). Compat : défaut permissif conservé pour la première installation |
| `server.js` | `GET /api/diag` : exige `x-admin-key` **si `ADMIN_KEY` est configurée** (sinon comportement historique — zéro rupture). `/metrics` : gate `METRICS_TOKEN` déjà existant (aucun code nécessaire) |
| `services/profileSerializer.js` | Absolutisation : `BACKEND_URL` → `RENDER_EXTERNAL_URL` (auto fourni par Render) → URL canonique (convention existante des contrôleurs paiement). Les avatars relatifs s'afficheront sur l'APK **même sans nouvelle variable** |
| `services/queueService.js` | `QUEUE_DRAIN_DELAY_MS` (plafonné 5–10 s, plafond BullMQ) : divise par 2 la consommation idle par worker (≈259 k cmd/mois à 10 s) |
| `services/smsQueueWorker.js` | Flag `QUEUE_SMS_WORKER=false` → worker SMS désactivé (jobs inline) |
| `workers/transcriptionWorker.js` | Flag `QUEUE_TRANSCRIPTION_WORKER=false` → worker transcription désactivé (jobs inline) |
| `test/stabilisation-tests.js` + `test/stabilisation-phases.js` | **17 checks** (§4) |

## 4. Résultats des tests (exacts)
- `test/stabilisation-tests.js` : **17/17 PASS** — webhook : permissif sans secret (compat) / **strict sans secret → rejeté (corrigé)** / HMAC valide accepté / HMAC invalide rejeté / sig manquante+secret permissif par défaut (documenté) / sig manquante+secret+strict rejeté ; `QUEUE_DRAIN_DELAY_MS=10` → drainDelay 10, défaut inchangé sans env ; `/api/diag` 401/401/200 avec ADMIN_KEY, 200 sans (compat) ; `QUEUE_SMS_WORKER=false` → 0 worker, défaut → 1 ; `QUEUE_TRANSCRIPTION_WORKER=false` → null/0 ; fallback URLs photos (canonique sans env, BACKEND_URL prioritaire).
- **Régression : 23/23 suites vertes** (routing, présence, offline-hold, quota-402, crédits, om-recharge, OTP, OAuth, SMSGate, redis-quota 19, photos 19, …).
- **Non testé (impossible ici, cf. §8)** : SMS réels, paiement réel, webhook d'une vraie app INfiniReach, iOS.

## 5. Plan de migration Redis (PRÊT, NON EXÉCUTÉ — validation propriétaire requise)
**Options comparées** (docs vérifiées oct. 2026) :
| Option | Coût | Avantages | Inconvénients |
|---|---|---|---|
| **A. Render Key Value Starter** (recommandé) | $10/mois | Réseau interne même région (latence, pas d'egress), persistance disque des files, **facturation forfaitaire** (polling BullMQ non facturé), ioredis documenté officiellement | Nouveau service à créer (10 min) |
| B. Upstash Fixed 250 MB | $10/mois | Aucun changement d'URL si même base | Pas de persistance disque documentée, réseau externe TLS |
| C. Upstash PAYG | ~$2/mois à notre volume | Moins cher | Facturation à la commande (spike = surprise), réseau externe |
| D. Gratuit + flags (cette mission) | 0 $ | `QUEUE_SMS_WORKER=false` + `QUEUE_DRAIN_DELAY_MS=10` + skipStalledCheck ≈ **259 k cmd/mois → tient dans les 500 k gratuits** avec UN seul worker ; transcription en inline (rare) | Transcription synchrone ; 2 workers restent hors budget gratuit |

**Procédure A** (reversible, cf. docs/REDIS_QUOTA.md §6) : créer l'instance même région → `REDIS_URL` = URL interne → deploy → vérifier `/health` `queue.mode:"redis"` → rollback = remettre l'ancienne URL. Aucune copie de données (files actuelles vides/mortes par le quota).

## 6. Validation SMS — chemin exact + protocole de test contrôlé
**Chemin sortant** : routeur → (file `sms` si Redis OK, sinon inline) → INfiniReach API (`INFINIREACH_API_KEY`) → app Android du téléphone-passerelle → SIM → opérateur → destinataire. **Chemin entrant** : SMS reçu sur la SIM → app → `POST /sms/gateway/inbound` (HMAC si secret) → routage conversation/crédits. **Interne** : jamais de SMS (offline-hold par défaut). **iOS** : aucune app iOS ne peut envoyer/lire des SMS programmatiquement — l'iPhone ne peut pas servir de passerelle ; dépendance totale à la passerelle Android (ou futur fournisseur externe) pour l'externe.

**Test réel protocole (à autoriser explicitement par le propriétaire — RIEN envoyé à ce jour)** :
1. **Numéro** : un seul numéro de test fourni ET consentant (le vôtre), en E.164.
2. **Coût estimé** : 1–3 SMS (forfait SIM du téléphone passerelle) ; **plafond : 5 SMS** par session de test.
3. **Pré-vérifications** : `/health` `sms_gateway configured:true` ; téléphone allumé, crédit SIM > 0, app INfiniReach connectée ; `queue.mode` (redis attendu, inline acceptable) ; `ADMIN_KEY` configurée.
4. **Déroulé** : `POST /api/diag/sms-test` (x-admin-key, `{"to":"+226…"}`) → 1 SMS attendu sur le téléphone test ; puis réponse au numéro passerelle → vérifier l'entrant dans les logs (`[InfiniReach Webhook]`) et la conversation.
5. **Confirmation de livraison** : réception physique sur le téléphone test + statut dans la réponse/logs + métrique `omnisms_sms_*`.
6. **Arrêt d'urgence** : `OFFLINE_SMS_PROVIDER=` (vider) + redeploy/`INFINIREACH_API_KEY` vidée → plus aucun envoi possible ; en cas de doublons observés : couper, récupérer les messageId, vérifier le ledger avant toute reprise.
7. **Interdits** : pas d'envoi de masse, pas de numéro tiers, pas de boucle de retry manuelle.

## 7. Checklist de déploiement & retour arrière
**Pré-requis propriétaire (dashboard Render, aucune action de ma part)** : `INFINIREACH_WEBHOOK_SECRET` (fort, + même secret côté app) + `INFINIREACH_REQUIRE_SIGNATURE=true` après config ; `ADMIN_KEY` (protège /api/diag) ; `METRICS_TOKEN` (protège /metrics) ; `BACKEND_URL` (recommandé, fallback en place) ; option gratuit : `QUEUE_SMS_WORKER=false`, `QUEUE_DRAIN_DELAY_MS=10` ; option A : Render KV + `REDIS_URL`.
**Déploiement** : push sur validation → CI (#74 attendu verte) → deploy auto → vérifier : `/health` (sms ACTIVE, queue mode attendu), webhook signé accepté / non signé **rejeté 401**, `/api/diag` 401 sans clé, avatar `/uploads` absolutisé.
**Retour arrière** : revert commit `68430e0` + push (≤5 min) ; ou neutraliser par variables (désactiver strict, etc.). Aucune migration de données impliquée.

## 8. Blocages restants AVANT lancement
1. 🔴 **Décision Redis** : option D gratuite (flags, un seul worker) ou option A ($10) — sans cela, files dégradées permanentes.
2. 🔴 **Webhook** : configurer le secret + activer le strict (le code est prêt, la variable manque).
3. 🟠 **Test SMS réel documenté** (protocole §6) — jamais fait à ce jour.
4. 🟠 **Test paiement réel minimal** (SAASPAY/LeekPay) — jamais fait.
5. 🟠 `npm audit fix` (25 vulnérabilités dont 3 critiques) — à planifier avec régression.
6. 🟡 Vars `ADMIN_KEY`/`METRICS_TOKEN`/`BACKEND_URL` à poser ; OTP activé ou non (décision produit) ; app iOS (rien côté backend ne peut la remplacer).

**Non prétendu** : aucun SMS réel envoyé, aucun paiement réel validé, aucune livraison confirmée — tout ce qui est affirmé fonctionne l'est par tests automatisés (23/23) et vérification de prod en lecture seule.
