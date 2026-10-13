# Runbook — Crédits SMS & recharges Orange Money

*Module activé par `CREDITS_ENABLED=true` (Render → Environment). Tant que le
flag est absent/false, aucun comportement existant ne change.*

---

## 1. Modèle (résumé README)

- Messages **en ligne** (OmniSMS↔OmniSMS, Socket.IO) : **gratuits**.
- Messages partant en **SMS** (destinataire externe OU utilisateur OmniSMS hors
  ligne) : consomment d'abord le **quota gratuit** (`FREE_SMS_QUOTA=5`, une
  seule fois par numéro E.164), sinon des **crédits** : **1 crédit = 1 segment**
  (GSM-7 : 160/153 ; UCS-2 : 70/67).
- **Réservation** à l'envoi → **capture** quand la passerelle accepte →
  **remboursement automatique** sur échec, expiration ou `QUOTA_EXCEEDED`.
- Packs configurables (`PACK_10` 10 SMS 250 F, `PACK_30` 30 SMS 600 F ; env ou
  Firestore `app_config/credits`).
- Recharge **uniquement par SMS** (l'utilisateur offline n'a pas internet) :
  `SOLDE`, `PACKS`, `RECHARGE 10|30`, `PAYE <idTransaction>`, `AIDE` à
  envoyer au numéro passerelle.

## 2. Collections

| Collection | Rôle | Écritures |
|---|---|---|
| `credit_balances/{uid}` | solde courant | SDK Admin uniquement (txn) |
| `credit_ledger/{entryId}` | **immuable** : PURCHASE / RESERVATION / CAPTURE / REFUND / FREE_USE / ADMIN_ADJUST | SDK Admin uniquement (create only) |
| `free_sms_quota/{e164}` | quota gratuit consommé par numéro | SDK Admin uniquement |
| `payment_intents/{PI-…}` | intentions RECHARGE (pending→matched/expiré) | SDK Admin uniquement |
| `incoming_payments/{txnIdOM}` | paiements OM détectés (matched/unmatched/review/rejected), **id transaction unique** | SDK Admin uniquement |
| `om_daily_usage/{phone}_{date}` | plafonds journaliers anti-fraude | SDK Admin uniquement |

**Règles Firestore** : déployer `firestore.rules` (refus total des écritures
clients sur ces collections). **Index** : déployer `firestore.indexes.json`.

## 3. Activation (checklist Render)

1. Variables Render : `CREDITS_ENABLED=true` (+ packs/caps si différents des
   défauts), `OM_SENDER_IDS` **à confirmer avec de vrais SMS Orange Money**.
2. Déployer, vérifier `/health`.
3. Vérifier que le webhook INfiniReach est actif et signé
   (`INFINIREACH_WEBHOOK_SECRET` configuré — voir `smsGateway.getStatus()`).
4. Test bout-en-bout avec un **vrai dépôt OM de test** (§6).

## 4. Commandes admin (x-admin-key)

```
GET  /api/admin/credits/payments?status=unmatched    liste par statut (numéros masqués)
POST /api/admin/credits/payments/:txnId/match  {uid} rapprochement manuel (pack au montant exact)
POST /api/admin/credits/payments/:txnId/reject {reason}
POST /api/admin/credits/adjust {uid, delta, reason, reference}  ajustement audité
POST /api/admin/credits/reconcile-expired            rembourse les réservations expirées (crash/oubli)
GET  /api/admin/credits/payments/export.csv          export CSV (rapprochement relevé OM)
GET  /api/admin/credits/ledger/:uid                  audit complet d'un utilisateur
```

## 5. Utilisateur payé mais non crédité (runbook)

1. **Identifier** : `GET /payments?status=unmatched` et `?status=review`
   (ou l'utilisateur fournit l'ID de transaction du SMS Orange Money).
2. **Vérifier dans le CSV/relevé Orange Money** : la transaction existe-t-elle
   (montant, date, payeur) ? Rejouer le webhook n'est pas nécessaire : si le
   SMS OM n'est jamais arrivé sur la passerelle, créditer en manuel.
3. **Cas simples** :
   - paiement `unmatched` au montant d'un pack → `POST /payments/:txnId/match`
     avec l'`uid` du bénéficiaire (idempotent, refuse le double crédit) ;
   - montant hors pack → `POST /adjust` avec `reason` explicite + `reference`
     = idTransaction.
4. **Réservations coincées** (envois bloqués en `pending` alors que la
   passerelle est en erreur prolongée) → `POST /reconcile-expired`.
5. **Contrôles** : le même `txnId` ne peut pas être crédité deux fois (ledger
   id `purch-<txnId>` / `purch-manual-<txnId>`, doublon → HTTP 409).
6. **Clôturer** : informer l'utilisateur par SMS (manuellement ou via
   l'envoi d'un message système), noter l'incident.

## 6. Checklist de validation manuelle (dépôt OM de test réel)

- [ ] `RECHARGE 10` → réponse < 160 chars GSM-7 avec montant 250 F, numéro OM, heure limite, ref `PI-…`
- [ ] Dépôt OM réel du montant exact depuis le téléphone testeur → confirmation reçue sur la passerelle → webhook → `incoming_payments` status `matched` → ledger PURCHASE → SMS « +10 crédits, solde… »
- [ ] Rejouer le même webhook (même `messageId`) → `duplicate`, solde inchangé
- [ ] `SOLDE` → solde à jour ; `PACKS` → liste des packs ; `AIDE` → aide
- [ ] Dépôt par un **tiers** → `unmatched` → `PAYE <id>` par le bénéficiaire → crédité ; 2e `PAYE` → refus
- [ ] Montant hors pack (ex 777 F) → `review` + SMS « en vérification », **aucun** crédit auto
- [ ] 4e `RECHARGE` du jour → refus plafond ; spam de commandes → refus horaire
- [ ] Envoi OmniSMS→externe : consomme le gratuit (x5) puis 1 crédit/segment ; solde insuffisant → message `failed INSUFFICIENT_CREDITS` + 1 SMS d'explication (pas 2)
- [ ] Quota InfiniReach 402 → `failed QUOTA_EXCEEDED` + remboursement (ledger REFUND)
- [ ] Message en ligne OmniSMS→OmniSMS (destinataire en ligne) → **aucun** débit
- [ ] `reconcile-expired` → rembourse uniquement les réservations sans CAPTURE/REFUND

## 7. Limites connues (honnêtes)

- **Formats Orange Money non confirmés** : le parseur repose sur des fixtures
  « À REMPLACER » (`test/fixtures/om-sms.json`). Tester avec de vrais SMS et
  ajuster `OM_REGEX_AMOUNT/TXN/PAYER` ou le code si besoin.
- Le payeur du SMS OM est extrait du texte : si les vrais SMS n'incluent pas
  le numéro du payeur, le rapprochement par « même payeur » ne fonctionnera
  pas → tout passera par `unmatched` + `PAYE` (déjà prévu).
- Limitation des commandes : compteur en mémoire (réinitialisé au redéploiement) ;
  passer sur Redis si nécessaire.
- Les alertes d'anomalie sont des logs structurés (pas d'alerting externe).
- L'atomicité réelle repose sur les transactions Firestore ; les tests
  automatisés utilisent un Firestore mémoire sérialisé (comportement équivalent
  en mono-thread, pas une preuve de concurrence distribuée).
