/**
 * "Entries" view layer over PeriodCategory.
 *
 * Fase 1.5 collapsed Entry into PeriodCategory: each row IS a category,
 * with its own monthly array. This module keeps the existing
 * /api/periods/:id/entries shape (entries: { key: monthly }) so the v1
 * SPA renderers and the period-loader UI keep working unchanged.
 *
 * Key changes vs old design:
 *   - The "key" used in the entries map is now the PeriodCategory.id
 *     (UUID), not the legacy enum string. Frontend already passes ids
 *     for autosave by category. The dashboard renderer indexes by
 *     section + label/order to render the right cells.
 *   - Computed values group by section (RECEITA, CUSTOS_DIRETOS, etc)
 *     instead of by hardcoded category keys, so custom user-added items
 *     contribute to their section's total automatically.
 *   - Bulk PUT (replace-all entries) is no longer needed; autosave now
 *     hits PATCH /api/categories/:id which writes a single row.
 *     This module retains a simpler bulk variant for the XLSX upload
 *     path that imports many rows at once.
 */
import { Prisma, type CategorySection, type PeriodCategory } from '@prisma/client';
import { prisma } from '../db.js';
import { seedDefaults } from './periodCategory.service.js';

export type MonthlyArray = [
  number, number, number, number, number, number,
  number, number, number, number, number, number,
];

const zeroMonthly = (): MonthlyArray => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function readMonthly(value: unknown): MonthlyArray {
  if (!Array.isArray(value) || value.length !== 12) return zeroMonthly();
  const out = zeroMonthly();
  for (let i = 0; i < 12; i++) {
    const v = value[i];
    out[i] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }
  return out;
}

function roundMonthly(arr: number[]): MonthlyArray {
  const out = zeroMonthly();
  for (let i = 0; i < 12; i++) {
    const v = arr[i] ?? 0;
    out[i] = Math.round(v * 100) / 100;
  }
  return out;
}

/**
 * GET shape for /api/periods/:id/entries.
 * `categories` is the ordered list as the user defined it; the v1 renderer
 * indexes by `section` to compute group totals client-side.
 * `computed` is server-authoritative and STILL the source of truth.
 */
export type EntriesView = {
  periodType: 'DRE' | 'FC';
  categories: Array<{
    id: string;
    section: CategorySection;
    label: string;
    kind: string;
    sortOrder: number;
    isSystem: boolean;
    monthly: MonthlyArray;
  }>;
};

export async function getByPeriod(
  userId: string,
  periodId: string,
): Promise<EntriesView | null> {
  const period = await prisma.period.findFirst({
    where: { id: periodId, userId },
    select: {
      id: true,
      type: true,
      categories: {
        orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
    },
  });
  if (!period) return null;
  // Lazy seed: legacy periods that predate Fase 1.5 (or any period
  // that lost all categories) get the defaults restored on first read.
  // seedDefaults is idempotent inside.
  let categories = period.categories;
  if (categories.length === 0) {
    await prisma.$transaction(async (tx) => {
      await seedDefaults(tx, period.id, period.type);
    });
    categories = await prisma.periodCategory.findMany({
      where: { periodId: period.id },
      orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }
  return {
    periodType: period.type,
    categories: categories.map((c: PeriodCategory) => ({
      id: c.id,
      section: c.section,
      label: c.label,
      kind: c.kind,
      sortOrder: c.sortOrder,
      isSystem: c.isSystem,
      monthly: readMonthly(c.monthly),
    })),
  };
}

/**
 * Bulk replace monthly arrays by category id. Used by XLSX upload path
 * which can update many rows at once.
 *
 * Categories not mentioned in `updates` are left untouched.
 * IDs not belonging to the period are skipped silently (defense in depth
 * against id-spoofing — even if a malicious payload lists another period's
 * category id, it has no effect because the where filter scopes to this
 * period).
 */
export async function bulkUpdateMonthly(
  userId: string,
  periodId: string,
  updates: Array<{ categoryId: string; monthly: number[] }>,
): Promise<{ updated: number } | null> {
  const period = await prisma.period.findFirst({
    where: { id: periodId, userId },
    select: { id: true, status: true },
  });
  if (!period) return null;
  if (period.status === 'FINALIZED') {
    throw new PeriodFinalizedError();
  }

  // Resolve which ids actually belong to this period (anti id-spoofing).
  const validIds = new Set(
    (
      await prisma.periodCategory.findMany({
        where: { periodId: period.id, id: { in: updates.map((u) => u.categoryId) } },
        select: { id: true },
      })
    ).map((c) => c.id),
  );

  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const u of updates) {
      if (!validIds.has(u.categoryId)) continue;
      const monthly = roundMonthly(u.monthly);
      await tx.periodCategory.update({
        where: { id: u.categoryId },
        data: { monthly: monthly as unknown as Prisma.InputJsonValue },
      });
      updated++;
    }
  });
  return { updated };
}

export class PeriodFinalizedError extends Error {
  constructor() {
    super('Período finalizado não pode ser editado');
    this.name = 'PeriodFinalizedError';
  }
}

// ======================================================================
// Derived value computation — section-based, dynamic.
// ======================================================================

const sumPerMonth = (arrays: MonthlyArray[]): MonthlyArray => {
  const out = zeroMonthly();
  for (const a of arrays) for (let i = 0; i < 12; i++) out[i] += a[i] ?? 0;
  return out;
};

const subPerMonth = (a: MonthlyArray, b: MonthlyArray): MonthlyArray => {
  const out = zeroMonthly();
  for (let i = 0; i < 12; i++) out[i] = (a[i] ?? 0) - (b[i] ?? 0);
  return out;
};

const sumYear = (a: MonthlyArray): number => a.reduce((s, v) => s + (v ?? 0), 0);

function bySection(view: EntriesView): Record<CategorySection, MonthlyArray[]> {
  const out: Record<string, MonthlyArray[]> = {
    RECEITA: [], DEDUCOES: [], CUSTOS_DIRETOS: [], DESPESAS_OP: [],
    ENTRADAS_FC: [], SAIDAS_FC: [],
  };
  for (const c of view.categories) {
    out[c.section].push(c.monthly);
  }
  return out as Record<CategorySection, MonthlyArray[]>;
}

export type DREComputed = {
  receita: MonthlyArray;
  deducoes: MonthlyArray;
  receitaLiquida: MonthlyArray;
  custosDiretos: MonthlyArray;
  lucroBruto: MonthlyArray;
  despesasOperacionais: MonthlyArray;
  resultadoLiquido: MonthlyArray;
  margemBrutaMensal: MonthlyArray;
  margemLiquidaMensal: MonthlyArray;
  totalReceita: number;
  totalLucroBruto: number;
  totalResultado: number;
  margemBrutaAnual: number;
  margemLiquidaAnual: number;
};

export function computeDRE(view: EntriesView): DREComputed {
  const sec = bySection(view);
  const receita = sumPerMonth(sec.RECEITA);
  const deducoes = sumPerMonth(sec.DEDUCOES);
  const receitaLiquida = subPerMonth(receita, deducoes);
  const custosDiretos = sumPerMonth(sec.CUSTOS_DIRETOS);
  const lucroBruto = subPerMonth(receitaLiquida, custosDiretos);
  const despesasOperacionais = sumPerMonth(sec.DESPESAS_OP);
  const resultadoLiquido = subPerMonth(lucroBruto, despesasOperacionais);

  const margemBrutaMensal = receita.map((v, i) =>
    v > 0 ? ((lucroBruto[i] ?? 0) / v) * 100 : 0,
  ) as MonthlyArray;
  const margemLiquidaMensal = receita.map((v, i) =>
    v > 0 ? ((resultadoLiquido[i] ?? 0) / v) * 100 : 0,
  ) as MonthlyArray;

  const totalReceita = sumYear(receita);
  const totalLucroBruto = sumYear(lucroBruto);
  const totalResultado = sumYear(resultadoLiquido);
  return {
    receita, deducoes, receitaLiquida, custosDiretos, lucroBruto,
    despesasOperacionais, resultadoLiquido,
    margemBrutaMensal, margemLiquidaMensal,
    totalReceita, totalLucroBruto, totalResultado,
    margemBrutaAnual: totalReceita > 0 ? (totalLucroBruto / totalReceita) * 100 : 0,
    margemLiquidaAnual: totalReceita > 0 ? (totalResultado / totalReceita) * 100 : 0,
  };
}

export type FCComputed = {
  entradas: MonthlyArray;
  saidas: MonthlyArray;
  saldo: MonthlyArray;
  totalEntradasAno: number;
  totalSaidasAno: number;
  saldoAno: number;
};

export function computeFC(view: EntriesView): FCComputed {
  const sec = bySection(view);
  // For FC, "entradas" total comes from Receita line(s) inside ENTRADAS_FC.
  // pedidos/ticketMedio are also in ENTRADAS_FC but kind=count/money for
  // display only — they're NOT summed into the cash flow total.
  // Heuristic: only categories with kind='money' AND label containing
  // "receita"/"vendas" count as cash inflows. Custom user-added inflow
  // items just need to be kept money-kind to count.
  // Simpler rule: SUM all money-kind in ENTRADAS_FC (so a custom money
  // line "Outras receitas" in entradas counts as inflow), exclude count
  // kind (pedidos doesn't add to BRL inflow).
  const entradasArrays = view.categories
    .filter((c) => c.section === 'ENTRADAS_FC' && c.kind === 'money')
    // ticketMedio is informational, not an actual cash inflow.
    .filter((c) => !/ticket\s*m[eé]dio/i.test(c.label))
    .map((c) => c.monthly);
  const entradas = sumPerMonth(entradasArrays);
  const saidas = sumPerMonth(sec.SAIDAS_FC);
  const saldo = subPerMonth(entradas, saidas);
  return {
    entradas, saidas, saldo,
    totalEntradasAno: sumYear(entradas),
    totalSaidasAno: sumYear(saidas),
    saldoAno: sumYear(saldo),
  };
}
