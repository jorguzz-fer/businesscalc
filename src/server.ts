/**
 * Fastify server factory.
 *
 * Security plugins applied here as baseline (vibesec-aligned):
 *   - @fastify/helmet: strict CSP, HSTS, X-Frame-Options, X-Content-Type-Options
 *   - @fastify/cookie: parse + sign cookies with SESSION_SECRET
 *   - @fastify/rate-limit: global throttling (per-route limits overridden later)
 *   - @fastify/csrf-protection: double-submit cookie pattern (activated in Task 0.7)
 *
 * Routes are NOT registered here. Each route module calls `registerRoutes(app)`
 * so the server stays a thin composition root.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isDevelopment, isTest } from './config.js';
import { authRoutes } from './routes/auth.routes.js';
import { periodRoutes } from './routes/period.routes.js';
import { entryRoutes } from './routes/entry.routes.js';
import { metaRoutes } from './routes/meta.routes.js';

// When bundled to dist/server.js, __dirname would be dist/. We resolve
// the public/ folder relative to the project root (one level up from
// dist). In ESM we compute this from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/server.ts at dev time OR dist/server.js at runtime — both one level
// below the project root, so ../public works in both cases.
const PUBLIC_DIR = path.resolve(__dirname, '../public');

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isTest
      ? false
      : {
          level: config.LOG_LEVEL,
          transport: isDevelopment
            ? {
                target: 'pino-pretty',
                options: {
                  translateTime: 'HH:MM:ss Z',
                  ignore: 'pid,hostname',
                },
              }
            : undefined,
          // Never log Authorization header, Cookie, or password fields.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.newPassword',
              'req.body.token',
              'res.headers["set-cookie"]',
            ],
            censor: '[REDACTED]',
          },
        },
    trustProxy: true, // Coolify/Traefik is in front; trust X-Forwarded-* headers
    bodyLimit: 1024 * 1024, // 1 MB default; multipart endpoints override to 10 MB
    disableRequestLogging: false,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: false,
        useDefaults: true,
      },
    },
  });

  // ---- Security Headers (Helmet) ----
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline' on scriptSrc: pragmatic MVP compromise. All
        // inline <script> blocks on our pages are first-party (no
        // templated user content is ever injected into a script context),
        // and we have defense-in-depth via:
        //   - zod strict() on every request body (no mass assignment)
        //   - textContent (not innerHTML) for all user-supplied data
        //   - SameSite=Strict cookies + CSRF tokens
        //   - httpOnly session cookie (not stealable via XSS either way)
        // Phase 3 TODO: extract inline scripts to external files and
        // adopt CSP nonces (or hashes) to restore script-src strictness.
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        scriptSrcAttr: ["'unsafe-inline'"], // for onclick/onchange handlers in app.html
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Browsers deprecated X-Frame-Options in favor of CSP frame-ancestors above,
    // but helmet still sets it as defense-in-depth.
  });

  // ---- Cookie parsing (required by CSRF plugin) ----
  await app.register(cookie, {
    secret: config.SESSION_SECRET,
    parseOptions: {
      httpOnly: true,
      secure: !isDevelopment,
      sameSite: 'strict',
      path: '/',
    },
  });

  // ---- Form body parsing (for HTML forms posting application/x-www-form-urlencoded) ----
  await app.register(formbody);

  // ---- Global rate limit (per-IP) ----
  // Per-route limits in auth.routes.ts will override with stricter thresholds.
  // Disabled in test mode — supertest always hits the same IP so throttling
  // fires almost immediately and poisons the suite. We cover the limit
  // itself in a dedicated test that deliberately hammers the endpoint.
  if (!isTest) {
    await app.register(rateLimit, {
      global: true,
      max: 100,
      timeWindow: '1 minute',
      hook: 'onRequest',
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Muitas requisições. Tente novamente em ${Math.ceil(
          context.ttl / 1000,
        )} segundos.`,
      }),
    });
  }

  // CSRF enforcement: not a Fastify plugin. We implement the double-submit
  // cookie pattern ourselves in middleware/requireAuth.ts — the server
  // compares request.headers['x-csrf-token'] against the token stored in
  // the session row in Postgres. See that file for the rationale.

  // ---- Health check (unauthenticated; safe to expose) ----
  app.get('/api/health', async () => ({
    status: 'ok',
    env: config.NODE_ENV,
    timestamp: new Date().toISOString(),
  }));

  // ---- Auth routes ----
  await app.register(authRoutes);

  // ---- Period / Entry / Meta routes ----
  await app.register(periodRoutes);
  await app.register(entryRoutes);
  await app.register(metaRoutes);

  // ---- Static serving (public/) ----
  // Serves login.html, signup.html, app.html, assets/, etc.
  // wildcard:false so /api/* doesn't get intercepted — our route handlers
  // above take priority and this fallback serves everything else.
  await app.register(staticPlugin, {
    root: PUBLIC_DIR,
    wildcard: false,
    index: ['index.html'],
    prefix: '/',
    cacheControl: true,
    maxAge: isDevelopment ? 0 : 3600,
  });

  // ---- Generic error handler: never leak stack traces in production ----
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'unhandled request error');
    const statusCode = error.statusCode ?? 500;
    // Fastify validation errors are safe to expose (the schema is ours)
    if (error.validation) {
      reply.code(400).send({ error: 'Bad Request', message: error.message });
      return;
    }
    reply
      .code(statusCode >= 500 ? 500 : statusCode)
      .send({
        error: statusCode >= 500 ? 'Internal Server Error' : error.name,
        message:
          statusCode >= 500
            ? 'Erro ao processar solicitação'
            : error.message,
      });
  });

  // ---- 404 ----
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'Not Found' });
  });

  return app;
}
