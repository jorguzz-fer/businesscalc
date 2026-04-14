/**
 * Entries view + computed integration tests (post Fase 1.5 refactor).
 *
 * The old bulk PUT entries shape is gone. The endpoint now returns
 * { categories: [...], computed }. Writes happen via /api/categories/:id/monthly
 * (covered in tests/category.test.ts).
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
  const r = await http.post('/api/auth/login').send({
    email,
    password: 'verysecurepassword12345',
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
  if (res.status !== 201) throw new Error(`create period failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

async function patchMonthly(
  auth: { sid: string; csrf: string },
  categoryId: string,
  monthly: number[],
) {
  return http
    .patch(`/api/categories/${categoryId}/monthly`)
    .set('Cookie', [`sid=${auth.sid}`])
    .set('X-CSRF-Token', auth.csrf)
    .send({ monthly });
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

describe('GET /api/periods/:id/entries', () => {
  it('seeds DRE periods with 18 default categories', async () => {
    const auth = await login('e1@test.com');
    const periodId = await createPeriod(auth, { name: 'DRE 2024', year: 2024, type: 'DRE' });
    const res = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(res.status).toBe(200);
    expect(res.body.periodType).toBe('DRE');
    expect(res.body.categories.length).toBe(18);
    expect(res.body.computed.totalReceita).toBe(0);
  });

  it('seeds FC periods with 19 default categories (3 entrada + 16 saida)', async () => {
    const auth = await login('e2@test.com');
    const periodId = await createPeriod(auth, { name: 'FC 2024', year: 2024, type: 'FC' });
    const res = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(res.body.periodType).toBe('FC');
    expect(res.body.categories.length).toBe(19);
  });

  it('IDOR: returns 404 for another user period', async () => {
    const alice = await login('a1@test.com');
    const bob = await login('b1@test.com');
    const periodId = await createPeriod(alice, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${bob.sid}`]);
    expect(res.status).toBe(404);
  });

  it('401 without session', async () => {
    const res = await http.get(`/api/periods/00000000-0000-0000-0000-000000000000/entries`);
    expect(res.status).toBe(401);
  });
});

describe('Server-computed values (DRE)', () => {
  it('lucroBruto = (receita - dedução) - sum(custos diretos); resultado = lucroBruto - sum(despOp)', async () => {
    const auth = await login('comp1@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const view = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    type Cat = { id: string; section: string; label: string };
    const cats = view.body.categories as Cat[];
    const byLabel = (l: string) => cats.find((c) => c.label === l)!;

    const twelve = (n: number) => Array.from({ length: 12 }, () => n);
    await patchMonthly(auth, byLabel('Receita de Vendas').id, twelve(10000));
    await patchMonthly(auth, byLabel('Deduções e Impostos').id, twelve(0));
    await patchMonthly(auth, byLabel('CMV / Logística').id, twelve(3000));
    await patchMonthly(auth, byLabel('Pessoal (Salários CLT)').id, twelve(4000));

    const after = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(after.body.computed.totalReceita).toBe(120000);
    expect(after.body.computed.totalLucroBruto).toBe(84000); // (10000 - 3000) * 12
    expect(after.body.computed.totalResultado).toBe(36000); // 7000 - 4000 = 3000/mes
    expect(after.body.computed.margemLiquidaAnual).toBeCloseTo(30);
  });

  it('CUSTOM category added to CUSTOS_DIRETOS counts toward Lucro Bruto', async () => {
    const auth = await login('comp2@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const view = await http.get(`/api/periods/${periodId}/entries`).set('Cookie', [`sid=${auth.sid}`]);
    const receitaId = view.body.categories.find((c: { label: string }) => c.label === 'Receita de Vendas').id;
    const twelve = (n: number) => Array.from({ length: 12 }, () => n);
    await patchMonthly(auth, receitaId, twelve(10000));

    // Add a CUSTOM category in CUSTOS_DIRETOS.
    const create = await http
      .post(`/api/periods/${periodId}/categories`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ section: 'CUSTOS_DIRETOS', label: 'Royalties Franquia' });
    expect(create.status).toBe(201);
    await patchMonthly(auth, create.body.id, twelve(500));

    const after = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    // receita 120000 - custos 500*12=6000 = lucroBruto 114000
    expect(after.body.computed.totalLucroBruto).toBe(114000);
  });
});

describe('FC computation', () => {
  it('saldo = entradas (receita-only, money-kind, excluding ticket) - saídas', async () => {
    const auth = await login('fc1@test.com');
    const periodId = await createPeriod(auth, { name: 'FC 2024', year: 2024, type: 'FC' });
    const view = await http.get(`/api/periods/${periodId}/entries`).set('Cookie', [`sid=${auth.sid}`]);
    const byLabel = (l: string) =>
      view.body.categories.find((c: { label: string }) => c.label === l).id;
    const twelve = (n: number) => Array.from({ length: 12 }, () => n);
    await patchMonthly(auth, byLabel('Receita de Vendas'), twelve(10000));
    await patchMonthly(auth, byLabel('CMV / Logística'), twelve(2000));
    await patchMonthly(auth, byLabel('Pessoal (Salários CLT)'), twelve(3000));

    const after = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(after.body.computed.totalEntradasAno).toBe(120000);
    expect(after.body.computed.totalSaidasAno).toBe(60000);
    expect(after.body.computed.saldoAno).toBe(60000);
  });
});
