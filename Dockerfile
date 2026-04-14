# ==========================================
# BusinessCalc v2 — Production Dockerfile
# Multi-stage build: minimize final image size and attack surface.
#
# Base image: node:20-slim (Debian 12 / bookworm-slim).
# We deliberately chose slim over alpine because:
#   - Prisma 5 ships precompiled engines for debian-openssl-3.0.x but has
#     recurring issues on alpine/musl (libssl detection failures,
#     "Could not parse schema engine response" errors).
#   - argon2 native module links cleanly against glibc on Debian.
#   - 60 MB size penalty (180 → 240 MB compressed) is acceptable for the
#     tradeoff in reliability and maintenance cost.
# ==========================================

# ---------- Stage 1: Builder ----------
FROM node:20-slim AS builder

# Force development mode during build regardless of what the orchestrator
# (Coolify/CI) passes as NODE_ENV. We NEED devDependencies (typescript,
# tsx, vitest, prisma CLI) to compile the app. The runner stage below sets
# NODE_ENV=production separately, so the final image still runs in prod mode.
ENV NODE_ENV=development
ENV CI=true

WORKDIR /app

# argon2 needs python/make/g++ to compile its native addon.
# openssl is required by Prisma's schema engine.
# ca-certificates keeps outbound HTTPS (npm registry, etc.) working.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      openssl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install deps with a deterministic lockfile. Package files go first so
# Docker caches this layer when only source code changes.
COPY package.json package-lock.json* ./
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
FROM node:20-slim AS runner

# Install only what runtime needs: openssl for Prisma at runtime, wget for
# HEALTHCHECK (Debian slim doesn't include wget by default).
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl \
      ca-certificates \
      wget \
    && rm -rf /var/lib/apt/lists/*

# Security: run as non-root user
RUN groupadd -r app && useradd -r -g app -s /usr/sbin/nologin app

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

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/api/health || exit 1
