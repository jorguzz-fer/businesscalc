/**
 * Meta (annual goals) service.
 *
 * Ownership: every path starts with (userId, periodId) to prevent IDOR.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { UpsertMetaInput } from '../schemas/meta.schema.js';

export type MetaResponse = {
  receitaAnual: number | null;
  lucroAnual: number | null;
  margemBrutaPct: number | null;
  margemOpPct: number | null;
  margemLiqPct: number | null;
  ticketMedio: number | null;
  pedidosMes: number | null;
};

function toResponse(row: {
  receitaAnual: Prisma.Decimal | null;
  lucroAnual: Prisma.Decimal | null;
  margemBrutaPct: Prisma.Decimal | null;
  margemOpPct: Prisma.Decimal | null;
  margemLiqPct: Prisma.Decimal | null;
  ticketMedio: Prisma.Decimal | null;
  pedidosMes: number | null;
}): MetaResponse {
  // Prisma returns Decimal objects for db.Decimal columns. Convert to
  // plain number so the JSON response uses native numeric type.
  // Decimal -> number can lose precision past 15 digits, but financial
  // UI values fit comfortably. Storage stays precise (db.Decimal).
  const num = (d: Prisma.Decimal | null): number | null =>
    d === null ? null : Number(d);
  return {
    receitaAnual: num(row.receitaAnual),
    lucroAnual: num(row.lucroAnual),
    margemBrutaPct: num(row.margemBrutaPct),
    margemOpPct: num(row.margemOpPct),
    margemLiqPct: num(row.margemLiqPct),
    ticketMedio: num(row.ticketMedio),
    pedidosMes: row.pedidosMes,
  };
}

export async function getByPeriod(
  userId: string,
  periodId: string,
): Promise<MetaResponse | null> {
  // Validate period ownership first.
  const period = await prisma.period.findFirst({
    where: { id: periodId, userId },
    select: { id: true, meta: true },
  });
  if (!period) return null;
  if (!period.meta) {
    // No meta set yet — return an empty-all-null object so the UI can
    // render placeholders uniformly.
    return {
      receitaAnual: null,
      lucroAnual: null,
      margemBrutaPct: null,
      margemOpPct: null,
      margemLiqPct: null,
      ticketMedio: null,
      pedidosMes: null,
    };
  }
  return toResponse(period.meta);
}

export async function upsertForPeriod(
  userId: string,
  periodId: string,
  input: UpsertMetaInput,
): Promise<MetaResponse | null> {
  return prisma.$transaction(async (tx) => {
    const period = await tx.period.findFirst({
      where: { id: periodId, userId },
      select: { id: true, status: true },
    });
    if (!period) return null;
    if (period.status === 'FINALIZED') {
      throw new MetaFinalizedError();
    }

    // Only fields explicitly present in the input are written. Use the
    // `in input` check so explicit null (meaning "clear this goal") is
    // honored while missing keys are no-op.
    const data: Prisma.MetaUncheckedCreateInput = { periodId: period.id };
    const updateData: Prisma.MetaUpdateInput = {};

    if ('receitaAnual' in input) {
      data.receitaAnual = input.receitaAnual;
      updateData.receitaAnual = input.receitaAnual;
    }
    if ('lucroAnual' in input) {
      data.lucroAnual = input.lucroAnual;
      updateData.lucroAnual = input.lucroAnual;
    }
    if ('margemBrutaPct' in input) {
      data.margemBrutaPct = input.margemBrutaPct;
      updateData.margemBrutaPct = input.margemBrutaPct;
    }
    if ('margemOpPct' in input) {
      data.margemOpPct = input.margemOpPct;
      updateData.margemOpPct = input.margemOpPct;
    }
    if ('margemLiqPct' in input) {
      data.margemLiqPct = input.margemLiqPct;
      updateData.margemLiqPct = input.margemLiqPct;
    }
    if ('ticketMedio' in input) {
      data.ticketMedio = input.ticketMedio;
      updateData.ticketMedio = input.ticketMedio;
    }
    if ('pedidosMes' in input) {
      data.pedidosMes = input.pedidosMes;
      updateData.pedidosMes = input.pedidosMes;
    }

    const row = await tx.meta.upsert({
      where: { periodId: period.id },
      create: data,
      update: updateData,
    });
    return toResponse(row);
  });
}

export class MetaFinalizedError extends Error {
  constructor() {
    super('Período finalizado — metas não podem ser editadas');
    this.name = 'MetaFinalizedError';
  }
}
