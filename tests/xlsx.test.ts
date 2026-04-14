/**
 * XLSX upload + template (post Fase 1.5).
 *
 * Upload now resolves spreadsheet labels to the period's PeriodCategory.id
 * via exact label match. Default labels match the seed labels, so a
 * fresh template loads cleanly. Renamed labels are skipped silently.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import supertest, { type SuperTest, type Test } from 'supertest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import * as audit from '../src/services/audit.service.js';
import {
  buildTemplateBuffer,
  parseBuffer,
  validateBuffer,
  XlsxValidationError,
} from '../src/services/xlsx.service.js';

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

describe('validateBuffer', () => {
  it('rejects empty', () => {
    expect(() => validateBuffer(Buffer.alloc(0))).toThrow(XlsxValidationError);
  });
  it('rejects non-zip magic', () => {
    expect(() => validateBuffer(Buffer.from('hello'))).toThrow(/Formato inválido/);
  });
  it('rejects > 10 MB', () => {
    const huge = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(11 * 1024 * 1024)]);
    expect(() => validateBuffer(huge)).toThrow(/maior que 10 MB/);
  });
  it('accepts a generated template', () => {
    expect(() => validateBuffer(buildTemplateBuffer())).not.toThrow();
  });
});

describe('parseBuffer roundtrip', () => {
  it('returns dreByLabel + fcByLabel + metas', () => {
    const buf = buildTemplateBuffer();
    const parsed = parseBuffer(buf);
    expect(parsed.dreByLabel).toBeDefined();
    expect(parsed.fcByLabel).toBeDefined();
    expect(parsed.metas).toBeDefined();
    // Default labels survive roundtrip.
    expect(parsed.dreByLabel?.['Receita de Vendas']).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('GET /api/template.xlsx', () => {
  it('returns valid xlsx for authed user', async () => {
    const auth = await login('tpl@test.com');
    const res = await http
      .get('/api/template.xlsx')
      .set('Cookie', [`sid=${auth.sid}`])
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 4).toString('hex')).toBe('504b0304');
  });
  it('401 without auth', async () => {
    expect((await http.get('/api/template.xlsx')).status).toBe(401);
  });
});

describe('POST /api/periods/:id/upload', () => {
  it('matches labels to seed categories and updates monthly', async () => {
    const auth = await login('up1@test.com');
    const periodId = await createPeriod(auth, { name: 'DRE 2024', year: 2024, type: 'DRE' });

    // Build a minimal xlsx with 2 known labels filled.
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const rows = [
      ['Categoria', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
      ['Receita de Vendas', 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
      ['CMV / Logística', 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'DRE');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .attach('file', buf, {
        filename: 'test.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    expect(res.status).toBe(200);
    expect(res.body.categoriesImported).toBe(2);
    expect(res.body.unmatchedRows).toBe(0);

    // Verify computed reflects the upload.
    const view = await http
      .get(`/api/periods/${periodId}/entries`)
      .set('Cookie', [`sid=${auth.sid}`]);
    expect(view.body.computed.totalReceita).toBe(12000);
  });

  it('counts unmatched rows when label was renamed', async () => {
    const auth = await login('up2@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    // Rename a category in the period.
    const view = await http.get(`/api/periods/${periodId}/entries`).set('Cookie', [`sid=${auth.sid}`]);
    const cmv = view.body.categories.find((c: { label: string }) => c.label === 'CMV / Logística');
    await http
      .patch(`/api/categories/${cmv.id}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ label: 'Custos Mercadoria Vendida' });

    // Upload a sheet with the OLD label -> should be unmatched.
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Categoria', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
        ['CMV / Logística', 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ]),
      'DRE',
    );
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .attach('file', buf, {
        filename: 'old.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    expect(res.status).toBe(200);
    expect(res.body.unmatchedRows).toBe(1);
    expect(res.body.categoriesImported).toBe(0);
  });

  it('rejects non-xlsx (extension/MIME)', async () => {
    const auth = await login('up3@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .attach('file', Buffer.from('not xlsx'), { filename: 'evil.txt', contentType: 'text/plain' });
    expect([400, 415]).toContain(res.status);
  });

  it('rejects fake-magic (.xlsx ext + non-zip content)', async () => {
    const auth = await login('up4@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .attach('file', Buffer.from('not really xlsx'), {
        filename: 'fake.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    expect(res.status).toBe(400);
  });

  it('IDOR: bob upload to alice period -> 404', async () => {
    const alice = await login('upa@test.com');
    const bob = await login('upb@test.com');
    const periodId = await createPeriod(alice, { name: 'A', year: 2024, type: 'DRE' });
    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${bob.sid}`])
      .set('X-CSRF-Token', bob.csrf)
      .attach('file', buildTemplateBuffer(), {
        filename: 'tpl.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    expect(res.status).toBe(404);
  });

  it('FINALIZED -> 409', async () => {
    const auth = await login('upf@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    await http
      .put(`/api/periods/${periodId}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ status: 'FINALIZED' });
    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .attach('file', buildTemplateBuffer(), {
        filename: 'tpl.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    expect(res.status).toBe(409);
  });

  it('rejects without CSRF', async () => {
    const auth = await login('upcsrf@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .attach('file', buildTemplateBuffer(), {
        filename: 'tpl.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    expect(res.status).toBe(403);
  });
});
