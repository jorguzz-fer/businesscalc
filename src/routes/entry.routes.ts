/**
 * /api/periods/:id/entries
 *
 * GET   -> { periodType, categories: [...], computed }
 *          where each category includes id, section, label, kind, monthly.
 *          The frontend uses categories[].id for autosave PATCHes.
 *
 * The legacy bulk PUT shape (entries: [{category, monthly}]) is gone:
 * autosave now hits PATCH /api/categories/:id/monthly directly. The
 * XLSX upload path also calls bulkUpdateMonthly internally with category
 * IDs it resolves from labels.
 */
import type { FastifyInstance } from 'fastify';
import {
  getByPeriod,
  computeDRE,
  computeFC,
} from '../services/entry.service.js';
import { requireAuth } from '../middleware/requireAuth.js';

export async function entryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/periods/:id/entries',
    { preHandler: requireAuth },
    async (request, reply) => {
      const view = await getByPeriod(request.user!.id, request.params.id);
      if (!view) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      const computed =
        view.periodType === 'DRE' ? computeDRE(view) : computeFC(view);
      reply.send({
        periodId: request.params.id,
        periodType: view.periodType,
        categories: view.categories,
        computed,
      });
    },
  );
}
