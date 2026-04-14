/**
 * Entry CRUD + derived-value computation.
 *
 * All reads/writes enforce that the target period belongs to the
 * authenticated user (ownership chained: Entry -> Period -> User).
 *
 * Returns null when the period is not found OR not owned — route layer
 * translates both to 404 (vibesec anti-enumeration).
 *
 * CRITICAL: NEVER trust the client's computed values. They can send
 * `lucroBruto = 99999999` all they want — we ignore it, we compute from
 * the raw monthly numbers on every read. `Entry.monthly` is the single
 * source of truth.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import {
  ALL_CATEGORY_KEYS,
  type CategoryKey,
  type UpsertEntriesInput,
} from '../schemas/entry.schema.js';

export type MonthlyArray = [
  number, number, number, number, number, number,
  number, number, number, number, number, number,
];

const zeroMonthly = (): MonthlyArray => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

export type EntriesMap = Partial<Record<CategoryKey, MonthlyArray>>;

/**
 * Round a monthly array to 2 decimal places using banker's rounding-ish
 * (Math.round). Protects the DB from junk like 3.14159265... that could
 * creep in from client-side calculations or pasted Excel values.
 */
function roundMonthly(arr: number[]): MonthlyArray {
  const out = zeroMonthly();
  for (let i = 0; i < 12; i++) {
    const v = arr[i] ?? 0;
    out[i] = Math.round(v * 100) / 100;
  }
  return out;
}

/**
 * Fetch entries for a period, but ONLY if the period belongs to the
 * given user. Returns null otherwise (route -> 404).
 */
export async function getByPeriod(
  userId: string,
  periodId: string,
): Promise<{ entries: EntriesMap; periodType: 'DRE' | 'FC' } | null> {
  const period = await prisma.period.findFirst({
    where: { id: periodId, userId },
    select: { id: true, type: true },
  });
  if (!period) return null;

  const rows = await prisma.entry.findMany({
    where: { periodId: period.id },
  });

  const entries: EntriesMap = {};
  for (const row of rows) {
    // Validate the JSON round-trip. If someone tampered with the DB and
    // a row has a bogus shape, coerce to zeros instead of crashing.
    if (!Array.isArray(row.monthly) || row.monthly.length !== 12) continue;
    const arr = (row.monthly as unknown[]).map((v) =>
      typeof v === 'number' && Number.isFinite(v) ? v : 0,
    );
    if (ALL_CATEGORY_KEYS.includes(row.category as CategoryKey)) {
      entries[row.category as CategoryKey] = roundMonthly(arr);
    }
  }

  return { entries, periodType: period.type };
}

/**
 * Replace ALL entries for the period with the payload, in a single
 * transaction. Categories not present in the new payload are deleted.
 *
 * Returns the list of categories that were touched (created, updated,
 * or deleted) so the audit log can record what changed — without ever
 * persisting monetary values in audit metadata (they'd leak financial
 * data).
 */
export async function upsertForPeriod(
  userId: string,
  periodId: string,
  input: UpsertEntriesInput,
): Promise<{ touched: CategoryKey[] } | null> {
  // Uppercase ownership + freeze check in one go.
  const period = await prisma.period.findFirst({
    where: { id: periodId, userId },
    select: { id: true, status: true },
  });
  if (!period) return null;
  if (period.status === 'FINALIZED') {
    // Can't edit a finalized period. Signal with a typed result so the
    // route layer returns 409.
    throw new PeriodFinalizedError();
  }

  const incoming = new Map<CategoryKey, MonthlyArray>();
  for (const e of input.entries) {
    incoming.set(e.category as CategoryKey, roundMonthly(e.monthly));
  }

  const touched = new Set<CategoryKey>();

  await prisma.$transaction(async (tx) => {
    // 1. Delete categories that are in DB but NOT in the payload.
    const existing = await tx.entry.findMany({
      where: { periodId: period.id },
      select: { category: true },
    });
    const toDelete = existing
      .map((r) => r.category as CategoryKey)
      .filter((k) => !incoming.has(k) && ALL_CATEGORY_KEYS.includes(k));
    if (toDelete.length > 0) {
      await tx.entry.deleteMany({
        where: { periodId: period.id, category: { in: toDelete } },
      });
      toDelete.forEach((k) => touched.add(k));
    }

    // 2. Upsert each incoming category.
    for (const [category, monthly] of incoming) {
      await tx.entry.upsert({
        where: { periodId_category: { periodId: period.id, category } },
        create: {
          periodId: period.id,
          category,
          monthly: monthly as unknown as Prisma.InputJsonValue,
        },
        update: {
          monthly: monthly as unknown as Prisma.InputJsonValue,
        },
      });
      touched.add(category);
    }
  });

  return { touched: Array.from(touched) };
}

export class PeriodFinalizedError extends Error {
  constructor() {
    super('Período finalizado não pode ser editado');
    this.name = 'PeriodFinalizedError';
  }
}

// ======================================================================
// Derived value computation
// ======================================================================
//
// These functions mirror the v1 SPA calculations (see public/app.html's
// computeDRE/computeFC) but ONLY run server-side. The API returns them
// alongside the raw entries so the client can render without having to
// compute. The client may still display its own preview while the user
// types (debouncing the save), but the authoritative numbers come from
// the server response.

const zip = (a: MonthlyArray, b: MonthlyArray): MonthlyArray => {
  const out = zeroMonthly();
  for (let i = 0; i < 12; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
};

const sub = (a: MonthlyArray, b: MonthlyArray): MonthlyArray => {
  const out = zeroMonthly();
  for (let i = 0; i < 12; i++) out[i] = (a[i] ?? 0) - (b[i] ?? 0);
  return out;
};

const sumArr = (a: MonthlyArray): number =>
  a.reduce((s, v) => s + (v ?? 0), 0);

const get = (e: EntriesMap, k: CategoryKey): MonthlyArray =>
  e[k] ?? zeroMonthly();

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
  // Annual totals for KPI cards.
  totalReceita: number;
  totalLucroBruto: number;
  totalResultado: number;
  margemBrutaAnual: number;
  margemLiquidaAnual: number;
};

export function computeDRE(entries: EntriesMap): DREComputed {
  const receita = get(entries, 'receita');
  const deducoes = get(entries, 'deducoes');
  const receitaLiquida = sub(receita, deducoes);

  const custosDiretos = [
    'cmv',
    'outrosCustos',
    'equipamentos',
    'provisao',
  ].reduce(
    (acc, k) => zip(acc, get(entries, k as CategoryKey)),
    zeroMonthly(),
  );
  const lucroBruto = sub(receitaLiquida, custosDiretos);

  const despesasOperacionais = [
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
  ].reduce(
    (acc, k) => zip(acc, get(entries, k as CategoryKey)),
    zeroMonthly(),
  );
  const resultadoLiquido = sub(lucroBruto, despesasOperacionais);

  const margemBrutaMensal = receita.map((v, i) =>
    v > 0 ? ((lucroBruto[i] ?? 0) / v) * 100 : 0,
  ) as MonthlyArray;
  const margemLiquidaMensal = receita.map((v, i) =>
    v > 0 ? ((resultadoLiquido[i] ?? 0) / v) * 100 : 0,
  ) as MonthlyArray;

  const totalReceita = sumArr(receita);
  const totalLucroBruto = sumArr(lucroBruto);
  const totalResultado = sumArr(resultadoLiquido);

  return {
    receita,
    deducoes,
    receitaLiquida,
    custosDiretos,
    lucroBruto,
    despesasOperacionais,
    resultadoLiquido,
    margemBrutaMensal,
    margemLiquidaMensal,
    totalReceita,
    totalLucroBruto,
    totalResultado,
    margemBrutaAnual:
      totalReceita > 0 ? (totalLucroBruto / totalReceita) * 100 : 0,
    margemLiquidaAnual:
      totalReceita > 0 ? (totalResultado / totalReceita) * 100 : 0,
  };
}

export type FCComputed = {
  receita: MonthlyArray;
  pedidos: MonthlyArray;
  ticketMedio: MonthlyArray;
  totalSaidas: MonthlyArray;
  saldo: MonthlyArray;
  totalEntradasAno: number;
  totalSaidasAno: number;
  saldoAno: number;
  pedidosAno: number;
  ticketMedioAno: number;
};

export function computeFC(entries: EntriesMap): FCComputed {
  const receita = get(entries, 'receita');
  const pedidos = get(entries, 'pedidos');
  const ticketMedio = get(entries, 'ticketMedio');

  const totalSaidas = [
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
  ].reduce(
    (acc, k) => zip(acc, get(entries, k as CategoryKey)),
    zeroMonthly(),
  );
  const saldo = sub(receita, totalSaidas);

  const totalEntradasAno = sumArr(receita);
  const totalSaidasAno = sumArr(totalSaidas);
  const pedidosAno = sumArr(pedidos);

  return {
    receita,
    pedidos,
    ticketMedio,
    totalSaidas,
    saldo,
    totalEntradasAno,
    totalSaidasAno,
    saldoAno: sumArr(saldo),
    pedidosAno,
    ticketMedioAno: pedidosAno > 0 ? totalEntradasAno / pedidosAno : 0,
  };
}
