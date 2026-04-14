/**
 * Request body schemas for /api/periods/* endpoints.
 *
 * All schemas use .strict() to reject extra fields — defeats mass
 * assignment attempts where a client tries to set userId, id, createdAt,
 * or any other privileged field we don't explicitly allow.
 *
 * The `type` enum is a string match (DRE|FC) since Prisma's generated
 * enum constants can't be used in a zod schema directly without
 * unnecessary coupling.
 */
import { z } from 'zod';

export const PeriodType = z.enum(['DRE', 'FC']);
export type PeriodTypeT = z.infer<typeof PeriodType>;

export const PeriodStatus = z.enum(['DRAFT', 'FINALIZED']);
export type PeriodStatusT = z.infer<typeof PeriodStatus>;

const name = z
  .string()
  .trim()
  .min(1, 'Nome é obrigatório')
  .max(80, 'Nome muito longo')
  // Printable characters only; blocks \r\n injection into any future log
  // or audit line. Allows accented Latin letters, numbers, whitespace,
  // and common business-name punctuation: apostrophe, ampersand, slash
  // (e.g. "Bob's DRE", "Johnson & Co", "2024/Q1").
  // Explicitly forbidden: <>, quotes (defense-in-depth against HTML/attr
  // injection even though we textContent everywhere), null byte, control chars.
  .regex(/^[\p{L}\p{M}\p{N}\s\-_.,()'&/]+$/u, 'Nome contém caracteres inválidos');

const year = z
  .number()
  .int('Ano deve ser inteiro')
  .min(1990, 'Ano muito antigo')
  .max(2100, 'Ano muito futuro');

export const CreatePeriodSchema = z
  .object({
    name,
    year,
    type: PeriodType,
  })
  .strict();
export type CreatePeriodInput = z.infer<typeof CreatePeriodSchema>;

// PUT allows updating name/status/year but NEVER type (that would corrupt
// existing entries) and NEVER userId (ownership transfer must be explicit,
// not via an API we don't expose).
export const UpdatePeriodSchema = z
  .object({
    name: name.optional(),
    year: year.optional(),
    status: PeriodStatus.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Nenhum campo para atualizar',
  });
export type UpdatePeriodInput = z.infer<typeof UpdatePeriodSchema>;

export const ListPeriodsQuerySchema = z
  .object({
    type: PeriodType.optional(),
  })
  .strict();
