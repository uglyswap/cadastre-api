# Build stage
FROM node:20-alpine AS builder

# Force rebuild - timestamp: 2025-12-05T17:00:00Z
ARG CACHEBUST=20251205170000
ARG BUILD_VERSION=v2.0.2-fix-columns

WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./
COPY tsconfig.json ./

# Installer les dépendances
RUN npm install

# Copier le code source - FORCE FRESH COPY
COPY src/ ./src/

# Compiler TypeScript avec logs
RUN echo "=== BUILD ${BUILD_VERSION} ===" && \
    echo "CACHEBUST: ${CACHEBUST}" && \
    npm run build && \
    echo "=== BUILD COMPLETE ===" && \
    echo "Files in dist/services/:" && \
    ls -la dist/services/ && \
    echo "Checking geo-search-postgis.js content (first 50 lines):" && \
    head -50 dist/services/geo-search-postgis.js

# Production stage
FROM node:20-alpine AS production

ARG BUILD_VERSION=v2.0.2-fix-columns
ENV BUILD_VERSION=${BUILD_VERSION}

WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer uniquement les dépendances de production
RUN npm install --omit=dev && npm cache clean --force

# Copier le code compilé depuis le builder
COPY --from=builder /app/dist ./dist

# Créer un utilisateur non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Changer le propriétaire des fichiers
RUN chown -R nodejs:nodejs /app

# Utiliser l'utilisateur non-root
USER nodejs

# Variables d'environnement par défaut
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0

# Exposer le port
EXPOSE 3001

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Démarrer l'application
CMD ["node", "dist/index.js"]
