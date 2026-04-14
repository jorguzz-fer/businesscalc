/**
 * /api/periods/:id/meta routes.
 *
 * GET  -> retrieves the annual goals (or all-null when none set)
 * PUT  -> upserts any subset of goal fields
 *
 * Both require auth. PUT enforces CSRF. IDOR: 404 when the period isn't
 * owned or doesn't exist.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UpsertMetaSchema } from '../schemas/meta.schema.js';
import {
  getByPeriod,
  upsertForPeriod,
  MetaFinalizedError,
} from '../services/meta.service.js';
import * as audit from '../services/audit.service.js';
import { requireAuth } from '../middleware/requireAuth.js';

function ipOf(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  return (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ?? request.ip;
}

export async function metaRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/periods/:id/meta',
    { preHandler: requireAuth },
    async (request, reply) => {
      const meta = await getByPeriod(request.user!.id, request.params.id);
      if (!meta) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      reply.send(meta);
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/periods/:id/meta',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = UpsertMetaSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message ?? 'Entrada inválida',
        });
        return;
      }
      try {
        const meta = await upsertForPeriod(
          request.user!.id,
          request.params.id,
          parsed.data,
        );
        if (!meta) {
          reply.code(404).send({ error: 'Not Found' });
          return;
        }
        audit.log({
          userId: request.user!.id,
          action: 'period.meta.update',
          resource: `Period:${request.params.id}`,
          ip: ipOf(request),
          userAgent: request.headers['user-agent'],
          // Record which fields were touched, not their values (financial).
          metadata: { fieldsSet: Object.keys(parsed.data) },
        });
        reply.send(meta);
      } catch (err) {
        if (err instanceof MetaFinalizedError) {
          reply.code(409).send({
            error: 'Conflict',
            message: err.message,
          });
          return;
        }
        throw err;
      }
    },
  );
}
