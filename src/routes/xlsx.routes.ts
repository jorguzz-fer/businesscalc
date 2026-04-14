/**
 * XLSX upload + template download routes.
 *
 * The upload now resolves spreadsheet labels to PeriodCategory ids via
 * exact label match against the period's category list. If the user
 * renamed a category and uploads the OLD-label template, those rows are
 * skipped silently (we don't want to clobber renamed items with a fresh
 * upload). User can either keep labels in sync or use the per-period
 * template generator (next step) which uses their current labels.
 *
 * Security same as before: 10 MB cap, magic-byte check, MIME +
 * extension, ownership + finalize gates BEFORE parsing.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  buildTemplateBuffer,
  parseBuffer,
  validateBuffer,
  XlsxValidationError,
  MAX_UPLOAD_BYTES,
  XLSX_MIME,
  type ParsedWorkbook,
} from '../services/xlsx.service.js';
import {
  bulkUpdateMonthly,
  PeriodFinalizedError,
} from '../services/entry.service.js';
import { upsertForPeriod as upsertMeta } from '../services/meta.service.js';
import * as audit from '../services/audit.service.js';

function ipOf(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  return (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ?? request.ip;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>"'&\0\r\n]/g, '').slice(0, 200);
}

export async function xlsxRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      fields: 0,
      fieldSize: 0,
    },
  });

  // ---------- GET /api/template.xlsx ----------
  app.get(
    '/api/template.xlsx',
    { preHandler: requireAuth },
    async (_request, reply) => {
      const buf = buildTemplateBuffer();
      reply
        .header('Content-Type', XLSX_MIME)
        .header('Content-Disposition', 'attachment; filename="BusinessCalc-Template.xlsx"')
        .header('Cache-Control', 'no-store')
        .send(buf);
    },
  );

  // ---------- POST /api/periods/:id/upload ----------
  app.post<{ Params: { id: string } }>(
    '/api/periods/:id/upload',
    { preHandler: requireAuth },
    async (request, reply) => {
      const period = await prisma.period.findFirst({
        where: { id: request.params.id, userId: request.user!.id },
        select: { id: true, type: true, status: true },
      });
      if (!period) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      if (period.status === 'FINALIZED') {
        reply.code(409).send({
          error: 'Conflict',
          message: 'Período finalizado não aceita upload',
        });
        return;
      }

      let uploaded: { filename: string; mimetype: string; buffer: Buffer; truncated: boolean } | null = null;
      try {
        const part = await request.file();
        if (!part) {
          reply.code(400).send({ error: 'Bad Request', message: 'Nenhum arquivo enviado' });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        uploaded = {
          filename: part.filename ?? 'unknown.xlsx',
          mimetype: part.mimetype ?? 'unknown',
          buffer: Buffer.concat(chunks),
          truncated: part.file.truncated,
        };
      } catch (err) {
        request.log.warn({ err }, 'multipart parse failed');
        reply.code(400).send({ error: 'Bad Request', message: 'Upload inválido' });
        return;
      }

      if (uploaded.truncated) {
        reply.code(413).send({ error: 'Payload Too Large', message: 'Arquivo maior que 10 MB' });
        return;
      }

      const nameOk = uploaded.filename.toLowerCase().endsWith('.xlsx');
      const mimeOk = uploaded.mimetype === XLSX_MIME || uploaded.mimetype === 'application/octet-stream';
      if (!nameOk || !mimeOk) {
        reply.code(415).send({ error: 'Unsupported Media Type', message: 'Apenas arquivos .xlsx são aceitos' });
        return;
      }

      let parsed: ParsedWorkbook;
      try {
        validateBuffer(uploaded.buffer);
        parsed = parseBuffer(uploaded.buffer);
      } catch (err) {
        if (err instanceof XlsxValidationError) {
          reply.code(400).send({ error: 'Bad Request', message: err.message });
          return;
        }
        request.log.warn({ err }, 'xlsx parse failed');
        reply.code(400).send({
          error: 'Bad Request',
          message: 'Não foi possível ler o arquivo. Use o template oficial.',
        });
        return;
      }

      const sheetByLabel = period.type === 'DRE' ? parsed.dreByLabel : parsed.fcByLabel;
      if (!sheetByLabel || Object.keys(sheetByLabel).length === 0) {
        reply.code(400).send({
          error: 'Bad Request',
          message: `Planilha não contém aba "${period.type}" ou está vazia`,
        });
        return;
      }

      // Map labels to this period's category ids.
      const categories = await prisma.periodCategory.findMany({
        where: { periodId: period.id },
        select: { id: true, label: true },
      });
      const labelToId = new Map<string, string>();
      categories.forEach((c) => labelToId.set(c.label.trim().toLowerCase(), c.id));

      const updates: Array<{ categoryId: string; monthly: number[] }> = [];
      let unmatched = 0;
      for (const [label, monthly] of Object.entries(sheetByLabel)) {
        const id = labelToId.get(label.trim().toLowerCase());
        if (id) updates.push({ categoryId: id, monthly });
        else unmatched++;
      }

      try {
        const result = await bulkUpdateMonthly(request.user!.id, request.params.id, updates);
        if (!result) {
          reply.code(404).send({ error: 'Not Found' });
          return;
        }

        let metasUpdated = false;
        if (parsed.metas && Object.keys(parsed.metas).length > 0) {
          const metaInput: Record<string, number | null> = {};
          for (const [k, v] of Object.entries(parsed.metas)) {
            if (v === undefined) continue;
            metaInput[k] = v;
          }
          if (Object.keys(metaInput).length > 0) {
            await upsertMeta(request.user!.id, request.params.id, metaInput);
            metasUpdated = true;
          }
        }

        audit.log({
          userId: request.user!.id,
          action: 'period.xlsx.upload',
          resource: `Period:${request.params.id}`,
          ip: ipOf(request),
          userAgent: request.headers['user-agent'],
          metadata: {
            filename: sanitizeFilename(uploaded.filename),
            size: uploaded.buffer.length,
            categoriesImported: result.updated,
            unmatchedRows: unmatched,
            metasUpdated,
          },
        });

        reply.send({
          ok: true,
          categoriesImported: result.updated,
          unmatchedRows: unmatched,
          metasUpdated,
        });
      } catch (err) {
        if (err instanceof PeriodFinalizedError) {
          reply.code(409).send({ error: 'Conflict', message: err.message });
          return;
        }
        throw err;
      }
    },
  );
}
