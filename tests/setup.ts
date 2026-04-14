/**
 * Test setup — runs once before any test file.
 *
 * We inject test-safe env vars BEFORE config.ts is imported so the zod
 * parser passes. Tests that need a real DB use testcontainers (Phase 0.11)
 * and override DATABASE_URL at that level.
 */
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.PORT = '3000';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test?schema=public';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ??
  '0000000000000000000000000000000000000000000000000000000000000000';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  '1111111111111111111111111111111111111111111111111111111111111111';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_test';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'test@localhost';
process.env.LOG_LEVEL = 'fatal';
