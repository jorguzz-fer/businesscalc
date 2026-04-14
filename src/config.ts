/**
 * Environment configuration.
 *
 * Validates all required env vars with zod at startup. Fail-fast: if anything
 * is missing or malformed, the process exits with a clear error message before
 * handling a single request.
 *
 * Security (vibesec):
 * - SESSION_SECRET: minimum 64 hex chars (32 bytes). Used to sign session cookies.
 * - ENCRYPTION_KEY: minimum 64 hex chars (32 bytes). Reserved for AES-256-GCM
 *   column-level encryption in Phase 3. Not used yet but required so rotation
 *   procedure can be tested early.
 * - No secrets ever leaves this module. Other modules consume the typed `config`
 *   export so they can't accidentally read `process.env` directly.
 */
import { z } from 'zod';
import 'dotenv/config';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    APP_URL: z.string().url(),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    SESSION_SECRET: z
      .string()
      .regex(/^[0-9a-f]+$/i, 'SESSION_SECRET must be hex')
      .min(64, 'SESSION_SECRET must be at least 32 bytes (64 hex chars). Generate with: openssl rand -hex 64'),

    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]+$/i, 'ENCRYPTION_KEY must be hex')
      .min(64, 'ENCRYPTION_KEY must be at least 32 bytes (64 hex chars). Generate with: openssl rand -hex 32'),

    RESEND_API_KEY: z.string().min(1),
    EMAIL_FROM: z.string().min(1),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .strict();

export type AppConfig = z.infer<typeof envSchema>;

function loadConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Fail-fast at boot with a readable message. Never throw the raw ZodError
    // with values (would leak secrets in logs).
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(
      `\n✗ Invalid environment configuration:\n${issues}\n\nCheck your .env file against .env.example.\n`
    );
    process.exit(1);
  }
  return result.data;
}

export const config: AppConfig = loadConfig();

export const isProduction = config.NODE_ENV === 'production';
export const isDevelopment = config.NODE_ENV === 'development';
export const isTest = config.NODE_ENV === 'test';
