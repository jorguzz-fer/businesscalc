/**
 * Application entrypoint.
 *
 * Boot order:
 *   1. Load and validate config (src/config.ts, fails fast if invalid).
 *   2. Build Fastify app with security middleware.
 *   3. Listen on configured PORT.
 *   4. Handle SIGINT/SIGTERM for graceful shutdown.
 */
import { buildServer } from './server.js';
import { config } from './config.js';

async function main(): Promise<void> {
  const app = await buildServer();

  try {
    const address = await app.listen({
      host: '0.0.0.0',
      port: config.PORT,
    });
    app.log.info({ address, env: config.NODE_ENV }, 'server started');
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

void main();
