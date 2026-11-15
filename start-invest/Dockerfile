# ---- Dépendances ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---- Build ----
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL="file:./dev.db"
RUN npx prisma generate
RUN AUTH_SECRET="build-time-placeholder" npm run build
# Prépare une base SQLite pré-initialisée (schéma + sociétés du groupe + compte fondateur)
RUN npx prisma db push --skip-generate
RUN npx prisma db seed

# ---- Image finale ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.claude/agents ./.claude/agents
COPY --from=builder /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder /app/prisma/dev.db ./prisma/seed.db
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Outil Prisma (installé à part) pour mettre à jour la base au démarrage d'une nouvelle version
COPY package.json /tmp/package.json
RUN mkdir -p /opt/prisma-cli && cd /opt/prisma-cli \
 && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund "prisma@$(node -p "require('/tmp/package.json').dependencies.prisma")" \
 && rm /tmp/package.json && npm cache clean --force
# Navigateur Chromium (invisible) pour le robot de connexion aux logiciels sans API (Auto Cerfa...)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core
RUN node ./node_modules/playwright-core/cli.js install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY docker-entrypoint.sh ./docker-entrypoint.sh
# Le démarrage prépare le volume (en root) puis lance l'application avec l'utilisateur « node »
# sans privilèges (voir docker-entrypoint.sh).
RUN chmod +x ./docker-entrypoint.sh && mkdir -p /app/data && chown -R node:node /app

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
