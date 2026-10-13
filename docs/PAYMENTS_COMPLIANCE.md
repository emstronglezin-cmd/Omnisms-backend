# Conformité paiements — OmniSMS (Google Play)

**Statut de référence** : achat in-app **désactivé** par défaut (`IN_APP_PURCHASE_UI=false`) tant que Play Billing n'est pas tranché. **Décision à prendre avant toute publication avec achat actif.**

## 1. Le problème

Les crédits SMS OmniSMS sont un **service numérique consommé dans l'app**. La politique Paiements de Google Play impose **Google Play Billing** pour les biens/services numériques utilisés dans l'app. Le paiement Orange Money via passerelle SMS (web) n'est pas autorisé comme moyen de paiement in-app pour ce type de bien, sauf qualification en service physique — ce qui n'est pas notre cas.

## 2. Position retenue (livrée)

| Élément | État |
|---|---|
| UI d'achat dans l'app | **Désactivée** (`IN_APP_PURCHASE_UI=false`, défaut dans le code) |
| Recharges Orange Money | **Via le portail web uniquement** (hors app) — les webhooks/réconciliation OM restent actifs côté serveur |
| Affichage solde dans l'app | Autorisé (lecture seule) |
| Liens vers le portail web depuis l'app | Autorisé tant qu'**aucun bouton d'achat** n'apparaît dans l'app |

## 3. Deux issues de sortie

1. **Rester sans IAP** : l'app ne propose aucun achat ; l'utilisateur recharge sur le web. Zéro frais Play (15/30 % évités). Contrainte : ne jamais réactiver l'UI d'achat dans l'app sans Play Billing.
2. **Adopter Play Billing** : trancher la tarification (frais 15 % < 1 M$/an), implémenter Billing Library, mapper les produits (packs de crédits), gérer ack/expire/refund → nouveau chantier backend (`payment_intents` fournisseur `google_play`, validation RTDN). Ne pas commencer sans décision produit.

## 4. Contraintes déjà en place (à ne pas casser)

- `IN_APP_PURCHASE_UI=false` par défaut ; les règles Firestore interdisent les écritures client sur soldes/ledger/paiements.
- Idempotence ledger par messageId ; `incoming_payments` uniques par txnId ; solde jamais négatif ; formats OM jamais inventés (fixtures « À REMPLIR »).
- Webhooks OM signés/anti-rejeu côté passerelle (l'app passerelle est **hors** Play Store — distribuée séparément, voir PLAY_STORE_CHECKLIST.md).

## 5. Checklist avant toute activation d'achat

- [ ] Décision produit Play Billing vs web-only consignée
- [ ] Si Play Billing : produits créés dans Play Console, Billing Library ≥ dernière exigée, tests licence, RTDN validés en staging
- [ ] Déclarations financières Play Console à jour
- [ ] `IN_APP_PURCHASE_UI` réactivé UNIQUEMENT après QA complète des deux chemins (Play + OM)
