/**
 * Entry CRUD + derived-value integration tests.
 *
 * Coverage focus:
 *   - IDOR: can't read/write entries on someone else's period.
 *   - Freeze: FINALIZED period rejects writes (409).
 *   - Computed values are SERVER-authoritative (client lies ignored).
 *   - Monthly array shape enforced.
 *   - Only whitelisted categories accepted.
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
  await prisma.entry.deleteMany();
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
  if (res.status !== 201) throw new Error(`create period failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

const twelveZeros = Array.from({ length: 12 }, () => 0);

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
// GET ENTRIES
// ==========================================================

describe('GET /api/periods/:id/entries', () => {
  it('returns empty entries + zero computed for fresh DRE period', async () => {
    const auth = await login('get1@test.com');
    const periodId = await createPeriod(auth, { name: 'DRE 2024', year: 2024, type: 'DRE' });
    const res = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(res.status).toBe(200);
    expect(res.body.periodType).toBe('DRE');
    expect(res.body.entries).toEqual({});
    expect(res.body.computed.totalReceita).toBe(0);
    expect(res.body.computed.totalResultado).toBe(0);
  });

  it('returns 404 for IDOR attempt (different user)', async () => {
    const alice = await login('a1@test.com');
    const bob = await login('b1@test.com');
    const periodId = await createPeriod(alice, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${bob.sid}`]);
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-existent periodId', async () => {
    const auth = await login('nf@test.com');
    const res = await http
      .get(`/api/periods/00000000-0000-0000-0000-000000000000/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(res.status).toBe(404);
  });

  it('returns 401 without session', async () => {
    const res = await http.get(`/api/periods/00000000-0000-0000-0000-000000000000/entries`);
    expect(res.status).toBe(401);
  });
});

// ==========================================================
// PUT ENTRIES
// ==========================================================

describe('PUT /api/periods/:id/entries', () => {
  it('upserts entries and recomputes server-side', async () => {
    const auth = await login('put1@test.com');
    const periodId = await createPeriod(auth, { name: 'DRE 2024', year: 2024, type: 'DRE' });
    const payload = {
      entries: [
        { category: 'receita', monthly: [10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000] },
        { category: 'cmv', monthly: [3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000] },
        { category: 'pessoal', monthly: [4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000] },
      ],
    };
    const res = await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.computed.totalReceita).toBe(120000); // 10000 * 12
    // Lucro bruto = receita - cmv = 7000/mes * 12 = 84000
    expect(res.body.computed.totalLucroBruto).toBe(84000);
    // Resultado = lucroBruto - despOp (only pessoal here) = (7000 - 4000) * 12 = 36000
    expect(res.body.computed.totalResultado).toBe(36000);
    // Margem liquida = 36000 / 120000 = 30%
    expect(res.body.computed.margemLiquidaAnual).toBeCloseTo(30);
  });

  it('ignores client-sent "computed" fields (server is authoritative)', async () => {
    const auth = await login('auth1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        entries: [
          { category: 'receita', monthly: twelveZeros.slice() },
        ],
        computed: { totalReceita: 999999 }, // attempt to inject
      });
    // strict() rejects unknown top-level keys.
    expect(res.status).toBe(400);
  });

  it('rejects unknown category', async () => {
    const auth = await login('cat1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        entries: [{ category: 'malicious', monthly: twelveZeros.slice() }],
      });
    expect(res.status).toBe(400);
  });

  it('rejects monthly array with wrong length', async () => {
    const auth = await login('len1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        entries: [{ category: 'receita', monthly: [1, 2, 3] }],
      });
    expect(res.status).toBe(400);
  });

  it('rejects non-finite numbers (Infinity/NaN get sent as string via JSON)', async () => {
    const auth = await login('fin1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    // JSON.stringify turns Infinity into null — zod catches the null.
    const bad = twelveZeros.slice();
    bad[3] = null as unknown as number;
    const res = await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        entries: [{ category: 'receita', monthly: bad }],
      });
    expect(res.status).toBe(400);
  });

  it('rejects values above the MAX bound', async () => {
    const auth = await login('max1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const over = [1e13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const res = await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ entries: [{ category: 'receita', monthly: over }] });
    expect(res.status).toBe(400);
  });

  it('deletes categories omitted from next upsert (full replacement semantics)', async () => {
    const auth = await login('repl@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    // First: two categories.
    await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        entries: [
          { category: 'receita', monthly: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100] },
          { category: 'cmv', monthly: [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50] },
        ],
      });
    // Second: only receita — cmv must be dropped.
    await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        entries: [
          { category: 'receita', monthly: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100] },
        ],
      });
    const get = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(get.body.entries.receita).toBeDefined();
    expect(get.body.entries.cmv).toBeUndefined();
  });

  it('rejects PUT on FINALIZED period (409)', async () => {
    const auth = await login('fin2@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    // Freeze it.
    await http
      .put(`/api/periods/${periodId}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ status: 'FINALIZED' });
    // Try to edit entries.
    const res = await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        entries: [{ category: 'receita', monthly: twelveZeros.slice() }],
      });
    expect(res.status).toBe(409);
  });

  it('IDOR: PUT on another user period -> 404 and no mutation', async () => {
    const alice = await login('idor1@test.com');
    const bob = await login('idor2@test.com');
    const periodId = await createPeriod(alice, { name: 'Mine', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${bob.sid}`])
      .set('X-CSRF-Token', bob.csrf)
      .send({
        entries: [{ category: 'receita', monthly: [99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99] }],
      });
    expect(res.status).toBe(404);
    // Alice's period has no entries.
    const count = await prisma.entry.count({ where: { periodId } });
    expect(count).toBe(0);
  });

  it('rejects without CSRF token', async () => {
    const auth = await login('csrf1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .send({
        entries: [{ category: 'receita', monthly: twelveZeros.slice() }],
      });
    expect(res.status).toBe(403);
  });
});

// ==========================================================
// FC COMPUTED
// ==========================================================

describe('FC computation', () => {
  it('computes totalSaidas + saldo server-side', async () => {
    const auth = await login('fc1@test.com');
    const periodId = await createPeriod(auth, { name: 'FC 2024', year: 2024, type: 'FC' });
    await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        entries: [
          { category: 'receita', monthly: [10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000] },
          { category: 'cmv', monthly: [2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000] },
          { category: 'pessoal', monthly: [3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000] },
          { category: 'pedidos', monthly: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100] },
        ],
      });
    const res = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(res.status).toBe(200);
    expect(res.body.periodType).toBe('FC');
    expect(res.body.computed.totalEntradasAno).toBe(120000);
    expect(res.body.computed.totalSaidasAno).toBe(60000); // 2000+3000 * 12
    expect(res.body.computed.saldoAno).toBe(60000);
    expect(res.body.computed.pedidosAno).toBe(1200);
    expect(res.body.computed.ticketMedioAno).toBeCloseTo(100); // 120000 / 1200
  });
});

// ==========================================================
// AUDIT
// ==========================================================

describe('Audit', () => {
  it('records period.entries.update with categoriesTouched (no monetary values)', async () => {
    const auth = await login('audit-e@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    await http
      .put(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        entries: [
          { category: 'receita', monthly: [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        ],
      });
    await audit.drain();
    const events = await prisma.auditLog.findMany({
      where: { action: 'period.entries.update', userId: auth.userId },
    });
    expect(events.length).toBe(1);
    const metadata = events[0]!.metadata as { categoriesTouched: string[]; count: number };
    expect(metadata.categoriesTouched).toContain('receita');
    // Confirm no money leaked into the audit row.
    expect(JSON.stringify(metadata)).not.toContain('100');
  });
});
