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

async function login(email: string): Promise<{ sid: string; csrf: string; userId: string }> {
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

async function createPeriod(
  auth: { sid: string; csrf: string },
  body: { name: string; year: number; type: 'DRE' | 'FC' },
): Promise<string> {
  const res = await http
    .post('/api/periods')
    .set('Cookie', [`sid=${auth.sid}`])
    .set('X-CSRF-Token', auth.csrf)
    .send(body);
  if (res.status !== 201) throw new Error(`create period failed: ${res.status}`);
  return res.body.id as string;
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

describe('GET /api/periods/:id/meta', () => {
  it('returns all-null shape for a fresh period (no meta set)', async () => {
    const auth = await login('gm1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .get(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(res.status).toBe(200);
    expect(res.body.receitaAnual).toBeNull();
    expect(res.body.margemBrutaPct).toBeNull();
    expect(res.body.pedidosMes).toBeNull();
  });

  it('404 for IDOR attempt', async () => {
    const alice = await login('gma@test.com');
    const bob = await login('gmb@test.com');
    const periodId = await createPeriod(alice, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .get(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${bob.sid}`]);
    expect(res.status).toBe(404);
  });

  it('401 without session', async () => {
    const res = await http.get(`/api/periods/00000000-0000-0000-0000-000000000000/meta`);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/periods/:id/meta', () => {
  it('upserts metas and returns them back', async () => {
    const auth = await login('pm1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        receitaAnual: 500000,
        lucroAnual: 100000,
        margemBrutaPct: 40,
        ticketMedio: 250,
      });
    expect(res.status).toBe(200);
    expect(res.body.receitaAnual).toBe(500000);
    expect(res.body.lucroAnual).toBe(100000);
    expect(res.body.margemBrutaPct).toBe(40);
    expect(res.body.ticketMedio).toBe(250);
    // Unset fields stay null.
    expect(res.body.pedidosMes).toBeNull();
  });

  it('merges partial updates (preserves previously-set fields)', async () => {
    const auth = await login('pm2@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    // First: set receita + margem.
    await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ receitaAnual: 100000, margemBrutaPct: 35 });
    // Second: update ONLY ticket.
    const res = await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ ticketMedio: 199 });
    expect(res.body.receitaAnual).toBe(100000); // preserved
    expect(res.body.margemBrutaPct).toBe(35); // preserved
    expect(res.body.ticketMedio).toBe(199); // new
  });

  it('honors explicit null to clear a goal', async () => {
    const auth = await login('pm3@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ receitaAnual: 100000 });
    const res = await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ receitaAnual: null });
    expect(res.body.receitaAnual).toBeNull();
  });

  it('rejects empty body (must have at least one field)', async () => {
    const auth = await login('pm4@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects unknown fields (mass assignment guard)', async () => {
    const auth = await login('pm5@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        receitaAnual: 100000,
        periodId: 'something-else', // attempt to redirect the write
        userId: 'attack',
      });
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range percent', async () => {
    const auth = await login('pm6@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ margemBrutaPct: 99999 });
    expect(res.status).toBe(400);
  });

  it('rejects non-integer pedidosMes', async () => {
    const auth = await login('pm7@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ pedidosMes: 3.14 });
    expect(res.status).toBe(400);
  });

  it('IDOR: PUT on another user period -> 404', async () => {
    const alice = await login('pma@test.com');
    const bob = await login('pmb@test.com');
    const periodId = await createPeriod(alice, { name: 'Mine', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${bob.sid}`])
      .set('X-CSRF-Token', bob.csrf)
      .send({ receitaAnual: 9999999 });
    expect(res.status).toBe(404);
    const meta = await prisma.meta.findUnique({ where: { periodId } });
    expect(meta).toBeNull();
  });

  it('409 on FINALIZED period', async () => {
    const auth = await login('pmf@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    await http
      .put(`/api/periods/${periodId}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ status: 'FINALIZED' });
    const res = await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ receitaAnual: 100000 });
    expect(res.status).toBe(409);
  });

  it('rejects without CSRF', async () => {
    const auth = await login('pmcsrf@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .send({ receitaAnual: 100000 });
    expect(res.status).toBe(403);
  });
});

describe('Audit (meta)', () => {
  it('records period.meta.update with fieldsSet (no values)', async () => {
    const auth = await login('pma2@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    await http
      .put(`/api/periods/${periodId}/meta`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ receitaAnual: 777777, margemBrutaPct: 42 });
    await audit.drain();
    const events = await prisma.auditLog.findMany({
      where: { action: 'period.meta.update', userId: auth.userId },
    });
    expect(events.length).toBe(1);
    const md = events[0]!.metadata as { fieldsSet: string[] };
    expect(md.fieldsSet).toEqual(expect.arrayContaining(['receitaAnual', 'margemBrutaPct']));
    // No monetary values leaked.
    expect(JSON.stringify(md)).not.toContain('777777');
  });
});
