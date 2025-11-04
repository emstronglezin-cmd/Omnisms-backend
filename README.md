# Déploiement du Backend OmniSMS sur Back4App

## Prérequis
- Un compte Back4App.
- Les variables d'environnement suivantes configurées dans `.env` :
  - `PARSE_APP_ID`
  - `PARSE_MASTER_KEY`
  - `PARSE_SERVER_URL`
  - `PARSE_DATABASE_URI`

## Étapes de déploiement

1. **Configurer Back4App**
   - Créez une nouvelle application sur Back4App.
   - Notez l'`App ID` et le `Master Key`.

2. **Configurer le projet localement**
   - Clonez ce dépôt :
     ```bash
     git clone <repository-url>
     ```
   - Installez les dépendances :
     ```bash
     npm install
     ```

3. **Déployer sur Back4App**
   - Suivez les instructions de Back4App pour déployer le projet.

4. **Tester le backend**
   - Vérifiez les routes principales :
     - `POST /parse/functions/register`
     - `POST /parse/functions/login`

## Notes
- Ce backend utilise Parse Server pour la gestion des utilisateurs et des données.
- Firebase est utilisé uniquement pour la base de données, l'authentification et le stockage.