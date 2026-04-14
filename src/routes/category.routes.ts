/**
 * /api/periods/:id/categories  + /api/categories/:id
 *
 * GET    /api/periods/:id/categories          list (auth + ownership)
 * POST   /api/periods/:id/categories          create new (CSRF)
 * PATCH  /api/categories/:id                  rename / move section / sort
 * PATCH  /api/categories/:id/monthly          autosave a single row
 * DELETE /api/categories/:id                  remove (system or custom)
 *
 * IDOR is enforced inside each service method by chaining the period
 * ownership through the category. Routes return 404 when not found OR
 * not owned (anti-enumeration).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CreateCategorySchema,
  UpdateCategorySchema,
  UpdateMonthlySchema,
} from '../schemas/category.schema.js';
import {
  listForPeriod,
  createCategory,
  updateCategory,
  updateMonthly,
  deleteCategory,
  CategoryFinalizedError,
} from '../services/periodCategory.service.js';
import * as audit from '../services/audit.service.js';
import { requireAuth } from '../middleware/requireAuth.js';

function ipOf(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  return (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ?? request.ip;
}

function safeMeta(request: FastifyRequest) {
  return { ip: ipOf(request), userAgent: request.headers['user-agent'] };
}

function toResponse(c: {
  id: string; section: string; label: string; kind: string;
  sortOrder: number; isSystem: boolean; monthly: unknown;
}) {
  return {
    id: c.id,
    section: c.section,
    label: c.label,
    kind: c.kind,
    sortOrder: c.sortOrder,
    isSystem: c.isSystem,
    monthly: Array.isArray(c.monthly) ? c.monthly : null,
  };
}

export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /api/periods/:id/categories ----------
  app.get<{ Params: { id: string } }>(
    '/api/periods/:id/categories',
    { preHandler: requireAuth },
    async (request, reply) => {
      const cats = await listForPeriod(request.user!.id, request.params.id);
      if (!cats) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      reply.send({ categories: cats.map(toResponse) });
    },
  );

  // ---------- POST /api/periods/:id/categories ----------
  app.post<{ Params: { id: string } }>(
    '/api/periods/:id/categories',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = CreateCategorySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message ?? 'Entrada inválida',
        });
        return;
      }
      try {
        const cat = await createCategory(request.user!.id, request.params.id, parsed.data);
        if (!cat) {
          reply.code(404).send({ error: 'Not Found' });
          return;
        }
        audit.log({
          userId: request.user!.id,
          action: 'category.create',
          resource: `Category:${cat.id}`,
          ...safeMeta(request),
          metadata: { section: parsed.data.section, label: parsed.data.label },
        });
        reply.code(201).send(toResponse(cat));
      } catch (err) {
        if (err instanceof CategoryFinalizedError) {
          reply.code(409).send({ error: 'Conflict', message: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ---------- PATCH /api/categories/:id ----------
  app.patch<{ Params: { id: string } }>(
    '/api/categories/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = UpdateCategorySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message ?? 'Entrada inválida',
        });
        return;
      }
      try {
        const cat = await updateCategory(request.user!.id, request.params.id, parsed.data);
        if (!cat) {
          reply.code(404).send({ error: 'Not Found' });
          return;
        }
        audit.log({
          userId: request.user!.id,
          action: 'category.update',
          resource: `Category:${cat.id}`,
          ...safeMeta(request),
          metadata: { fieldsSet: Object.keys(parsed.data) },
        });
        reply.send(toResponse(cat));
      } catch (err) {
        if (err instanceof CategoryFinalizedError) {
          reply.code(409).send({ error: 'Conflict', message: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ---------- PATCH /api/categories/:id/monthly ----------
  app.patch<{ Params: { id: string } }>(
    '/api/categories/:id/monthly',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = UpdateMonthlySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message ?? 'Entrada inválida',
        });
        return;
      }
      try {
        const cat = await updateMonthly(request.user!.id, request.params.id, parsed.data.monthly);
        if (!cat) {
          reply.code(404).send({ error: 'Not Found' });
          return;
        }
        // Money values omitted from audit by design.
        audit.log({
          userId: request.user!.id,
          action: 'category.monthly.update',
          resource: `Category:${cat.id}`,
          ...safeMeta(request),
        });
        reply.send(toResponse(cat));
      } catch (err) {
        if (err instanceof CategoryFinalizedError) {
          reply.code(409).send({ error: 'Conflict', message: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ---------- DELETE /api/categories/:id ----------
  app.delete<{ Params: { id: string } }>(
    '/api/categories/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const ok = await deleteCategory(request.user!.id, request.params.id);
        if (!ok) {
          reply.code(404).send({ error: 'Not Found' });
          return;
        }
        audit.log({
          userId: request.user!.id,
          action: 'category.delete',
          resource: `Category:${request.params.id}`,
          ...safeMeta(request),
        });
        reply.code(204).send();
      } catch (err) {
        if (err instanceof CategoryFinalizedError) {
          reply.code(409).send({ error: 'Conflict', message: err.message });
          return;
        }
        throw err;
      }
    },
  );
}
