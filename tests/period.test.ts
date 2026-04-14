/**
 * Period CRUD integration tests.
 *
 * Focus on the vibesec-critical behaviors:
 *   - IDOR: user A cannot read/update/delete user B's periods (returns 404,
 *     not 403 — don't leak existence of other users' resources).
 *   - Mass assignment: client cannot set userId, id, createdAt via POST/PUT.
 *   - Ownership on every path: list filtered by userId, get/update/delete
 *     require userId match.
 *   - Auth required: no session -> 401 on every route.
 *   - CSRF required on state-changing routes.
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
  await prisma.auditLog.deleteMany();
  await prisma.session.deleteMany();
  await prisma.periodCategory.deleteMany();
  await prisma.meta.deleteMany();
  await prisma.period.deleteMany();
  await prisma.user.deleteMany();
}

async function signupLogin(email: string): Promise<{ sid: string; csrf: string; userId: string }> {
  await http.post('/api/auth/signup').send({
    email,
    password: 'verysecurepassword12345',
    termsAccepted: true,
  });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error('signup failed');
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: true, verifyToken: null, verifyTokenExpires: null },
  });
  const loginRes = await http.post('/api/auth/login').send({
    email,
    password: 'verysecurepassword12345',
  });
  const setCookie = loginRes.headers['set-cookie'] as string[] | undefined;
  const cookies: Record<string, string> = {};
  (setCookie ?? []).forEach((c) => {
    const first = c.split(';')[0];
    const eq = first.indexOf('=');
    cookies[first.slice(0, eq)] = first.slice(eq + 1);
  });
  return { sid: cookies.sid ?? '', csrf: cookies.csrf ?? '', userId: user.id };
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
  await audit.drain();
  await truncate();
});

// ==========================================================
// AUTH REQUIRED
// ==========================================================

describe('Authentication required on /api/periods/*', () => {
  it('GET /api/periods without session -> 401', async () => {
    const res = await http.get('/api/periods');
    expect(res.status).toBe(401);
  });

  it('POST /api/periods without session -> 401', async () => {
    const res = await http.post('/api/periods').send({
      name: 'DRE 2024',
      year: 2024,
      type: 'DRE',
    });
    expect(res.status).toBe(401);
  });
});

// ==========================================================
// CREATE
// ==========================================================

describe('POST /api/periods', () => {
  it('creates a period for the authenticated user', async () => {
    const auth = await signupLogin('create1@test.com');
    const res = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'DRE 2024', year: 2024, type: 'DRE' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('DRE 2024');
    expect(res.body.year).toBe(2024);
    expect(res.body.type).toBe('DRE');
    expect(res.body.status).toBe('DRAFT');
    // Response must not leak userId.
    expect(res.body.userId).toBeUndefined();
    // DB: period belongs to the right user.
    const fromDb = await prisma.period.findFirst({ where: { name: 'DRE 2024' } });
    expect(fromDb?.userId).toBe(auth.userId);
  });

  it('returns 409 on duplicate (name, type) for the same user', async () => {
    const auth = await signupLogin('dup@test.com');
    await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'DRE 2024', year: 2024, type: 'DRE' });
    const res = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'DRE 2024', year: 2024, type: 'DRE' });
    expect(res.status).toBe(409);
  });

  it('rejects mass assignment of userId', async () => {
    const victim = await signupLogin('victim@test.com');
    const attacker = await signupLogin('attacker@test.com');
    const res = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${attacker.sid}`])
      .set('X-CSRF-Token', attacker.csrf)
      .send({
        name: 'Hijacked',
        year: 2024,
        type: 'DRE',
        userId: victim.userId, // attempt to inject as victim's period
      });
    // zod .strict() rejects unknown keys.
    expect(res.status).toBe(400);
    const all = await prisma.period.findMany({ where: { name: 'Hijacked' } });
    expect(all.length).toBe(0);
  });

  it('rejects mass assignment of status (must be DRAFT initially)', async () => {
    const auth = await signupLogin('mass@test.com');
    const res = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        name: 'Fast track',
        year: 2024,
        type: 'DRE',
        status: 'FINALIZED', // not allowed on create schema
      });
    expect(res.status).toBe(400);
  });

  it('rejects invalid year', async () => {
    const auth = await signupLogin('year@test.com');
    const res = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'Future', year: 3000, type: 'DRE' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid type', async () => {
    const auth = await signupLogin('type@test.com');
    const res = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'Bogus', year: 2024, type: 'PROFIT' });
    expect(res.status).toBe(400);
  });

  it('rejects name with suspicious characters', async () => {
    const auth = await signupLogin('xss@test.com');
    const res = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: '<script>alert(1)</script>', year: 2024, type: 'DRE' });
    expect(res.status).toBe(400);
  });

  it('rejects without CSRF token (403)', async () => {
    const auth = await signupLogin('csrf@test.com');
    const res = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      // no X-CSRF-Token
      .send({ name: 'DRE 2024', year: 2024, type: 'DRE' });
    expect(res.status).toBe(403);
  });
});

// ==========================================================
// LIST
// ==========================================================

describe('GET /api/periods', () => {
  it('returns only the authenticated user periods', async () => {
    const alice = await signupLogin('alice@test.com');
    const bob = await signupLogin('bob@test.com');
    // Alice creates 2, Bob creates 1.
    await http
      .post('/api/periods')
      .set('Cookie', [`sid=${alice.sid}`])
      .set('X-CSRF-Token', alice.csrf)
      .send({ name: 'DRE 2024', year: 2024, type: 'DRE' });
    await http
      .post('/api/periods')
      .set('Cookie', [`sid=${alice.sid}`])
      .set('X-CSRF-Token', alice.csrf)
      .send({ name: 'DRE 2023', year: 2023, type: 'DRE' });
    await http
      .post('/api/periods')
      .set('Cookie', [`sid=${bob.sid}`])
      .set('X-CSRF-Token', bob.csrf)
      .send({ name: "Bob's DRE", year: 2024, type: 'DRE' });

    // Alice sees only her own.
    const aliceList = await http.get('/api/periods').set('Cookie', [`sid=${alice.sid}`]);
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.periods.length).toBe(2);
    expect(aliceList.body.periods.every((p: { name: string }) => !p.name.includes('Bob'))).toBe(true);

    // Bob sees only his own.
    const bobList = await http.get('/api/periods').set('Cookie', [`sid=${bob.sid}`]);
    expect(bobList.status).toBe(200);
    expect(bobList.body.periods.length).toBe(1);
    expect(bobList.body.periods[0].name).toBe("Bob's DRE");
  });

  it('filters by type when ?type= passed', async () => {
    const auth = await signupLogin('filter@test.com');
    await http.post('/api/periods').set('Cookie', [`sid=${auth.sid}`]).set('X-CSRF-Token', auth.csrf).send({ name: 'DRE A', year: 2024, type: 'DRE' });
    await http.post('/api/periods').set('Cookie', [`sid=${auth.sid}`]).set('X-CSRF-Token', auth.csrf).send({ name: 'FC A', year: 2024, type: 'FC' });
    const dreOnly = await http.get('/api/periods?type=DRE').set('Cookie', [`sid=${auth.sid}`]);
    expect(dreOnly.body.periods.length).toBe(1);
    expect(dreOnly.body.periods[0].type).toBe('DRE');
  });
});

// ==========================================================
// IDOR (Insecure Direct Object Reference)
// ==========================================================

describe('IDOR protection on /api/periods/:id', () => {
  it("GET someone else's period -> 404 (not 403)", async () => {
    const alice = await signupLogin('a1@test.com');
    const bob = await signupLogin('b1@test.com');
    const create = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${alice.sid}`])
      .set('X-CSRF-Token', alice.csrf)
      .send({ name: 'Secret', year: 2024, type: 'DRE' });
    const aliceId = create.body.id;
    // Bob tries to read.
    const res = await http.get(`/api/periods/${aliceId}`).set('Cookie', [`sid=${bob.sid}`]);
    // 404 is intentional: returning 403 would confirm the id exists.
    expect(res.status).toBe(404);
  });

  it("PUT someone else's period -> 404 (no mutation)", async () => {
    const alice = await signupLogin('a2@test.com');
    const bob = await signupLogin('b2@test.com');
    const create = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${alice.sid}`])
      .set('X-CSRF-Token', alice.csrf)
      .send({ name: 'Original', year: 2024, type: 'DRE' });
    const aliceId = create.body.id;
    const res = await http
      .put(`/api/periods/${aliceId}`)
      .set('Cookie', [`sid=${bob.sid}`])
      .set('X-CSRF-Token', bob.csrf)
      .send({ name: 'Hacked' });
    expect(res.status).toBe(404);
    // Alice's period is untouched.
    const fromDb = await prisma.period.findUnique({ where: { id: aliceId } });
    expect(fromDb?.name).toBe('Original');
  });

  it("DELETE someone else's period -> 404 (no deletion)", async () => {
    const alice = await signupLogin('a3@test.com');
    const bob = await signupLogin('b3@test.com');
    const create = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${alice.sid}`])
      .set('X-CSRF-Token', alice.csrf)
      .send({ name: 'Important', year: 2024, type: 'DRE' });
    const aliceId = create.body.id;
    const res = await http
      .delete(`/api/periods/${aliceId}`)
      .set('Cookie', [`sid=${bob.sid}`])
      .set('X-CSRF-Token', bob.csrf);
    expect(res.status).toBe(404);
    const stillThere = await prisma.period.findUnique({ where: { id: aliceId } });
    expect(stillThere).toBeTruthy();
  });

  it('GET with a random non-existent UUID -> 404', async () => {
    const auth = await signupLogin('r1@test.com');
    const res = await http
      .get(`/api/periods/00000000-0000-0000-0000-000000000000`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(res.status).toBe(404);
  });
});

// ==========================================================
// UPDATE
// ==========================================================

describe('PUT /api/periods/:id', () => {
  it('updates allowed fields for the owner', async () => {
    const auth = await signupLogin('u1@test.com');
    const created = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'V1', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${created.body.id}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'V2', status: 'FINALIZED' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('V2');
    expect(res.body.status).toBe('FINALIZED');
  });

  it('rejects type change (would corrupt entries)', async () => {
    const auth = await signupLogin('u2@test.com');
    const created = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'Locked type', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${created.body.id}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ type: 'FC' });
    expect(res.status).toBe(400);
  });

  it('rejects userId injection on update (attempt to transfer ownership)', async () => {
    const alice = await signupLogin('u3@test.com');
    const bob = await signupLogin('u4@test.com');
    const created = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${alice.sid}`])
      .set('X-CSRF-Token', alice.csrf)
      .send({ name: 'Mine', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${created.body.id}`)
      .set('Cookie', [`sid=${alice.sid}`])
      .set('X-CSRF-Token', alice.csrf)
      .send({ userId: bob.userId });
    expect(res.status).toBe(400);
    const fromDb = await prisma.period.findUnique({ where: { id: created.body.id } });
    expect(fromDb?.userId).toBe(alice.userId);
  });

  it('rejects empty update body', async () => {
    const auth = await signupLogin('u5@test.com');
    const created = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${created.body.id}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({});
    expect(res.status).toBe(400);
  });
});

// ==========================================================
// DELETE
// ==========================================================

describe('DELETE /api/periods/:id', () => {
  it('deletes a period for the owner and returns 204', async () => {
    const auth = await signupLogin('d1@test.com');
    const created = await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'RIP', year: 2024, type: 'DRE' });
    const res = await http
      .delete(`/api/periods/${created.body.id}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf);
    expect(res.status).toBe(204);
    const fromDb = await prisma.period.findUnique({ where: { id: created.body.id } });
    expect(fromDb).toBeNull();
  });
});

// ==========================================================
// AUDIT
// ==========================================================

describe('Audit logging', () => {
  it('records period.create event with ownership', async () => {
    const auth = await signupLogin('audit@test.com');
    await http
      .post('/api/periods')
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'Audit Me', year: 2024, type: 'DRE' });
    await audit.drain();
    const events = await prisma.auditLog.findMany({
      where: { action: 'period.create', userId: auth.userId },
    });
    expect(events.length).toBe(1);
  });
});
