/**
 * /api/periods/* routes.
 *
 * Every route below uses `requireAuth` which:
 *   - validates session cookie
 *   - enforces CSRF on POST/PUT/DELETE
 *   - populates request.user
 *
 * Responses never include userId in the payload — the client already knows
 * who they are (it's in /api/auth/me). Leaking it would add nothing and
 * makes accidental cross-user references slightly more likely in the UI.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  CreatePeriodSchema,
  UpdatePeriodSchema,
  ListPeriodsQuerySchema,
} from '../schemas/period.schema.js';
import * as periodSvc from '../services/period.service.js';
import * as audit from '../services/audit.service.js';
import { requireAuth } from '../middleware/requireAuth.js';

function ipOf(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  return (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ?? request.ip;
}

function sanitize(p: {
  id: string;
  name: string;
  year: number;
  type: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  // Shape the API response. userId stays server-side.
  return {
    id: p.id,
    name: p.name,
    year: p.year,
    type: p.type,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function periodRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /api/periods?type=DRE|FC ----------
  app.get(
    '/api/periods',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = ListPeriodsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Bad Request', message: 'Parâmetros inválidos' });
        return;
      }
      const periods = await periodSvc.list(request.user!.id, parsed.data);
      reply.send({ periods: periods.map(sanitize) });
    },
  );

  // ---------- POST /api/periods ----------
  app.post(
    '/api/periods',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = CreatePeriodSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Bad Request', message: parsed.error.issues[0]?.message ?? 'Entrada inválida' });
        return;
      }
      try {
        const period = await periodSvc.create(request.user!.id, parsed.data);
        audit.log({
          userId: request.user!.id,
          action: 'period.create',
          resource: `Period:${period.id}`,
          ip: ipOf(request),
          userAgent: request.headers['user-agent'],
          metadata: { name: parsed.data.name, year: parsed.data.year, type: parsed.data.type },
        });
        reply.code(201).send(sanitize(period));
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          reply.code(409).send({
            error: 'Conflict',
            message: 'Já existe um período com esse nome e tipo',
          });
          return;
        }
        throw err;
      }
    },
  );

  // ---------- GET /api/periods/:id ----------
  app.get<{ Params: { id: string } }>(
    '/api/periods/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const period = await periodSvc.get(request.user!.id, request.params.id);
      if (!period) {
        // 404 not 403 — don't leak whether the period exists under another owner.
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      reply.send(sanitize(period));
    },
  );

  // ---------- PUT /api/periods/:id ----------
  app.put<{ Params: { id: string } }>(
    '/api/periods/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = UpdatePeriodSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Bad Request', message: parsed.error.issues[0]?.message ?? 'Entrada inválida' });
        return;
      }
      try {
        const period = await periodSvc.update(request.user!.id, request.params.id, parsed.data);
        if (!period) {
          reply.code(404).send({ error: 'Not Found' });
          return;
        }
        audit.log({
          userId: request.user!.id,
          action: 'period.update',
          resource: `Period:${period.id}`,
          ip: ipOf(request),
          userAgent: request.headers['user-agent'],
          metadata: parsed.data,
        });
        reply.send(sanitize(period));
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          reply.code(409).send({
            error: 'Conflict',
            message: 'Já existe um período com esse nome e tipo',
          });
          return;
        }
        throw err;
      }
    },
  );

  // ---------- DELETE /api/periods/:id ----------
  app.delete<{ Params: { id: string } }>(
    '/api/periods/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const ok = await periodSvc.remove(request.user!.id, request.params.id);
      if (!ok) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      audit.log({
        userId: request.user!.id,
        action: 'period.delete',
        resource: `Period:${request.params.id}`,
        ip: ipOf(request),
        userAgent: request.headers['user-agent'],
      });
      reply.code(204).send();
    },
  );
}
