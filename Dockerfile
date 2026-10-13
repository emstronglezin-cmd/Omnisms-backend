# OmniSMS Backend — image de production
# Note : Render utilise render.yaml (environnement natif) ; cette image sert
# aux déploiements conteneurisés (Back4App, autre registre, run local).

FROM node:20-alpine

# curl pour le HEALTHCHECK
RUN apk add --no-cache curl

WORKDIR /app

# Dépendances reproductibles (lockfile)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Code (node_modules local exclu via .dockerignore)
COPY . .

ENV NODE_ENV=production
EXPOSE 5000

# Sanity check applicatif (/livez = liveness, sans dépendances externes)
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-5000}/livez" || exit 1

# Non-root
USER node

CMD ["npm", "start"]
