/**
 * PeriodCategory request schemas.
 */
import { z } from 'zod';

export const SectionEnum = z.enum([
  'RECEITA',
  'DEDUCOES',
  'CUSTOS_DIRETOS',
  'DESPESAS_OP',
  'ENTRADAS_FC',
  'SAIDAS_FC',
]);

export const KindEnum = z.enum(['money', 'count']);

const label = z
  .string()
  .trim()
  .min(1, 'Nome é obrigatório')
  .max(120, 'Nome muito longo')
  .regex(/^[\p{L}\p{M}\p{N}\s\-_.,()'&/%°ºª]+$/u, 'Nome contém caracteres inválidos');

export const CreateCategorySchema = z
  .object({
    section: SectionEnum,
    label,
    kind: KindEnum.optional(),
  })
  .strict();
export type CreateCategoryInput = z.infer<typeof CreateCategorySchema>;

export const UpdateCategorySchema = z
  .object({
    label: label.optional(),
    section: SectionEnum.optional(),
    kind: KindEnum.optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Nenhum campo para atualizar',
  });
export type UpdateCategoryInput = z.infer<typeof UpdateCategorySchema>;

const monthValue = z
  .number()
  .finite()
  .gte(-1_000_000_000_000)
  .lte(1_000_000_000_000);

export const UpdateMonthlySchema = z
  .object({
    monthly: z.array(monthValue).length(12, 'Array monthly deve ter 12 valores'),
  })
  .strict();
export type UpdateMonthlyInput = z.infer<typeof UpdateMonthlySchema>;
