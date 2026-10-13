# Checklist publication Google Play — OmniSMS (app utilisateur)

**Périmètre** : uniquement l'**app utilisateur**. L'app passerelle Android (appareils SIM) est distribuée **hors Play Store** (APK direct/MDM) — elle déclare `SEND_SMS`/`READ_SMS`/`READ_CALL_LOG`, interdits sur Play pour cette usage.
**Dernière vérification réglementaire** : 2026-10-13.

## 1. Cible technique

| Exigence | État |
|---|---|
| targetSdk | **API 36 (Android 16) obligatoire** pour nouvelles apps + updates depuis le **31/08/2026** (source : support.google.com, consulté le 13/10/2026). Extension possible jusqu'au 01/11/2026 sur demande. |
| Format | **AAB** + Play App Signing |
| HTTPS | Uniquement (BACKEND_URL https) |
| Secrets | Aucun dans l'APK/AAB (clés admin/côté serveur uniquement) |
| Minification | R8/ProGuard activée, mapping uploadé |
| Crash reporting | Activé |

## 2. Permissions (app utilisateur)

| Permission | Statut |
|---|---|
| SMS / Journal d'appels | **INTERDIT — ne pas déclarer** (0 usage compilé côté utilisateur) |
| Contacts | Justification in-app + divulgation **avant** la demande runtime + refus géré ; stockage par **empreinte (hash)**, jamais en clair |
| Notifications | Runtime Android 13+ (`POST_NOTIFICATIONS`), demande contextuelle |
| Minimum vital | Internet, caméra/mic par feature, rien de plus |

## 3. Compte & données (obligations 2024+)

| Exigence | État |
|---|---|
| Suppression de compte **in-app** | ✅ Livrée — `POST /api/account/delete` (scrub PII + audit `account_deletions` + purge sous 30 j) ; `DELETE /me` historique conservé |
| Suppression **depuis le web** | ✅ Livrée — page publique `/api/account/web` (URL courte `/delete-account` → 302), formulaire sans compte, téléphone **hashé** SHA-256 dans `deletion_requests` |
| Rétention documentée | 30 j entre soft-delete et purge (`ACCOUNT_DELETION_RETENTION_DAYS`), purge admin `POST /api/account/admin/purge-expired` (x-admin-key), audit conservé |
| Politique de confidentialité | ⬜ **À HÉBERGER** — URL publique à déclarer dans Play Console (contenu : données collectées, contacts hashés, rétention 30 j, suppression web+in-app, contact) |
| Form « Données et sécurité » | ⬜ Pré-remplir : collecte (identifiants compte, contacts hashés, journaux techniques), pas de vente de données, chiffrement en transit, suppression disponible |

## 4. UGC / contenu

- [ ] Signalement + blocage in-app (boutons présents ? vérifier l'app)
- [ ] CGU accessibles (URL) + contact abus
- [ ] Classification du contenu : questionnaire Play (messagerie → modération décrite)
- [ ] Public cible : 18+ recommandé (évite les exigences familles)

## 5. Tests pré-soumission (compte perso)

- [ ] **Test fermé obligatoire** : ≥ 20 testeurs pendant 14 jours (nouveau compte perso) — à confirmer dans la console (règles évolutives)
- [ ] Parcours complet : inscription → contacts → message en ligne → SMS externe → recharge web → suppression compte + vérification web
- [ ] Refus de permission contacts = app fonctionnelle

## 6. Bloquants actuels (résumé honnête)

1. Politique de confidentialité non hébergée (URL manquante).
2. Décision paiements non tranchée (voir PAYMENTS_COMPLIANCE.md) — l'app doit sortir **avec `IN_APP_PURCHASE_UI=false`**.
3. Signalement/blocage UGC à vérifier côté app Android (hors dépôt backend).
4. Test fermé 14 jours + données de sécurité à remplir dans la console.
5. AAB cible API 36 à produire (le dépôt actuel est le backend ; la build Android n'est pas dans ce périmètre).

## 7. Références

- Politique suppression de compte : support.google.com/googleplay/android-developer/answer/13348385
- targetSdk : support.google.com/googleplay/android-developer/answer/11926878 (API 36 depuis 31/08/2026)
- Permissions SMS/CallLog : support.google.com/googleplay/android-developer/answer/10208820
