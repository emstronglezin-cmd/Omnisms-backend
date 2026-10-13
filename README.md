# OmniSMS Backend v2.0

Système de paiement hybride **Online + Offline** — Sans API externe.

---

## 🏗️ Architecture

```
OmniSMS Backend v2.0
│
├── 🌐 PAIEMENT ONLINE (MoneyFusion lien direct)
│   ├── GET  /payment-success    → Page HTML de validation
│   ├── POST /confirm-payment    → Activation premium (anti-fraude)
│   └── GET  /moneyfusion-link   → Lien MoneyFusion
│
├── 📱 PAIEMENT OFFLINE (SMS)
│   ├── POST /sms/incoming       → Webhook SMS universel
│   ├── POST /sms/test           → Test manuel (dev)
│   └── GET  /sms/commands       → Documentation commandes
│
├── 👑 ADMIN (protégé par x-admin-key)
│   ├── GET  /admin/stats
│   ├── GET  /admin/users
│   ├── GET  /admin/logs
│   └── POST /admin/user/:phone/activate-premium
│
└── 🔒 ANTI-FRAUDE
    ├── Rate limit IP (3 req / 30s sur confirm-payment)
    ├── Cooldown phone (30s entre confirmations)
    ├── Blocage double activation premium
    └── Logs structurés { phone, ip, date, action }
```

---

## 🚀 Démarrage rapide

```bash
# 1. Copier et configurer l'environnement
cp .env.example .env
# → Éditer MONEYFUSION_PAYMENT_LINK et BACKEND_URL

# 2. Installer les dépendances
npm install

# 3. Démarrer
npm start        # production
npm run dev      # développement (nodemon)
```

---

## 💳 Configuration MoneyFusion

1. Connectez-vous sur [pay.moneyfusion.net](https://pay.moneyfusion.net)
2. Créez un lien de paiement :
   - **Montant** : 2000 XOF
   - **Description** : OmniSMS Premium
   - **return_url** : `https://votre-backend.com/payment-success`
3. Copiez le lien dans `MONEYFUSION_PAYMENT_LINK` dans `.env`

**Aucune API MoneyFusion, aucune clé secrète côté backend.**

---

## 📱 Commandes SMS Offline

| Commande | Action |
|---|---|
| `RECHARGE 150` | Instructions pour recharger 150F → +150 crédits |
| `RECHARGE 500` | Instructions pour recharger 500F → +600 crédits |
| `RECHARGE 1000` | Instructions pour recharger 1000F → +1300 crédits |
| `CONFIRM 150` | Valider une recharge de 150F |
| `CONFIRM 500` | Valider une recharge de 500F |
| `CONFIRM 1000` | Valider une recharge de 1000F |
| `PREMIUM` | Instructions paiement Premium (2000F) |
| `CONFIRM PREMIUM` | Activer le compte Premium |
| `SOLDE` | Voir son solde de crédits |
| `AIDE` | Afficher l'aide |

**Numéro de paiement manuel** : `+22675405214`

---

## 🔌 Webhooks SMS

Le endpoint `POST /sms/incoming` est **universel** :

| Provider | Format auto-détecté |
|---|---|
| Africa's Talking | `{ from, text }` |
| Twilio | `{ From, Body }` (URLencoded) → répond TwiML |
| Orange | `{ sender, content }` |
| Test/Generic | `{ phone, message }` |

---

## 🧪 Tests en développement

```bash
# Tester une commande SMS
curl -X POST http://localhost:5000/sms/test \
  -H "Content-Type: application/json" \
  -d '{ "phone": "+22670000000", "message": "RECHARGE 500" }'

# Tester la confirmation premium online
curl -X POST http://localhost:5000/confirm-payment \
  -H "Content-Type: application/json" \
  -d '{ "phone": "+22670000000" }'

# Stats admin
curl http://localhost:5000/admin/stats \
  -H "x-admin-key: your_admin_key"
```

---

## 🏗️ Structure des fichiers

```
├── server.js                    # Point d'entrée principal (refactorisé)
├── config/
│   └── db.js                    # Store en mémoire (remplacer par MongoDB en prod)
├── routes/
│   ├── payment.online.js        # GET /payment-success + POST /confirm-payment
│   ├── sms.webhook.js           # POST /sms/incoming + /sms/test
│   ├── admin.js                 # Routes admin protégées
│   ├── subscriptions.js         # Plans et statuts
│   └── ...                      # Autres routes conservées
├── services/
│   ├── smsHandler.js            # Logique commandes SMS offline
│   ├── creditSystem.js          # Barème crédits (150/500/1000F)
│   ├── antifraud.js             # Rate limit + logs anti-fraude
│   ├── paymentService.js        # Orchestrateur paiement
│   └── moneyfusion.js           # Config lien MoneyFusion (pas d'API)
└── .env.example                 # Variables d'environnement
```

---

## 🔒 Anti-Fraude

| Protection | Détail |
|---|---|
| Rate limit global | 100 req / 15 min par IP |
| Rate limit paiement | 5 req / 5 min par IP sur `/confirm-payment` |
| Rate limit applicatif | 3 tentatives / 30s par IP |
| Cooldown téléphone | 30s entre deux confirmations |
| Double activation | Blocage si déjà Premium |
| Logs structurés | `{ phone, ip, action, status, date }` |

---

## 📦 Structure utilisateur

```json
{
  "phone": "+22670000000",
  "credits": 0,
  "premium": false,
  "createdAt": "2026-04-05T00:00:00.000Z",
  "lastPaymentAt": null,
  "premiumActivatedAt": null,
  "activationIp": null,
  "activationChannel": null
}
```

---

## ✅ Ce qui a été supprimé

- ❌ MoneyFusion API (init, callback, webhook)
- ❌ PayDunya (tous les appels)
- ❌ Axios pour les paiements
- ❌ Logique OTP / sessions de paiement
- ❌ Routes `/payments/*` (ancienne logique)
- ❌ `/offline-payment` (ancienne logique avec étapes)

---

## 🚀 Prêt pour production

- [x] Pas d'API externe requise
- [x] Compatible MoneyFusion (lien uniquement)
- [x] Logique offline 100% SMS
- [x] Anti-fraude intégré
- [x] Logs structurés
- [x] Health check `/health`
- [x] Arrêt propre (SIGTERM)

---

## 💳 Modèle de crédits SMS & recharges Orange Money (v4.4)

**Activé par `CREDITS_ENABLED=true`** (défaut : false → comportement historique).

- Messages **en ligne** (OmniSMS ↔ OmniSMS) : **gratuits**.
- Messages partant en **SMS** (destinataire externe ou utilisateur OmniSMS hors ligne) :
  **5 SMS gratuits** par numéro E.164 (`FREE_SMS_QUOTA`, une seule fois, consommés en premier),
  puis des **crédits** : **1 crédit = 1 segment** (GSM-7 : 160/153, UCS-2 : 70/67).
- **Ledger immuable** (`credit_ledger`) + soldes (`credit_balances`) mis à jour en
  transaction Firestore : réservation à l'envoi, capture quand la passerelle accepte,
  **remboursement automatique** sur échec / expiration / quota 402. Solde jamais négatif,
  idempotent par `messageId` (jamais de double débit ni de double crédit).
- **Recharge par SMS uniquement** (utilisateurs offline, sans internet) :
  `SOLDE` · `PACKS` · `RECHARGE 10|30` · `PAYE <idTransaction>` · `AIDE`.
  Packs configurables (`PACK_10` = 10 SMS / 250 F, `PACK_30` = 30 SMS / 600 F ; env ou
  Firestore `app_config/credits`). Confirmation Orange Money reçue sur la passerelle,
  parseur à liste blanche (`OM_SENDER_IDS`), rapprochement automatique
  (`incoming_payments`, id transaction unique) + `PAYE` pour les dépôts faits par un tiers.
- **Anti-fraude** : plafonds journaliers par numéro (recharges / FCFA), limite horaire
  de commandes, réponses 1 segment limitées, webhook signé (HMAC + secret), règles
  Firestore interdisant toute écriture client sur soldes/ledger/paiements.
- **Conformité Google Play** : `IN_APP_PURCHASE_UI=false` — aucune UI d'achat dans l'app
  tant que la conformité n'est pas validée ; le canal de recharge reste le SMS.
- Docs : `docs/RUNBOOK_CREDITS.md` (runbook « payé mais non crédité », checklist de
  validation) · `firestore.rules` · `firestore.indexes.json`.
