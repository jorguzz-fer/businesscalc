/**
 * /api/periods/:id/entries routes.
 *
 * GET returns raw entries AND server-computed derived values (receitaLiq,
 * lucroBruto, margens, etc). The client uses the derived values for
 * dashboards without having to recompute — and even if it did, the
 * server value is authoritative.
 *
 * PUT replaces all entries in one go (autosave pattern).
 *
 * Both require auth; PUT also enforces CSRF via requireAuth middleware.
 * IDOR protection: a user who doesn't own the period gets 404.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UpsertEntriesSchema } from '../schemas/entry.schema.js';
import {
  getByPeriod,
  upsertForPeriod,
  computeDRE,
  computeFC,
  PeriodFinalizedError,
} from '../services/entry.service.js';
import * as audit from '../services/audit.service.js';
import { requireAuth } from '../middleware/requireAuth.js';

function ipOf(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  return (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ?? request.ip;
}

export async function entryRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /api/periods/:id/entries ----------
  app.get<{ Params: { id: string } }>(
    '/api/periods/:id/entries',
    { preHandler: requireAuth },
    async (request, reply) => {
      const found = await getByPeriod(request.user!.id, request.params.id);
      if (!found) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      const computed =
        found.periodType === 'DRE' ? computeDRE(found.entries) : computeFC(found.entries);
      reply.send({
        periodId: request.params.id,
        periodType: found.periodType,
        entries: found.entries,
        computed,
      });
    },
  );

  // ---------- PUT /api/periods/:id/entries ----------
  app.put<{ Params: { id: string } }>(
    '/api/periods/:id/entries',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = UpsertEntriesSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message ?? 'Entrada inválida',
        });
        return;
      }
      try {
        const result = await upsertForPeriod(
          request.user!.id,
          request.params.id,
          parsed.data,
        );
        if (!result) {
          reply.code(404).send({ error: 'Not Found' });
          return;
        }
        audit.log({
          userId: request.user!.id,
          action: 'period.entries.update',
          resource: `Period:${request.params.id}`,
          ip: ipOf(request),
          userAgent: request.headers['user-agent'],
          // Only the names of touched categories, never monetary values.
          metadata: { categoriesTouched: result.touched, count: result.touched.length },
        });
        // Return the fresh view so the client sees the authoritative
        // computed numbers without a second request.
        const updated = await getByPeriod(request.user!.id, request.params.id);
        if (!updated) {
          reply.code(404).send({ error: 'Not Found' });
          return;
        }
        const computed =
          updated.periodType === 'DRE'
            ? computeDRE(updated.entries)
            : computeFC(updated.entries);
        reply.send({
          periodId: request.params.id,
          periodType: updated.periodType,
          entries: updated.entries,
          computed,
        });
      } catch (err) {
        if (err instanceof PeriodFinalizedError) {
          reply.code(409).send({
            error: 'Conflict',
            message: 'Período finalizado não pode ser editado',
          });
          return;
        }
        throw err;
      }
    },
  );
}
