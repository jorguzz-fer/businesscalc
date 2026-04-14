/**
 * Prisma client singleton.
 *
 * Why a singleton:
 *   - Opening a new PrismaClient per request leaks DB connections and
 *     eventually exhausts the pool.
 *   - During `npm run dev` (tsx watch), the module is re-imported on every
 *     file change. Without the `globalThis` cache, each reload would spin
 *     up another PrismaClient and you'd see connection-limit warnings.
 *
 * The cache on `globalThis` is dev-only. In production the module graph is
 * loaded once, so the `if` branch is never taken.
 *
 * Query logging: `error` and `warn` always. In non-production, also log
 * `query` at debug level for troubleshooting N+1s etc. Never log `info` in
 * prod to avoid leaking request shapes.
 */
import { PrismaClient } from '@prisma/client';
import { isProduction } from './config.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction
      ? ['error', 'warn']
      : [
          { emit: 'stdout', level: 'error' },
          { emit: 'stdout', level: 'warn' },
        ],
    errorFormat: 'minimal',
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/**
 * Disconnect helper used by graceful shutdown (src/index.ts).
 * Safe to call multiple times — Prisma handles already-disconnected state.
 */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
