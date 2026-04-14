/**
 * Meta (annual goals) schemas.
 *
 * One Meta row per Period — tracks the user's annual targets (receita,
 * lucro, margens, ticket, pedidos) so the dashboard can render "meta vs
 * realizado" progress bars.
 *
 * All fields are optional: a user might set only receita + lucro, or
 * only margem bruta. Absent = no goal defined = don't show the bar.
 */
import { z } from 'zod';

const MAX_MONEY = 1_000_000_000_000; // BRL 1 trillion
const MAX_INT = 2_000_000_000;

// Allow null explicitly so clients can CLEAR a previously-set goal by
// sending null (not just omitting the key, which would no-op).
const money = z
  .number()
  .finite()
  .gte(-MAX_MONEY)
  .lte(MAX_MONEY)
  .nullable();

const percent = z
  .number()
  .finite()
  .gte(-1000, 'Porcentagem fora do intervalo permitido')
  .lte(1000, 'Porcentagem fora do intervalo permitido')
  .nullable();

const count = z
  .number()
  .int('Deve ser um número inteiro')
  .gte(0)
  .lte(MAX_INT)
  .nullable();

export const UpsertMetaSchema = z
  .object({
    receitaAnual: money.optional(),
    lucroAnual: money.optional(),
    margemBrutaPct: percent.optional(),
    margemOpPct: percent.optional(),
    margemLiqPct: percent.optional(),
    ticketMedio: money.optional(),
    pedidosMes: count.optional(),
  })
  .strict()
  // At least one field must be present. An empty body is a no-op the
  // client should not be sending.
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Envie ao menos um campo',
  });
export type UpsertMetaInput = z.infer<typeof UpsertMetaSchema>;
