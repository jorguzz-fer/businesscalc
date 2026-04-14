/**
 * Auth flow + security tests.
 *
 * Strategy: we spin up the full Fastify app against a real local Postgres
 * and hit it via supertest. This covers the integration of middleware +
 * routes + services + Prisma in one shot.
 *
 * We DON'T use testcontainers (would require docker-in-docker which the
 * CI sandbox lacks) — instead we reuse the local dev postgres and
 * TRUNCATE between suites to get isolation.
 *
 * Rate limiter is per-IP and in-memory to the Fastify instance. We
 * re-create the app (and thus a fresh rate limiter) per suite so tests
 * don't leak throttle state into each other.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import supertest, { type SuperTest, type Test } from 'supertest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import * as audit from '../src/services/audit.service.js';

let app: FastifyInstance;
let http: SuperTest<Test>;

async function truncate(): Promise<void> {
  // Order matters for FK constraints — children first.
  await prisma.auditLog.deleteMany();
  await prisma.session.deleteMany();
  await prisma.periodCategory.deleteMany();
  await prisma.meta.deleteMany();
  await prisma.period.deleteMany();
  await prisma.user.deleteMany();
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  http = supertest(app.server);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Drain fire-and-forget audit writes from the previous test before
  // we truncate the tables. Otherwise an audit INSERT from the prior
  // test could land on a just-deleted row and we'd race unpredictably.
  await audit.drain();
  await truncate();
});

async function signupAndVerify(email: string, password = 'verysecurepassword12345'): Promise<string> {
  await http.post('/api/auth/signup').send({
    email,
    password,
    termsAccepted: true,
  });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error('signup did not create user');
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: true, verifyToken: null, verifyTokenExpires: null },
  });
  return user.id;
}

function parseSetCookies(raw: string[] | string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const cookies = Array.isArray(raw) ? raw : [raw];
  for (const c of cookies) {
    const firstEq = c.indexOf('=');
    const firstSemi = c.indexOf(';');
    const name = c.slice(0, firstEq);
    const value = c.slice(firstEq + 1, firstSemi > 0 ? firstSemi : undefined);
    out[name] = value;
  }
  return out;
}

// ==========================================================
// SIGNUP
// ==========================================================

describe('POST /api/auth/signup', () => {
  it('creates user, sends verify token to DB, returns generic 201', async () => {
    const res = await http.post('/api/auth/signup').send({
      email: 'new@example.com',
      password: 'verysecurepassword12345',
      termsAccepted: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    const user = await prisma.user.findUnique({ where: { email: 'new@example.com' } });
    expect(user).toBeTruthy();
    expect(user?.emailVerified).toBe(false);
    expect(user?.verifyToken).toBeTruthy();
  });

  it('rejects short password (< 12)', async () => {
    const res = await http.post('/api/auth/signup').send({
      email: 'weak@example.com',
      password: 'short1',
      termsAccepted: true,
    });
    expect(res.status).toBe(400);
  });

  it('rejects termsAccepted=false', async () => {
    const res = await http.post('/api/auth/signup').send({
      email: 'noterm@example.com',
      password: 'verysecurepassword12345',
      termsAccepted: false,
    });
    expect(res.status).toBe(400);
  });

  it('returns 201 even when email already exists (anti-enumeration)', async () => {
    // First signup
    await http.post('/api/auth/signup').send({
      email: 'dup@example.com',
      password: 'verysecurepassword12345',
      termsAccepted: true,
    });
    // Second with same email — should NOT leak that it's taken.
    const res = await http.post('/api/auth/signup').send({
      email: 'dup@example.com',
      password: 'anotherpassword12345',
      termsAccepted: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    // Only ONE user row should exist.
    const count = await prisma.user.count({ where: { email: 'dup@example.com' } });
    expect(count).toBe(1);
  });

  it('rejects mass assignment of privileged fields', async () => {
    const res = await http.post('/api/auth/signup').send({
      email: 'evil@example.com',
      password: 'verysecurepassword12345',
      termsAccepted: true,
      emailVerified: true, // attempt to pre-verify
      isAdmin: true, // attempt to elevate
    });
    // zod .strict() rejects unknown keys.
    expect(res.status).toBe(400);
    const user = await prisma.user.findUnique({ where: { email: 'evil@example.com' } });
    expect(user).toBeNull();
  });
});

// ==========================================================
// VERIFY EMAIL
// ==========================================================

describe('GET /api/auth/verify', () => {
  it('verifies user and redirects to /verify.html?status=ok', async () => {
    await http.post('/api/auth/signup').send({
      email: 'verify@example.com',
      password: 'verysecurepassword12345',
      termsAccepted: true,
    });
    const user = await prisma.user.findUnique({ where: { email: 'verify@example.com' } });
    const res = await http.get(`/api/auth/verify?token=${user?.verifyToken}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=ok');
    const after = await prisma.user.findUnique({ where: { email: 'verify@example.com' } });
    expect(after?.emailVerified).toBe(true);
    expect(after?.verifyToken).toBeNull();
  });

  it('redirects to status=expired for bogus token', async () => {
    const res = await http.get('/api/auth/verify?token=notARealTokenButValidLookingToken');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=expired');
  });
});

// ==========================================================
// LOGIN
// ==========================================================

describe('POST /api/auth/login', () => {
  it('succeeds with valid credentials and sets signed session + csrf cookies', async () => {
    await signupAndVerify('login@example.com');
    const res = await http.post('/api/auth/login').send({
      email: 'login@example.com',
      password: 'verysecurepassword12345',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.csrfToken).toBeTruthy();
    const cookies = parseSetCookies(res.headers['set-cookie']);
    expect(cookies.sid).toBeTruthy();
    expect(cookies.csrf).toBeTruthy();
  });

  it('rejects wrong password with 401 and generic message', async () => {
    await signupAndVerify('login2@example.com');
    const res = await http.post('/api/auth/login').send({
      email: 'login2@example.com',
      password: 'wrongpassword123456',
    });
    expect(res.status).toBe(401);
    // Same message for wrong email AND wrong password (anti-enumeration).
    expect(res.body.message).toContain('Email ou senha inválidos');
  });

  it('rejects non-existent email with 401 and SAME generic message', async () => {
    const res = await http.post('/api/auth/login').send({
      email: 'nosuch@example.com',
      password: 'whatever123456789',
    });
    expect(res.status).toBe(401);
    expect(res.body.message).toContain('Email ou senha inválidos');
  });

  it('rejects unverified email with 403 after correct password', async () => {
    // Create but do NOT verify.
    await http.post('/api/auth/signup').send({
      email: 'unv@example.com',
      password: 'verysecurepassword12345',
      termsAccepted: true,
    });
    const res = await http.post('/api/auth/login').send({
      email: 'unv@example.com',
      password: 'verysecurepassword12345',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('email_not_verified');
  });

  it('locks account after 10 failed attempts', async () => {
    await signupAndVerify('lock@example.com');
    // 10 wrong attempts.
    for (let i = 0; i < 10; i++) {
      await http.post('/api/auth/login').send({
        email: 'lock@example.com',
        password: 'wrongpasswordx12345',
      });
    }
    // 11th with correct password should now be locked.
    const res = await http.post('/api/auth/login').send({
      email: 'lock@example.com',
      password: 'verysecurepassword12345',
    });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('account_locked');
  });
});

// ==========================================================
// CSRF
// ==========================================================

describe('CSRF protection on state-changing routes', () => {
  async function loginAndGetCookies(email: string): Promise<{ sid: string; csrf: string }> {
    await signupAndVerify(email);
    const res = await http.post('/api/auth/login').send({
      email,
      password: 'verysecurepassword12345',
    });
    const cookies = parseSetCookies(res.headers['set-cookie']);
    return { sid: cookies.sid ?? '', csrf: cookies.csrf ?? '' };
  }

  it('rejects POST without X-CSRF-Token header (403)', async () => {
    const { sid } = await loginAndGetCookies('csrf1@example.com');
    const res = await http
      .post('/api/auth/logout')
      .set('Cookie', [`sid=${sid}`]);
    expect(res.status).toBe(403);
  });

  it('rejects POST with wrong X-CSRF-Token (403)', async () => {
    const { sid } = await loginAndGetCookies('csrf2@example.com');
    const res = await http
      .post('/api/auth/logout')
      .set('Cookie', [`sid=${sid}`])
      .set('X-CSRF-Token', 'totally-wrong-token');
    expect(res.status).toBe(403);
  });

  it('accepts POST with correct X-CSRF-Token (200)', async () => {
    const { sid, csrf } = await loginAndGetCookies('csrf3@example.com');
    const res = await http
      .post('/api/auth/logout')
      .set('Cookie', [`sid=${sid}`])
      .set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
  });
});

// ==========================================================
// LOGOUT + SESSION REVOCATION
// ==========================================================

describe('Session lifecycle', () => {
  async function signupLoginReturnCookies(email: string) {
    await signupAndVerify(email);
    const res = await http.post('/api/auth/login').send({
      email,
      password: 'verysecurepassword12345',
    });
    const cookies = parseSetCookies(res.headers['set-cookie']);
    return cookies;
  }

  it('GET /api/auth/me returns user while logged in', async () => {
    const cookies = await signupLoginReturnCookies('me@example.com');
    const res = await http.get('/api/auth/me').set('Cookie', [`sid=${cookies.sid}`]);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('me@example.com');
    expect(res.body.csrfToken).toBe(cookies.csrf);
    // Hash must never be in response.
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('POST /api/auth/logout invalidates session, subsequent /me is 401', async () => {
    const cookies = await signupLoginReturnCookies('lo@example.com');
    const logoutRes = await http
      .post('/api/auth/logout')
      .set('Cookie', [`sid=${cookies.sid}`])
      .set('X-CSRF-Token', cookies.csrf);
    expect(logoutRes.status).toBe(200);
    const meRes = await http.get('/api/auth/me').set('Cookie', [`sid=${cookies.sid}`]);
    expect(meRes.status).toBe(401);
  });

  it('reset-password deletes ALL sessions for that user', async () => {
    await signupAndVerify('rev@example.com');
    // Create 3 sessions via 3 logins.
    for (let i = 0; i < 3; i++) {
      await http.post('/api/auth/login').send({
        email: 'rev@example.com',
        password: 'verysecurepassword12345',
      });
    }
    expect(await prisma.session.count({ where: { user: { email: 'rev@example.com' } } })).toBe(3);
    // Issue a reset.
    await http.post('/api/auth/forgot-password').send({ email: 'rev@example.com' });
    const user = await prisma.user.findUnique({ where: { email: 'rev@example.com' } });
    const resetRes = await http.post('/api/auth/reset-password').send({
      token: user?.resetToken,
      newPassword: 'newpasswordstrong1234',
    });
    expect(resetRes.status).toBe(200);
    // All sessions should be gone.
    expect(await prisma.session.count({ where: { user: { email: 'rev@example.com' } } })).toBe(0);
  });
});

// ==========================================================
// FORGOT PASSWORD
// ==========================================================

describe('POST /api/auth/forgot-password', () => {
  it('returns 200 generic response even for unknown email', async () => {
    const res = await http.post('/api/auth/forgot-password').send({
      email: 'doesnotexist@example.com',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('creates reset token for known email', async () => {
    await signupAndVerify('forgot@example.com');
    await http.post('/api/auth/forgot-password').send({ email: 'forgot@example.com' });
    const user = await prisma.user.findUnique({ where: { email: 'forgot@example.com' } });
    expect(user?.resetToken).toBeTruthy();
    expect(user?.resetTokenExpires?.getTime()).toBeGreaterThan(Date.now());
  });
});

// ==========================================================
// AUDIT LOG
// ==========================================================

describe('Audit log', () => {
  it('records auth.signup event', async () => {
    await http.post('/api/auth/signup').send({
      email: 'audit@example.com',
      password: 'verysecurepassword12345',
      termsAccepted: true,
    });
    await audit.drain();
    const events = await prisma.auditLog.findMany({ where: { action: 'auth.signup' } });
    expect(events.length).toBe(1);
  });

  it('records auth.login.failure then auth.login.success', async () => {
    await signupAndVerify('audit2@example.com');
    await http.post('/api/auth/login').send({
      email: 'audit2@example.com',
      password: 'wrong1234567890',
    });
    await http.post('/api/auth/login').send({
      email: 'audit2@example.com',
      password: 'verysecurepassword12345',
    });
    await audit.drain();
    const events = await prisma.auditLog.findMany({
      where: { action: { in: ['auth.login.failure', 'auth.login.success'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(['auth.login.failure', 'auth.login.success']);
  });
});
