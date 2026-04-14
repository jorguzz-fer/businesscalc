/**
 * PeriodCategory service.
 *
 * Each period has a list of categories grouped by `section`. The section
 * determines the mathematical role (RECEITA, DEDUCOES, CUSTOS_DIRETOS,
 * DESPESAS_OP for DRE; ENTRADAS_FC, SAIDAS_FC for FC). The `label` is
 * free text the user can edit.
 *
 * isSystem distinguishes the categories created by seedDefaults() from
 * user-added custom items. Per the user's spec, EITHER kind can be
 * renamed or deleted — isSystem is informational only (UI may show a
 * subtle indicator).
 *
 * Computed values (lucroBruto, margens, etc) are derived from grouping
 * categories by section and summing their monthly arrays. So a custom
 * item added to CUSTOS_DIRETOS automatically counts toward Lucro Bruto.
 */
import { Prisma, type CategorySection, type PeriodCategory, type PeriodType } from '@prisma/client';
import { prisma } from '../db.js';

export type DefaultCategorySpec = {
  section: CategorySection;
  label: string;
  kind: 'money' | 'count';
  sortOrder: number;
};

/**
 * Default seed categories for a DRE period — the 18 line items the v1
 * SPA had hardcoded. Sort order leaves gaps (10/20/30...) so users can
 * insert custom items between them later without rewriting all rows.
 */
export const DRE_DEFAULTS: DefaultCategorySpec[] = [
  { section: 'RECEITA', label: 'Receita de Vendas', kind: 'money', sortOrder: 10 },
  { section: 'DEDUCOES', label: 'Deduções e Impostos', kind: 'money', sortOrder: 10 },
  { section: 'CUSTOS_DIRETOS', label: 'CMV / Logística', kind: 'money', sortOrder: 10 },
  { section: 'CUSTOS_DIRETOS', label: 'Outros Custos Diretos', kind: 'money', sortOrder: 20 },
  { section: 'CUSTOS_DIRETOS', label: 'Equipamentos', kind: 'money', sortOrder: 30 },
  { section: 'CUSTOS_DIRETOS', label: 'Provisão Manutenção', kind: 'money', sortOrder: 40 },
  { section: 'DESPESAS_OP', label: 'Pessoal (Salários CLT)', kind: 'money', sortOrder: 10 },
  { section: 'DESPESAS_OP', label: 'Benefícios', kind: 'money', sortOrder: 20 },
  { section: 'DESPESAS_OP', label: 'INSS / FGTS', kind: 'money', sortOrder: 30 },
  { section: 'DESPESAS_OP', label: 'Pró-Labore', kind: 'money', sortOrder: 40 },
  { section: 'DESPESAS_OP', label: 'Férias / 13°', kind: 'money', sortOrder: 50 },
  { section: 'DESPESAS_OP', label: 'Aluguel', kind: 'money', sortOrder: 60 },
  { section: 'DESPESAS_OP', label: 'Marketing', kind: 'money', sortOrder: 70 },
  { section: 'DESPESAS_OP', label: 'TI / Tecnologia', kind: 'money', sortOrder: 80 },
  { section: 'DESPESAS_OP', label: 'Despesas Diversas', kind: 'money', sortOrder: 90 },
  { section: 'DESPESAS_OP', label: 'Manutenção Predial', kind: 'money', sortOrder: 100 },
  { section: 'DESPESAS_OP', label: 'Exames / Saúde', kind: 'money', sortOrder: 110 },
  { section: 'DESPESAS_OP', label: 'Despesas Financeiras', kind: 'money', sortOrder: 120 },
];

/**
 * Default seed categories for a FC period.
 */
export const FC_DEFAULTS: DefaultCategorySpec[] = [
  { section: 'ENTRADAS_FC', label: 'Nº de Pedidos', kind: 'count', sortOrder: 10 },
  { section: 'ENTRADAS_FC', label: 'Ticket Médio', kind: 'money', sortOrder: 20 },
  { section: 'ENTRADAS_FC', label: 'Receita de Vendas', kind: 'money', sortOrder: 30 },
  { section: 'SAIDAS_FC', label: 'CMV / Logística', kind: 'money', sortOrder: 10 },
  { section: 'SAIDAS_FC', label: 'Outros Custos Diretos', kind: 'money', sortOrder: 20 },
  { section: 'SAIDAS_FC', label: 'Equipamentos', kind: 'money', sortOrder: 30 },
  { section: 'SAIDAS_FC', label: 'Provisão Manutenção', kind: 'money', sortOrder: 40 },
  { section: 'SAIDAS_FC', label: 'Pessoal (Salários CLT)', kind: 'money', sortOrder: 50 },
  { section: 'SAIDAS_FC', label: 'Benefícios', kind: 'money', sortOrder: 60 },
  { section: 'SAIDAS_FC', label: 'INSS / FGTS', kind: 'money', sortOrder: 70 },
  { section: 'SAIDAS_FC', label: 'Pró-Labore', kind: 'money', sortOrder: 80 },
  { section: 'SAIDAS_FC', label: 'Férias / 13°', kind: 'money', sortOrder: 90 },
  { section: 'SAIDAS_FC', label: 'Aluguel', kind: 'money', sortOrder: 100 },
  { section: 'SAIDAS_FC', label: 'Marketing', kind: 'money', sortOrder: 110 },
  { section: 'SAIDAS_FC', label: 'TI / Tecnologia', kind: 'money', sortOrder: 120 },
  { section: 'SAIDAS_FC', label: 'Despesas Diversas', kind: 'money', sortOrder: 130 },
  { section: 'SAIDAS_FC', label: 'Manutenção Predial', kind: 'money', sortOrder: 140 },
  { section: 'SAIDAS_FC', label: 'Exames / Saúde', kind: 'money', sortOrder: 150 },
  { section: 'SAIDAS_FC', label: 'Despesas Financeiras', kind: 'money', sortOrder: 160 },
];

/**
 * Insert seed categories for a brand-new period. Idempotent: if the period
 * already has categories, this is a no-op (we never overwrite user data).
 *
 * Called from period.service.create() within the same transaction so a
 * partial seed never persists.
 */
export async function seedDefaults(
  tx: Prisma.TransactionClient,
  periodId: string,
  type: PeriodType,
): Promise<void> {
  const existing = await tx.periodCategory.count({ where: { periodId } });
  if (existing > 0) return;

  const defaults = type === 'DRE' ? DRE_DEFAULTS : FC_DEFAULTS;
  await tx.periodCategory.createMany({
    data: defaults.map((d) => ({
      periodId,
      section: d.section,
      label: d.label,
      kind: d.kind,
      sortOrder: d.sortOrder,
      isSystem: true,
      monthly: Prisma.JsonNull,
    })),
  });
}

/**
 * List categories for a period — but only if the period belongs to user.
 * Returns null when not found / not owned (route -> 404).
 */
export async function listForPeriod(
  userId: string,
  periodId: string,
): Promise<PeriodCategory[] | null> {
  const period = await prisma.period.findFirst({
    where: { id: periodId, userId },
    select: { id: true },
  });
  if (!period) return null;
  return prisma.periodCategory.findMany({
    where: { periodId: period.id },
    orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

export type CreateCategoryInput = {
  section: CategorySection;
  label: string;
  kind?: 'money' | 'count';
};

export async function createCategory(
  userId: string,
  periodId: string,
  input: CreateCategoryInput,
): Promise<PeriodCategory | null> {
  return prisma.$transaction(async (tx) => {
    const period = await tx.period.findFirst({
      where: { id: periodId, userId },
      select: { id: true, status: true },
    });
    if (!period) return null;
    if (period.status === 'FINALIZED') {
      throw new CategoryFinalizedError();
    }
    // Place new category at the bottom of its section.
    const last = await tx.periodCategory.findFirst({
      where: { periodId: period.id, section: input.section },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const sortOrder = (last?.sortOrder ?? 0) + 10;
    return tx.periodCategory.create({
      data: {
        periodId: period.id,
        section: input.section,
        label: input.label,
        kind: input.kind ?? 'money',
        sortOrder,
        isSystem: false,
      },
    });
  });
}

export type UpdateCategoryInput = {
  label?: string;
  // Section change is allowed but rare — moves the item between buckets
  // (e.g. demoting CMV from CUSTOS_DIRETOS to DESPESAS_OP).
  section?: CategorySection;
  kind?: 'money' | 'count';
  sortOrder?: number;
};

export async function updateCategory(
  userId: string,
  categoryId: string,
  input: UpdateCategoryInput,
): Promise<PeriodCategory | null> {
  return prisma.$transaction(async (tx) => {
    // Resolve the category and verify ownership chain in one query.
    const cat = await tx.periodCategory.findFirst({
      where: { id: categoryId, period: { userId } },
      include: { period: { select: { status: true } } },
    });
    if (!cat) return null;
    if (cat.period.status === 'FINALIZED') {
      throw new CategoryFinalizedError();
    }
    const data: Prisma.PeriodCategoryUpdateInput = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.section !== undefined) data.section = input.section;
    if (input.kind !== undefined) data.kind = input.kind;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (Object.keys(data).length === 0) return cat;
    return tx.periodCategory.update({ where: { id: cat.id }, data });
  });
}

/**
 * Replace the monthly array on a single category. Returns false on
 * ownership/finalize failures (route -> 404 or 409).
 */
export async function updateMonthly(
  userId: string,
  categoryId: string,
  monthly: number[],
): Promise<PeriodCategory | null> {
  return prisma.$transaction(async (tx) => {
    const cat = await tx.periodCategory.findFirst({
      where: { id: categoryId, period: { userId } },
      include: { period: { select: { status: true } } },
    });
    if (!cat) return null;
    if (cat.period.status === 'FINALIZED') {
      throw new CategoryFinalizedError();
    }
    return tx.periodCategory.update({
      where: { id: cat.id },
      data: { monthly: monthly as unknown as Prisma.InputJsonValue },
    });
  });
}

export async function deleteCategory(
  userId: string,
  categoryId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const cat = await tx.periodCategory.findFirst({
      where: { id: categoryId, period: { userId } },
      include: { period: { select: { status: true } } },
    });
    if (!cat) return false;
    if (cat.period.status === 'FINALIZED') {
      throw new CategoryFinalizedError();
    }
    await tx.periodCategory.delete({ where: { id: cat.id } });
    return true;
  });
}

export class CategoryFinalizedError extends Error {
  constructor() {
    super('Período finalizado não pode ser editado');
    this.name = 'CategoryFinalizedError';
  }
}
