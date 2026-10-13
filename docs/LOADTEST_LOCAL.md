# Rapport de test de charge — local (sandbox)

**Date** : 2026-10-13 · **Environnement** : sandbox de dev (CPU partagé, 1 vCPU effectif), Node `server.js` réel avec stubs (Firebase en mémoire, Redis absent → mémoire, INfiniReach non configuré). **Générateur** : `loadtest/node-runner.js` (1 process Node sur la même machine) + scénario k6 fourni pour staging (`loadtest/k6-omnisms.js`).

> ⚠️ Périmètre de confiance : ce sont des mesures **locales réelles** du process Node complet (Express + middlewares + Socket.IO + routage), pas d'un déploiement Render/staging. Un seul générateur sur la même machine = plafond de mesure, chiffres à retenter en staging.

## 1. Découverte importante : le « mur » de 5 s était nos propres défenses

Première passe (avant knobs) : au-delà de **~140 req/15 min/IP**, toute requête (même `/livez`) prenait **~5 s de mur, uniformément**. Cause identifiée, **pas un bug** :

- `globalSlowDown` (middleware/security.js) : délai croissant `+200 ms/hit` après **150 req/15 min/IP**, plafonné à **5000 ms** → le mur de 5 s observé ;
- `globalLimiter` : **300 req/15 min/IP** → 429 au-delà (masqué car le runner ne comptait que les 5xx).

Conséquence produit : un utilisateur ou un NAT d'entreprise partageant une IP ne sentira rien (150 req/15 min), et une attaque par flood mono-IP est effectivement ralentie puis bloquée. **Comportement conservé** — ajout de knobs pour les tests de charge/staging uniquement (`GLOBAL_RATE_LIMIT_MAX`, `GLOBAL_SLOWDOWN_DELAY_AFTER`, `GLOBAL_SLOWDOWN_MAX_DELAY`), défauts identiques aux valeurs historiques.

Référence brut (chaîne complète, sans le slowDown sur /health) : **200 requêtes `/health` concurrentes = 0,19 s mur** (~1000 req/s localement), requête unique `/api/messages/send` = **3 ms**.

## 2. Charge nominale (knobs relâchés — résultats réels)

| Scénario | Charge | Résultat |
|---|---|---|
| Sockets Socket.IO (auth JWT) | 200 clients, websocket | **200/200 connectés en 0,7 s** — p50 450 ms, p95 650 ms, p99 667 ms |
| Envois `POST /api/messages/send` | 400 req concurrentes | **385 req/s**, 0 × 5xx, 400 × 201 — p50 546 ms, p95 968 ms, p99 1005 ms |
| Rafale webhooks passerelle | 800 req concurrentes | **682 req/s**, 0 × 5xx — p50 515 ms, p95 818 ms, p99 1112 ms |

## 3. Point de rupture (palier suivant)

| Scénario | Charge | Résultat |
|---|---|---|
| Sockets | 400 clients | **400/400 en 1,5 s** — p95 1325 ms |
| Envois | 1500 req | **400 req/s** (palier), 0 × 5xx — p50 2,15 s, p95 3,5 s, p99 3,6 s |
| Webhooks | 3000 req | **862 req/s** (palier), 0 × 5xx — p50 1,7 s, p95 3,3 s |

Lecture : le débit **plafonne à ~400 envois/s et ~860 webhooks/s** (générateur et serveur partagent le même CPU) ; la latence se dégrade **gracieusement** (files qui s'allongent, zéro erreur, pas d'effondrement). Le goulot mesuré ici est le CPU unique partagé — en production mono-instance Render, l'ordre de grandeur reste « quelques centaines de req/s par instance », très au-dessus du besoin réel (les envois sont de toute façon plafonnés par les passerelles physiques : 2–4 appareils ≈ 1–6k SMS/jour).

## 4. Non testé / limites

- **Pas de Redis** dans cette mesure : présence/dédup/queues en mémoire (`queue_mode_inline=1` confirmé dans `/metrics`). Le comportement multi-instances nécessite Redis → à mesurer en staging.
- **Firestore = stub mémoire** : les lectures/écritures réelles (latence réseau, quota, docs chauds) ne sont pas représentées ; le point Firestore reste une estimation (docs/SCALING.md §5), pas une mesure.
- **Un seul process générateur** : les p50/p95 côté client incluent la contention du générateur lui-même ; à refaire avec k6 multi-VU contre staging.
- Pas de test de montée mémoire longue durée (fuite éventuelle) ni de bascule worker séparé sous charge.
