/**
 * XLSX upload + template download routes.
 *
 * Security (vibesec file-upload):
 *   - multipart body capped at 10 MB via @fastify/multipart config.
 *   - MIME + extension + magic bytes all checked.
 *   - File processed entirely in memory (toBuffer); never written to
 *     disk, never a path constructed from the uploaded filename.
 *   - Uploaded filename is read for the audit log only after sanitizing
 *     (strip angle brackets, quotes, control chars, length cap).
 *
 * The upload path also enforces ownership of the target period — an
 * attacker can't overwrite another user's period by POSTing an xlsx to
 * /api/periods/SOMEONE_ELSES_ID/upload.
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
  upsertForPeriod as upsertEntries,
  PeriodFinalizedError,
} from '../services/entry.service.js';
import { upsertForPeriod as upsertMeta } from '../services/meta.service.js';
import { UpsertEntriesSchema } from '../schemas/entry.schema.js';
import * as audit from '../services/audit.service.js';

function ipOf(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  return (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ?? request.ip;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>"'&\0\r\n]/g, '')
    .slice(0, 200);
}

export async function xlsxRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      // Fields the client shouldn't be sending in the multipart form.
      fields: 0,
      fieldSize: 0,
    },
  });

  // ---------- GET /api/template.xlsx ----------
  // Public-ish — we still require auth so only logged-in users can get
  // the canonical structure. Prevents template becoming an SEO-indexed
  // file anyone can find.
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
  // Multipart upload: accepts a single xlsx file, parses the DRE/FC/Metas
  // sheets, upserts into the target period.
  app.post<{ Params: { id: string } }>(
    '/api/periods/:id/upload',
    { preHandler: requireAuth },
    async (request, reply) => {
      // Ownership check FIRST — no work if not owner.
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

      // Collect the file. @fastify/multipart gives us an iterable; we
      // expect exactly one entry.
      let uploaded: {
        filename: string;
        mimetype: string;
        buffer: Buffer;
        truncated: boolean;
      } | null = null;

      try {
        const part = await request.file();
        if (!part) {
          reply.code(400).send({ error: 'Bad Request', message: 'Nenhum arquivo enviado' });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk as Buffer);
        }
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
        reply.code(413).send({
          error: 'Payload Too Large',
          message: 'Arquivo maior que 10 MB',
        });
        return;
      }

      // Defense in depth: extension + MIME + magic bytes (inside validateBuffer).
      const nameOk = uploaded.filename.toLowerCase().endsWith('.xlsx');
      const mimeOk =
        uploaded.mimetype === XLSX_MIME ||
        uploaded.mimetype === 'application/octet-stream'; // some browsers don't set MIME
      if (!nameOk || !mimeOk) {
        reply.code(415).send({
          error: 'Unsupported Media Type',
          message: 'Apenas arquivos .xlsx são aceitos',
        });
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

      // Pick the right sheet for this period type.
      const sheet = period.type === 'DRE' ? parsed.dre : parsed.fc;
      if (!sheet || Object.keys(sheet).length === 0) {
        reply.code(400).send({
          error: 'Bad Request',
          message: `Planilha não contém aba "${period.type}" ou está vazia`,
        });
        return;
      }

      // Funnel the parsed data through the same zod schema /entries uses,
      // so:
      //   1. unknown categories (if the user messed with labels) are
      //      dropped server-side,
      //   2. monthly arrays are bound-checked (we already rounded in
      //      the service but this is defense-in-depth),
      //   3. the type narrows from {category: string} to CategoryKey.
      const rawPayload = {
        entries: Object.entries(sheet)
          .filter(([, monthly]) => Array.isArray(monthly) && monthly.length === 12)
          .map(([category, monthly]) => ({
            category,
            monthly: monthly as number[],
          })),
      };
      const reparsed = UpsertEntriesSchema.safeParse(rawPayload);
      if (!reparsed.success) {
        reply.code(400).send({
          error: 'Bad Request',
          message: reparsed.error.issues[0]?.message ?? 'Conteúdo inválido na planilha',
        });
        return;
      }

      try {
        const result = await upsertEntries(
          request.user!.id,
          request.params.id,
          reparsed.data,
        );
        if (!result) {
          reply.code(404).send({ error: 'Not Found' });
          return;
        }

        // Optional: if the sheet has Metas, upsert them too.
        let metasUpdated = false;
        if (parsed.metas && Object.keys(parsed.metas).length > 0) {
          // Clean up shape (Metas schema expects the optional keys directly).
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
            categoriesImported: result.touched.length,
            metasUpdated,
          },
        });

        reply.send({
          ok: true,
          categoriesImported: result.touched.length,
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
