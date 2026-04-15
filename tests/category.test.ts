/**
 * PeriodCategory CRUD integration tests.
 *
 * Coverage:
 *   - Auth required on all routes.
 *   - CSRF required on state-changing routes.
 *   - IDOR: 404 when category doesn't belong to the user (chained ownership).
 *   - Mass-assignment: extra body fields rejected.
 *   - FINALIZED period blocks any mutation (409).
 *   - Computed values reflect new categories instantly.
 *   - Per the user's spec: BOTH system and custom categories can be deleted.
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

async function login(email: string): Promise<{ sid: string; csrf: string; userId: string }> {
  await http.post('/api/auth/signup').send({
    email, password: 'verysecurepassword12345', termsAccepted: true,
  });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error('signup failed');
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: true, verifyToken: null, verifyTokenExpires: null },
  });
  const r = await http.post('/api/auth/login').send({
    email, password: 'verysecurepassword12345',
  });
  const setCookie = r.headers['set-cookie'] as string[] | undefined;
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

describe('GET /api/periods/:id/categories', () => {
  it('returns 18 seed categories for new DRE', async () => {
    const auth = await login('cl1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .get(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(res.status).toBe(200);
    expect(res.body.categories.length).toBe(18);
    expect(res.body.categories[0]).toMatchObject({
      section: expect.any(String),
      label: expect.any(String),
      kind: expect.any(String),
      isSystem: true,
    });
  });

  it('IDOR -> 404', async () => {
    const alice = await login('cla@test.com');
    const bob = await login('clb@test.com');
    const periodId = await createPeriod(alice, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .get(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${bob.sid}`]);
    expect(res.status).toBe(404);
  });

  it('401 without auth', async () => {
    const res = await http.get(`/api/periods/00000000-0000-0000-0000-000000000000/categories`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/periods/:id/categories', () => {
  it('creates custom category placed at end of section', async () => {
    const auth = await login('cc1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .post(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ section: 'DESPESAS_OP', label: 'Software SaaS' });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Software SaaS');
    expect(res.body.isSystem).toBe(false);
    // Sort order > all existing despesas
    const all = await prisma.periodCategory.findMany({
      where: { periodId, section: 'DESPESAS_OP' },
      orderBy: { sortOrder: 'asc' },
    });
    expect(all[all.length - 1]?.label).toBe('Software SaaS');
  });

  it('rejects mass-assignment of isSystem/sortOrder/etc on create', async () => {
    const auth = await login('cc2@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .post(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({
        section: 'CUSTOS_DIRETOS',
        label: 'Sneaky',
        isSystem: true,
        periodId: 'fake-id',
      });
    expect(res.status).toBe(400);
  });

  it('rejects label with HTML/control chars', async () => {
    const auth = await login('cc3@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .post(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ section: 'DESPESAS_OP', label: '<script>alert(1)</script>' });
    expect(res.status).toBe(400);
  });

  it('IDOR: bob -> alice period -> 404', async () => {
    const alice = await login('cca@test.com');
    const bob = await login('ccb@test.com');
    const periodId = await createPeriod(alice, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .post(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${bob.sid}`])
      .set('X-CSRF-Token', bob.csrf)
      .send({ section: 'DESPESAS_OP', label: 'Pwned' });
    expect(res.status).toBe(404);
  });

  it('FINALIZED -> 409', async () => {
    const auth = await login('ccf@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    await http
      .put(`/api/periods/${periodId}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ status: 'FINALIZED' });
    const res = await http
      .post(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ section: 'DESPESAS_OP', label: 'Late' });
    expect(res.status).toBe(409);
  });

  it('no CSRF -> 403', async () => {
    const auth = await login('cccsrf@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .post(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${auth.sid}`])
      .send({ section: 'DESPESAS_OP', label: 'X' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/categories/:id', () => {
  it('renames a system category', async () => {
    const auth = await login('rn1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const list = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${auth.sid}`]);
    const cmv = list.body.categories.find((c: { label: string }) => c.label === 'CMV / Logística');
    const res = await http
      .patch(`/api/categories/${cmv.id}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ label: 'Custos de Mercadoria' });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Custos de Mercadoria');
    expect(res.body.isSystem).toBe(true); // still a system row, just renamed
  });

  it('IDOR: bob renames alice category -> 404', async () => {
    const alice = await login('rna@test.com');
    const bob = await login('rnb@test.com');
    const periodId = await createPeriod(alice, { name: 'X', year: 2024, type: 'DRE' });
    const list = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${alice.sid}`]);
    const target = list.body.categories[0];
    const res = await http
      .patch(`/api/categories/${target.id}`)
      .set('Cookie', [`sid=${bob.sid}`])
      .set('X-CSRF-Token', bob.csrf)
      .send({ label: 'Hacked' });
    expect(res.status).toBe(404);
    const fresh = await prisma.periodCategory.findUnique({ where: { id: target.id } });
    expect(fresh?.label).toBe(target.label);
  });

  it('rejects empty body', async () => {
    const auth = await login('rne@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const list = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${auth.sid}`]);
    const res = await http
      .patch(`/api/categories/${list.body.categories[0].id}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/categories/:id/monthly', () => {
  it('persists 12 monthly values', async () => {
    const auth = await login('mo1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const list = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${auth.sid}`]);
    const target = list.body.categories[0];
    const res = await http
      .patch(`/api/categories/${target.id}/monthly`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ monthly: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200] });
    expect(res.status).toBe(200);
    expect(res.body.monthly).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]);
  });

  it('rejects array of wrong length', async () => {
    const auth = await login('mo2@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const list = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${auth.sid}`]);
    const res = await http
      .patch(`/api/categories/${list.body.categories[0].id}/monthly`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ monthly: [1, 2, 3] });
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range value', async () => {
    const auth = await login('mo3@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const list = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${auth.sid}`]);
    const res = await http
      .patch(`/api/categories/${list.body.categories[0].id}/monthly`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ monthly: [1e13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/categories/:id', () => {
  it('deletes a system category (per spec — max flexibility)', async () => {
    const auth = await login('dl1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const list = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${auth.sid}`]);
    const target = list.body.categories[0]; // a system one
    const res = await http
      .delete(`/api/categories/${target.id}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf);
    expect(res.status).toBe(204);
    const after = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${auth.sid}`]);
    expect(after.body.categories.length).toBe(17);
  });

  it('IDOR: bob deletes alice category -> 404', async () => {
    const alice = await login('dla@test.com');
    const bob = await login('dlb@test.com');
    const periodId = await createPeriod(alice, { name: 'X', year: 2024, type: 'DRE' });
    const list = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${alice.sid}`]);
    const target = list.body.categories[0];
    const res = await http
      .delete(`/api/categories/${target.id}`)
      .set('Cookie', [`sid=${bob.sid}`])
      .set('X-CSRF-Token', bob.csrf);
    expect(res.status).toBe(404);
    expect(await prisma.periodCategory.count({ where: { id: target.id } })).toBe(1);
  });
});

describe('Lazy seed (legacy/empty periods)', () => {
  it('GET on a period with zero categories auto-seeds defaults', async () => {
    const auth = await login('seed1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    // Manually wipe categories to simulate a legacy/empty period.
    await prisma.periodCategory.deleteMany({ where: { periodId } });
    expect(await prisma.periodCategory.count({ where: { periodId } })).toBe(0);
    const res = await http
      .get(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(res.status).toBe(200);
    expect(res.body.categories.length).toBe(18);
  });

  it('GET /entries on an empty period also auto-seeds', async () => {
    const auth = await login('seed2@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'FC' });
    await prisma.periodCategory.deleteMany({ where: { periodId } });
    const res = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(res.status).toBe(200);
    expect(res.body.categories.length).toBe(19); // FC = 19 defaults
  });

  it('lazy seed does NOT touch a period that already has categories', async () => {
    const auth = await login('seed3@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    // Rename one to verify it survives subsequent GETs.
    const list = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${auth.sid}`]);
    const first = list.body.categories[0];
    await http
      .patch(`/api/categories/${first.id}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ label: 'CUSTOM NAME' });
    const after = await http.get(`/api/periods/${periodId}/categories`).set('Cookie', [`sid=${auth.sid}`]);
    expect(after.body.categories.find((c: { id: string }) => c.id === first.id).label).toBe('CUSTOM NAME');
  });
});

describe('Audit', () => {
  it('records category.create with section + label', async () => {
    const auth = await login('aud@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    await http
      .post(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ section: 'DESPESAS_OP', label: 'Audit me' });
    await audit.drain();
    const events = await prisma.auditLog.findMany({
      where: { action: 'category.create', userId: auth.userId },
    });
    expect(events.length).toBe(1);
    const md = events[0]!.metadata as { section: string; label: string };
    expect(md.section).toBe('DESPESAS_OP');
    expect(md.label).toBe('Audit me');
  });
});
