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
# tsx needed at runtime ONLY for digest cron + stripe setup; keep slim by
# allowing both the prod boot (`node dist/index.js`) and `tsx`-based scripts
# (`npm run digest:run`, `npm run stripe:setup`) to work.
RUN npm install tsx --omit-optional --no-save

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3001/health || exit 1

CMD ["npm", "run", "start"]
