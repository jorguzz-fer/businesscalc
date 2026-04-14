/**
 * Entry schemas.
 *
 * An Entry holds ONE category's 12 monthly values for ONE period.
 * Categories are a closed enum — the client cannot invent new ones
 * without a schema change. This matches the v1 SPA which also uses
 * these exact keys.
 *
 * Monthly values are validated:
 *   - length exactly 12 (Jan..Dez)
 *   - each a finite number
 *   - bounded so nobody tries to crash the client UI with 1e308
 *   - truncated to 2 decimals server-side (see service layer)
 */
import { z } from 'zod';

/**
 * All valid category keys. These MUST stay in sync with the DRE_LABELS /
 * FC_EXTRA_LABELS maps used in public/app.html. Both DRE and FC periods
 * reuse the same expense keys; DRE has `deducoes` (tax deductions), FC
 * has the 2 extras `pedidos` and `ticketMedio`. Unused keys for a given
 * period type are simply omitted from the payload (the client doesn't
 * send them; the server treats missing as zero when computing derived).
 */
export const DRE_CATEGORY_KEYS = [
  'receita',
  'deducoes',
  'cmv',
  'outrosCustos',
  'equipamentos',
  'provisao',
  'pessoal',
  'beneficios',
  'inss',
  'proLabore',
  'ferias',
  'aluguel',
  'marketing',
  'ti',
  'diversas',
  'manutPredial',
  'exames',
  'despFin',
] as const;

export const FC_EXTRA_CATEGORY_KEYS = ['pedidos', 'ticketMedio'] as const;

export const ALL_CATEGORY_KEYS = [
  ...DRE_CATEGORY_KEYS,
  ...FC_EXTRA_CATEGORY_KEYS,
] as const;

export type CategoryKey = (typeof ALL_CATEGORY_KEYS)[number];

const CategoryEnum = z.enum(ALL_CATEGORY_KEYS);

// 1e12 = BRL 1 trillion; larger than any real business number and still
// safely within IEEE-754 double precision so we don't lose cents.
const MAX_VALUE = 1_000_000_000_000;

const monthValue = z
  .number({ invalid_type_error: 'Valor mensal deve ser numérico' })
  .finite('Valor mensal inválido (NaN/Infinity)')
  .gte(-MAX_VALUE, 'Valor fora do intervalo permitido')
  .lte(MAX_VALUE, 'Valor fora do intervalo permitido');

const monthlyArray = z
  .array(monthValue)
  .length(12, 'Array monthly deve ter exatamente 12 valores (Jan..Dez)');

const entry = z
  .object({
    category: CategoryEnum,
    monthly: monthlyArray,
  })
  .strict();

/**
 * PUT /api/periods/:id/entries body.
 *
 * Replaces ALL entries for the period: categories NOT present in the
 * payload will be deleted from the DB (empty rows). This matches the
 * autosave UX — the client always sends the current full state.
 */
export const UpsertEntriesSchema = z
  .object({
    entries: z
      .array(entry)
      .max(ALL_CATEGORY_KEYS.length, 'Muitas categorias no payload'),
  })
  .strict();
export type UpsertEntriesInput = z.infer<typeof UpsertEntriesSchema>;
