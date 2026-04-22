# Guide de déploiement – OmniSMS Backend

## 🚀 Déploiement sur Render

### Étape 1 – Connecter GitHub

1. Aller sur [render.com](https://render.com)
2. New → Blueprint → Connecter votre repo GitHub
3. Render détecte `render.yaml` automatiquement

### Étape 2 – Configurer les variables d'environnement

Dans le **dashboard Render** → votre service → **Environment** :

#### Variables obligatoires

| Variable | Description | Exemple |
|---|---|---|
| `JWT_SECRET` | Clé secrète JWT | `un_secret_tres_long_aleatoire` |
| `ADMIN_KEY` | Clé protection routes /admin | `cle_admin_secrete` |
| `BACKEND_URL` | URL publique de votre service Render | `https://omnisms-backend.onrender.com` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Contenu JSON du service account Firebase | `{"type":"service_account",...}` |

#### Système 1 – Fusion Link (ancien, à conserver)

| Variable | Description |
|---|---|
| `MONEYFUSION_PAYMENT_LINK` | Lien MoneyFusion créé dans votre dashboard |

#### Système 2 – Fusion Pay API (nouveau)

| Variable | Description |
|---|---|
| `FUSION_PAY_API_URL` | URL API depuis dashboard Money Fusion |
| `FUSION_PAY_API_KEY` | Clé API privée Money Fusion |
| `FUSION_PAY_APP_ID` | `OmniSMS` |

> ⚠️ **IMPORTANT** : Après déploiement, notez l'IP de votre serveur Render  
> et ajoutez-la dans votre dashboard Money Fusion → Settings → IP autorisées.
> Sans cela, Fusion Pay API retournera "Unauthorized IP".

### Étape 3 – Configurer Firebase

1. Aller sur [Firebase Console](https://console.firebase.google.com)
2. Sélectionner votre projet OmniSMS
3. Paramètres du projet → Comptes de service → **Générer une nouvelle clé privée**
4. Copier le contenu du fichier JSON téléchargé
5. Dans Render Dashboard → Environment → `FIREBASE_SERVICE_ACCOUNT_JSON` → coller le JSON (sur une seule ligne)

### Étape 4 – Configurer Money Fusion

#### Pour Fusion Link (ancien système)
1. [pay.moneyfusion.net](https://pay.moneyfusion.net) → créer un lien
2. Montant : 2000 XOF
3. `return_url` : `https://votre-backend.onrender.com/payment-success`
4. Copier le lien → `MONEYFUSION_PAYMENT_LINK`

#### Pour Fusion Pay API (nouveau système)
1. [moneyfusion.net](https://moneyfusion.net) → Settings → Applications
2. Créer une application
3. **Ajouter l'IP du serveur Render** (obtenir via `curl ifconfig.me` depuis Render Shell)
4. Copier l'URL API → `FUSION_PAY_API_URL`
5. Configurer le `webhook_url` → `https://votre-backend.onrender.com/api/payment/fusion-callback`

### Étape 5 – Vérification

```bash
# Health check
curl https://votre-backend.onrender.com/health

# Status des systèmes de paiement
curl https://votre-backend.onrender.com/api/status

# Config Fusion Pay (pour Flutter)
curl https://votre-backend.onrender.com/api/payment/fusion-config

# Test initiation paiement (remplacer USER_ID)
curl -X POST https://votre-backend.onrender.com/api/payment/fusion-pay \
  -H "Content-Type: application/json" \
  -d '{"userId":"test_user_123","montant":2000,"devise":"XOF"}'
```

---

## 📱 Intégration Flutter

### 1. Ajouter les dépendances

Copier le contenu de `flutter/pubspec_additions.yaml` dans votre `pubspec.yaml`.

```bash
flutter pub get
```

### 2. Copier les fichiers Flutter

```
flutter/lib/services/payment_fusion_service.dart → lib/services/
flutter/lib/screens/payment_fusion_screen.dart   → lib/screens/
flutter/lib/widgets/payment_method_selector.dart → lib/widgets/
flutter/lib/widgets/payment_button.dart          → lib/widgets/
```

### 3. Configurer l'URL backend

Dans `payment_fusion_service.dart`, mettre à jour `_backendBaseUrl` :
```dart
static const String _backendBaseUrl = 'https://votre-backend.onrender.com';
```

Ou utiliser une variable de build :
```bash
flutter build apk --dart-define=BACKEND_URL=https://votre-backend.onrender.com
```

### 4. Utiliser le bouton de paiement

```dart
// Option 1 : Bouton complet
PaymentButton(
  onSuccess: () {
    setState(() => _isPremium = true);
    Navigator.pop(context);
  },
  fusionLinkUrl: 'https://pay.moneyfusion.net/votre_lien', // fallback
)

// Option 2 : Bottom sheet avec sélection méthode
ElevatedButton(
  onPressed: () => showPaymentSelector(
    context,
    onSuccess: () => setState(() => _isPremium = true),
    fusionLinkUrl: 'https://pay.moneyfusion.net/votre_lien',
  ),
  child: Text('Acheter Premium'),
)

// Option 3 : Écran dédié
Navigator.push(context,
  MaterialPageRoute(builder: (_) => PaymentFusionScreen(
    onPaymentSuccess: () {
      Navigator.pop(context);
      setState(() => _isPremium = true);
    },
  )),
)
```

### 5. Vérifier l'abonnement au démarrage

```dart
// Dans initState() de votre écran principal
final service = PaymentFusionService();
final uid = FirebaseAuth.instance.currentUser?.uid;
if (uid != null) {
  final subscribed = await service.isUserSubscribed(uid);
  setState(() => _isPremium = subscribed);
}

// Ou écouter Firestore en temps réel
service.listenToSubscription().listen((isSubscribed) {
  setState(() => _isPremium = isSubscribed);
});
```

---

## 🔄 Auto-deploy GitHub → Render

Chaque push sur `main` déclenche un redéploiement automatique.

```bash
git add .
git commit -m "feat: mise à jour"
git push origin main
# → Render redéploie automatiquement
```

Voir les logs : Dashboard Render → votre service → **Logs**

---

## 🏗️ Architecture des deux systèmes

```
Système 1 (CONSERVÉ)          Système 2 (NOUVEAU)
─────────────────────          ──────────────────────
Fusion Link                    Fusion Pay API
    ↓                              ↓
Lien MoneyFusion           POST /api/payment/fusion-pay
    ↓                              ↓
/payment-success           URL paiement Money Fusion
    ↓                              ↓
POST /confirm-payment      WebView Flutter
    ↓                              ↓
Premium activé             POST /api/payment/fusion-callback
(Firestore)                        ↓
                           Firestore mis à jour
                                   ↓
                           Premium activé (Firebase)
```

---

## ⚠️ Points d'attention

1. **Firebase obligatoire** : `FIREBASE_SERVICE_ACCOUNT_JSON` est requise au démarrage. Sans elle, le serveur refuse de démarrer.

2. **IP Render** : L'IP change rarement sur Render Free tier mais peut changer après scaling. Vérifiez régulièrement dans le dashboard Money Fusion.

3. **Idempotence webhook** : Le webhook `/api/payment/fusion-callback` gère les doublons automatiquement (tokenPay unique).

4. **Free tier Render** : Le serveur s'endort après 15min d'inactivité. Premier paiement peut être lent (cold start ~30s). Passer sur `starter` pour la production.

5. **Coexistence** : Les deux systèmes fonctionnent indépendamment. Le système 1 (Fusion Link) peut être désactivé dans `server.js` quand vous êtes prêt.
