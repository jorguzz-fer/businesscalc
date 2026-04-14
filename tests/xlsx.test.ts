/**
 * XLSX upload + template integration tests.
 *
 * Focus:
 *   - Template generation produces a valid roundtrippable file.
 *   - Magic-byte validation catches non-XLSX uploads.
 *   - Size cap (10 MB) enforced.
 *   - Extension + MIME + magic bytes (defense in depth).
 *   - IDOR: upload to another user's period -> 404, no data change.
 *   - FINALIZED period -> 409.
 *   - Parser correctly maps labels to category keys.
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
// UNIT: validateBuffer + parseBuffer (no HTTP)
// ==========================================================

describe('validateBuffer', () => {
  it('rejects empty buffer', () => {
    expect(() => validateBuffer(Buffer.alloc(0))).toThrow(XlsxValidationError);
  });

  it('rejects buffer without ZIP magic (PK\\3\\4)', () => {
    const buf = Buffer.from('hello this is not xlsx');
    expect(() => validateBuffer(buf)).toThrow(/Formato inválido/);
  });

  it('rejects buffer larger than 10 MB', () => {
    const huge = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // valid magic
      Buffer.alloc(11 * 1024 * 1024),
    ]);
    expect(() => validateBuffer(huge)).toThrow(/maior que 10 MB/);
  });

  it('accepts a freshly generated template buffer', () => {
    const buf = buildTemplateBuffer();
    expect(() => validateBuffer(buf)).not.toThrow();
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
  });
});

describe('parseBuffer (generated template roundtrip)', () => {
  it('returns DRE + FC + Metas sheets with category keys', () => {
    const buf = buildTemplateBuffer();
    const parsed = parseBuffer(buf);
    expect(parsed.dre).toBeDefined();
    expect(parsed.fc).toBeDefined();
    expect(parsed.metas).toBeDefined();
    // Check a few known mappings.
    expect(parsed.dre?.receita).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parsed.dre?.cmv).toBeDefined();
    expect(parsed.dre?.pessoal).toBeDefined();
    expect(parsed.fc?.pedidos).toBeDefined();
    expect(parsed.metas?.receitaAnual).toBe(0);
  });
});

// ==========================================================
// TEMPLATE DOWNLOAD
// ==========================================================

describe('GET /api/template.xlsx', () => {
  it('returns a valid xlsx with correct headers for authed user', async () => {
    const auth = await login('tpl@test.com');
    const res = await http
      .get('/api/template.xlsx')
      .set('Cookie', [`sid=${auth.sid}`])
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('attachment');
    const buf = res.body as Buffer;
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  it('401 without session', async () => {
    const res = await http.get('/api/template.xlsx');
    expect(res.status).toBe(401);
  });
});

// ==========================================================
// UPLOAD
// ==========================================================

describe('POST /api/periods/:id/upload', () => {
  it('populates a DRE period from a generated template with filled values', async () => {
    const auth = await login('up1@test.com');
    const periodId = await createPeriod(auth, { name: 'DRE 2024', year: 2024, type: 'DRE' });

    // Build a tiny valid xlsx with a filled DRE sheet.
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const rows = [
      ['Categoria', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
      ['Receita de Vendas', 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
      ['CMV / Logistica', 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300],
      ['Pessoal (Salarios CLT)', 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'DRE');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .attach('file', buf, { filename: 'test.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(res.status).toBe(200);
    expect(res.body.categoriesImported).toBe(3);

    // Verify entries landed in DB.
    const entries = await prisma.entry.findMany({ where: { periodId } });
    expect(entries.length).toBe(3);
  });

  it('rejects non-xlsx file (extension + magic bytes)', async () => {
    const auth = await login('up2@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const fakeBuf = Buffer.from('this is not an xlsx file');
    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .attach('file', fakeBuf, { filename: 'malicious.txt', contentType: 'text/plain' });
    // Rejected at 415 (extension/MIME) before even reaching magic-byte check.
    expect([400, 415]).toContain(res.status);
  });

  it('rejects buffer with .xlsx extension but wrong magic bytes', async () => {
    const auth = await login('up3@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    // Has .xlsx extension but content is NOT a zip (no PK\3\4).
    const fakeBuf = Buffer.from('fake content pretending to be xlsx');
    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .attach('file', fakeBuf, { filename: 'fake.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(res.status).toBe(400);
  });

  it('IDOR: upload to another user period -> 404 + no data change', async () => {
    const alice = await login('uia@test.com');
    const bob = await login('uib@test.com');
    const periodId = await createPeriod(alice, { name: 'Alice', year: 2024, type: 'DRE' });
    const buf = buildTemplateBuffer();
    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${bob.sid}`])
      .set('X-CSRF-Token', bob.csrf)
      .attach('file', buf, { filename: 'test.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(res.status).toBe(404);
    const count = await prisma.entry.count({ where: { periodId } });
    expect(count).toBe(0);
  });

  it('rejects upload to FINALIZED period -> 409', async () => {
    const auth = await login('fin@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    await http
      .put(`/api/periods/${periodId}`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .send({ status: 'FINALIZED' });
    const buf = buildTemplateBuffer();
    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .attach('file', buf, { filename: 'test.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(res.status).toBe(409);
  });

  it('rejects without CSRF token', async () => {
    const auth = await login('csrf-up@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const buf = buildTemplateBuffer();
    const res = await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .attach('file', buf, { filename: 'test.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(res.status).toBe(403);
  });

  it('sanitizes filename in audit log', async () => {
    const auth = await login('san@test.com');
    const periodId = await createPeriod(auth, { name: 'X', year: 2024, type: 'DRE' });
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Categoria', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
        ['Receita de Vendas', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      ]),
      'DRE',
    );
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    await http
      .post(`/api/periods/${periodId}/upload`)
      .set('Cookie', [`sid=${auth.sid}`])
      .set('X-CSRF-Token', auth.csrf)
      .attach('file', buf, { filename: '<script>evil</script>.xlsx' });
    await audit.drain();
    const events = await prisma.auditLog.findMany({
      where: { action: 'period.xlsx.upload', userId: auth.userId },
    });
    expect(events.length).toBe(1);
    const md = events[0]!.metadata as { filename: string };
    expect(md.filename).not.toContain('<');
    expect(md.filename).not.toContain('>');
  });
});
