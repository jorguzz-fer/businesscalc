/**
 * Period CRUD business logic.
 *
 * Every read/write below starts with an ownership filter on userId. This
 * is THE critical defense against IDOR: we don't trust the resource id
 * alone — we always require (userId, id) to match.
 *
 * Returns `null` for "not found OR not owned" so the caller (route layer)
 * can respond with 404 in either case. Per vibesec guidance: returning 403
 * ("forbidden") for an existing-but-unowned resource leaks its existence;
 * returning 404 keeps the ID space opaque to the attacker.
 */
import type { PeriodType, PeriodStatus, Period } from '@prisma/client';
import { prisma } from '../db.js';
import type { CreatePeriodInput, UpdatePeriodInput } from '../schemas/period.schema.js';
import { seedDefaults } from './periodCategory.service.js';

export async function list(
  userId: string,
  filter?: { type?: PeriodType },
): Promise<Period[]> {
  return prisma.period.findMany({
    where: {
      userId,
      ...(filter?.type ? { type: filter.type } : {}),
    },
    orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function get(userId: string, id: string): Promise<Period | null> {
  // Single-query ownership check. findFirst avoids a two-step fetch-and-
  // compare dance that has been the source of IDOR bugs elsewhere.
  return prisma.period.findFirst({
    where: { id, userId },
  });
}

export async function create(
  userId: string,
  input: CreatePeriodInput,
): Promise<Period> {
  // Prisma throws P2002 on unique constraint violation. The (userId, name,
  // type) composite unique prevents "DRE 2024" twice for the same user.
  // The route layer catches this and maps it to 409.
  //
  // We also seed the default categories (18 for DRE, 19 for FC) inside
  // the same transaction so a period never exists with no categories —
  // the UI can rely on `categories.length > 0`.
  return prisma.$transaction(async (tx) => {
    const period = await tx.period.create({
      data: {
        userId,
        name: input.name,
        year: input.year,
        type: input.type,
      },
    });
    await seedDefaults(tx, period.id, period.type);
    return period;
  });
}

export async function update(
  userId: string,
  id: string,
  input: UpdatePeriodInput,
): Promise<Period | null> {
  // Two steps in a transaction so the update is atomic with the ownership
  // check. Without this, a race between check and update could let an
  // attacker modify another user's period.
  return prisma.$transaction(async (tx) => {
    const existing = await tx.period.findFirst({ where: { id, userId } });
    if (!existing) return null;
    const data: Partial<{ name: string; year: number; status: PeriodStatus }> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.year !== undefined) data.year = input.year;
    if (input.status !== undefined) data.status = input.status;
    return tx.period.update({ where: { id }, data });
  });
}

export async function remove(userId: string, id: string): Promise<boolean> {
  // deleteMany returns { count }. Using findFirst + delete would have the
  // same atomicity hazard as update above; deleteMany with userId in the
  // where clause is a single atomic operation.
  const result = await prisma.period.deleteMany({
    where: { id, userId },
  });
  return result.count > 0;
}
