/**
 * /api/auth/* routes — the HTTP layer for auth.service.ts.
 *
 * Rate limits per vibesec:
 *   /api/auth/login            5 attempts / 15 min / IP
 *   /api/auth/signup           3 accounts / 1 hour / IP
 *   /api/auth/forgot-password  3 requests / 1 hour / IP
 *
 * Session cookie shape:
 *   name:     sid
 *   httpOnly: true        (JS cannot read it)
 *   secure:   true (prod) (HTTPS-only)
 *   sameSite: strict
 *   maxAge:   7 days
 *   signed:   true        (HMAC with SESSION_SECRET)
 *
 * CSRF cookie:
 *   name:     csrf
 *   httpOnly: false       (JS must read it to echo back in X-CSRF-Token)
 *   secure:   true (prod)
 *   sameSite: strict
 *   maxAge:   7 days (same as session)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SignupSchema,
  LoginSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  VerifyEmailSchema,
} from '../schemas/auth.schema.js';
import * as authSvc from '../services/auth.service.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { config, isProduction } from '../config.js';

const SESSION_TTL_S = 7 * 24 * 60 * 60;

function setSessionCookies(
  reply: FastifyReply,
  session: { sessionId: string; csrfToken: string },
): void {
  reply.setCookie('sid', session.sessionId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_S,
    signed: true,
  });
  reply.setCookie('csrf', session.csrfToken, {
    httpOnly: false, // JS must read it — double-submit pattern
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_S,
  });
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie('sid', { path: '/' });
  reply.clearCookie('csrf', { path: '/' });
}

function ctxFrom(request: FastifyRequest): authSvc.AuthContext {
  const xff = request.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ?? request.ip;
  const ua = request.headers['user-agent'];
  return {
    ip,
    userAgent: typeof ua === 'string' ? ua : undefined,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ---------- POST /api/auth/signup ----------
  app.post(
    '/api/auth/signup',
    {
      config: {
        rateLimit: { max: 3, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      const parsed = SignupSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Bad Request', message: parsed.error.issues[0]?.message ?? 'Entrada inválida' });
        return;
      }
      await authSvc.signup({
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.name,
        ctx: ctxFrom(request),
      });
      // Always 201 with a generic message to prevent enumeration.
      reply.code(201).send({
        ok: true,
        message: 'Conta criada. Verifique seu email para concluir o cadastro.',
      });
    },
  );

  // ---------- POST /api/auth/login ----------
  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
    },
    async (request, reply) => {
      const parsed = LoginSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Bad Request', message: 'Email ou senha inválidos' });
        return;
      }
      const result = await authSvc.login({
        email: parsed.data.email,
        password: parsed.data.password,
        ctx: ctxFrom(request),
      });

      if (!result.ok) {
        if (result.reason === 'email_not_verified') {
          reply.code(403).send({
            error: 'Forbidden',
            message: 'Verifique seu email antes de entrar.',
            code: 'email_not_verified',
          });
          return;
        }
        if (result.reason === 'account_locked') {
          reply.code(423).send({
            error: 'Locked',
            message: 'Conta temporariamente bloqueada após várias tentativas. Tente novamente mais tarde.',
            code: 'account_locked',
          });
          return;
        }
        // invalid_credentials — generic.
        reply.code(401).send({ error: 'Unauthorized', message: 'Email ou senha inválidos' });
        return;
      }

      setSessionCookies(reply, { sessionId: result.sessionId, csrfToken: result.csrfToken });
      reply.code(200).send({ ok: true, userId: result.userId, csrfToken: result.csrfToken });
    },
  );

  // ---------- POST /api/auth/logout ----------
  app.post(
    '/api/auth/logout',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (request.session) {
        await authSvc.logout({
          sessionId: request.session.id,
          userId: request.user?.id ?? null,
          ctx: ctxFrom(request),
        });
      }
      clearSessionCookies(reply);
      reply.code(200).send({ ok: true });
    },
  );

  // ---------- GET /api/auth/verify?token=... ----------
  // Public (no auth). Reached via the link in the verify email.
  app.get('/api/auth/verify', async (request, reply) => {
    const parsed = VerifyEmailSchema.safeParse(request.query);
    if (!parsed.success) {
      reply.redirect(`${config.APP_URL}/verify.html?status=invalid`);
      return;
    }
    const result = await authSvc.verifyEmail({
      token: parsed.data.token,
      ctx: ctxFrom(request),
    });
    const status = result.ok ? 'ok' : 'expired';
    reply.redirect(`${config.APP_URL}/verify.html?status=${status}`);
  });

  // ---------- POST /api/auth/forgot-password ----------
  app.post(
    '/api/auth/forgot-password',
    {
      config: {
        rateLimit: { max: 3, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      const parsed = ForgotPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Bad Request', message: 'Email inválido' });
        return;
      }
      await authSvc.forgotPassword({
        email: parsed.data.email,
        ctx: ctxFrom(request),
      });
      // ALWAYS the same response, regardless of whether the email exists.
      reply.code(200).send({
        ok: true,
        message: 'Se o email estiver cadastrado, enviamos um link de redefinição.',
      });
    },
  );

  // ---------- POST /api/auth/reset-password ----------
  app.post(
    '/api/auth/reset-password',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      const parsed = ResetPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Bad Request', message: parsed.error.issues[0]?.message ?? 'Entrada inválida' });
        return;
      }
      const result = await authSvc.resetPassword({
        token: parsed.data.token,
        newPassword: parsed.data.newPassword,
        ctx: ctxFrom(request),
      });
      if (!result.ok) {
        reply.code(400).send({
          error: 'Bad Request',
          message: 'Link inválido ou expirado. Solicite um novo.',
        });
        return;
      }
      reply.code(200).send({ ok: true, message: 'Senha redefinida. Faça login novamente.' });
    },
  );

  // ---------- GET /api/auth/me ----------
  // Used by the SPA to check "am I logged in?" and grab the CSRF token.
  app.get(
    '/api/auth/me',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!request.user || !request.session) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      reply.code(200).send({
        id: request.user.id,
        email: request.user.email,
        name: request.user.name,
        csrfToken: request.session.csrfToken,
      });
    },
  );
}
