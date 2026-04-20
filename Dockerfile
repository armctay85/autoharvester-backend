# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY drizzle.config.ts ./
RUN npm run build

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Drizzle config + schema are needed at runtime for the boot-time
# `drizzle-kit push:pg` invocation that syncs the database schema before the
# app starts. tsx runs the digest cron + stripe setup scripts; drizzle-kit
# is the schema sync tool.
COPY drizzle.config.ts ./
COPY src/db ./src/db
RUN npm install tsx drizzle-kit --omit-optional --no-save

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3001/health || exit 1

CMD ["npm", "run", "start:prod"]
