# ==========================================
# BusinessCalc v2 — Production Dockerfile
# Multi-stage build: minimize final image size and attack surface.
# ==========================================

# ---------- Stage 1: Builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Install build toolchain only — argon2 needs node-gyp + Python at install.
# Alpine keeps the image small; we discard all of this in stage 2.
RUN apk add --no-cache python3 make g++

# Install deps with a deterministic lockfile. We copy ONLY package files first
# so Docker can cache this layer when only source code changes.
COPY package.json package-lock.json* ./
# Use `npm ci` once lockfile is committed. For initial bootstrap without a
# lockfile, fall back to `npm install`.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy prisma schema and generate client (types used at compile time).
COPY prisma ./prisma
RUN npx prisma generate

# Copy source and compile TypeScript -> dist/
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies so stage 2 only copies prod node_modules.
RUN npm prune --omit=dev


# ---------- Stage 2: Runner ----------
FROM node:20-alpine AS runner

# Security: run as non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app
ENV NODE_ENV=production

# Copy only what's strictly required at runtime.
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --chown=app:app public ./public

USER app

EXPOSE 3000

# Run migrations before starting the server. If migrations fail the container
# exits non-zero and the orchestrator (Coolify) marks the deploy as failed —
# no partial state reaches production.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/api/health || exit 1
