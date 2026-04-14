/**
 * Audit log helper.
 *
 * Fire-and-forget: audit writes NEVER block or fail the caller. A DB hiccup
 * must not prevent a user from logging in. We log the error to stderr and
 * move on.
 *
 * Actions follow the `noun.verb` or `noun.verb.outcome` convention:
 *   auth.signup
 *   auth.login.success
 *   auth.login.failure
 *   auth.logout
 *   auth.password_changed
 *   auth.password_reset_requested
 *   auth.email_verified
 *   auth.account_locked
 *   period.create
 *   period.delete
 *
 * userId is nullable — failed logins for a wrong email have no user, but
 * we still want to record the attempt (rate limiting, abuse detection).
 *
 * vibesec: NEVER pass password, token, or Authorization header as metadata.
 * Stick to non-sensitive context (IP, UA, category counts, etc).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

export type AuditParams = {
  userId?: string | null;
  action: string;
  resource?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
};

// Pending audit writes. Exposed to tests so they can await drain() to
// prevent the next beforeEach from truncating a row that's still mid-flight.
const pending = new Set<Promise<unknown>>();

export function log(params: AuditParams): void {
  const data: Prisma.AuditLogUncheckedCreateInput = {
    userId: params.userId ?? null,
    action: params.action,
    resource: params.resource ?? null,
    ip: params.ip ?? null,
    userAgent: params.userAgent ? params.userAgent.slice(0, 512) : null,
    // Prisma distinguishes `null` (not valid JSON) from `Prisma.JsonNull`
    // (SQL NULL stored in a JSON column).
    metadata: params.metadata ? (params.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
  };
  const promise = prisma.auditLog
    .create({ data })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[audit] failed to persist event', {
        action: params.action,
        err: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      pending.delete(promise);
    });
  pending.add(promise);
  // Not awaited by the caller: audit must never block.
}

/**
 * Wait for all in-flight audit writes to settle. Test-only helper so we
 * can query audit_logs immediately after a request returns without races.
 */
export async function drain(): Promise<void> {
  await Promise.all(pending);
}
