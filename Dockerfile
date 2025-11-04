# Utiliser une image Node.js stable
FROM node:18

# Définir le dossier de travail
WORKDIR /user/src/app

# Copier les fichiers des dépendances
COPY package*.json ./

# Installer les dépendances
RUN npm install

# Copier tout le code du backend dans le conteneur
COPY . .

# Exporter le port par défaut pour Back4App
EXPOSE 1337

# Lancer l'application
CMD ["npm", "start"]