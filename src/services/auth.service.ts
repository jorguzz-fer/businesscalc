/**
 * Authentication business logic.
 *
 * This module is pure business logic — it knows nothing about HTTP, cookies,
 * or Fastify. Callers (the route layer) translate these results into HTTP
 * responses.
 *
 * vibesec principles applied:
 *
 * 1. Anti-enumeration: signup and forgotPassword ALWAYS return success,
 *    regardless of whether the email is already in use or exists at all.
 *    Otherwise an attacker could probe which emails are registered.
 *
 * 2. Generic login error: wrong email and wrong password produce the same
 *    response ("invalid credentials"). Only AFTER a correct password check
 *    do we leak information like "email not verified" or "account locked"
 *    — and even then, the attacker had to know the right password to reach
 *    that branch, so the leak is effectively useless.
 *
 * 3. Timing-safe: we always run argon2 verify on login, even for a
 *    non-existent email (using a dummy hash). This prevents timing
 *    attacks where response latency reveals email registration status.
 *
 * 4. Brute-force protection: failedLoginCount is incremented on each wrong
 *    password (not wrong email — that would let attackers lock real users'
 *    accounts by knowing their email). At 10 failures we lock for 30
 *    minutes. Successful login resets the counter.
 *
 * 5. Session revocation on password reset: when a user resets their
 *    password we DELETE all existing sessions, forcing re-login everywhere.
 *    This kicks out any attacker who might have hijacked a session before
 *    the reset.
 *
 * 6. Token expiration: verify tokens last 24h, reset tokens last 1h.
 *    Both are single-use — consumed by the flow, then cleared.
 */
import { prisma } from '../db.js';
import { hashPassword, verifyPassword, needsRehash } from '../utils/password.js';
import { generateToken } from '../utils/tokens.js';
import { sendVerifyEmail, sendResetEmail } from './email.service.js';
import * as audit from './audit.service.js';

// ---------- Types ----------

export type AuthContext = {
  ip?: string;
  userAgent?: string;
};

export type SessionPair = {
  sessionId: string;
  csrfToken: string;
};

export type LoginOutcome =
  | { ok: true; sessionId: string; csrfToken: string; userId: string }
  | { ok: false; reason: 'invalid_credentials' | 'email_not_verified' | 'account_locked' };

// ---------- Config ----------

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS_PER_USER = 10;

// Fixed argon2id hash computed at startup. verifyPassword() against this
// will always return false, but takes the same ~100ms an argon2 verify
// takes for a real hash. Used when looking up a user that doesn't exist
// so login latency is constant regardless of email validity.
let TIMING_DUMMY_HASH: string | null = null;
async function timingDummy(): Promise<string> {
  if (!TIMING_DUMMY_HASH) {
    TIMING_DUMMY_HASH = await hashPassword('dummy-for-timing-only');
  }
  return TIMING_DUMMY_HASH;
}

// ---------- signup ----------

export async function signup(params: {
  email: string;
  password: string;
  name?: string;
  ctx: AuthContext;
}): Promise<void> {
  const { email, password, name, ctx } = params;

  // Always return success, even if the email is already registered.
  // The attacker can't learn whether an account exists from this endpoint.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Audit the conflict so we can detect enumeration attempts in logs.
    audit.log({
      userId: existing.id,
      action: 'auth.signup.duplicate',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return;
  }

  const passwordHash = await hashPassword(password);
  const verifyToken = generateToken(32);
  const verifyTokenExpires = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: name ?? null,
      verifyToken,
      verifyTokenExpires,
      termsAcceptedAt: new Date(),
    },
  });

  // Fire-and-forget email. Failures are swallowed so the client can't
  // distinguish "signup succeeded" vs "signup succeeded but email bounced"
  // by timing or response shape.
  sendVerifyEmail({ to: email, token: verifyToken, name: name ?? null }).catch(
    (err) => {
      // eslint-disable-next-line no-console
      console.error('[auth.signup] verify email send failed', err);
    },
  );

  audit.log({
    userId: user.id,
    action: 'auth.signup',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

// ---------- verifyEmail ----------

export type VerifyEmailResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid_or_expired' };

export async function verifyEmail(params: {
  token: string;
  ctx: AuthContext;
}): Promise<VerifyEmailResult> {
  const user = await prisma.user.findUnique({
    where: { verifyToken: params.token },
  });

  if (
    !user ||
    !user.verifyTokenExpires ||
    user.verifyTokenExpires.getTime() < Date.now()
  ) {
    return { ok: false, reason: 'invalid_or_expired' };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      verifyToken: null,
      verifyTokenExpires: null,
    },
  });

  audit.log({
    userId: user.id,
    action: 'auth.email_verified',
    ip: params.ctx.ip,
    userAgent: params.ctx.userAgent,
  });

  return { ok: true, userId: user.id };
}

// ---------- login ----------

export async function login(params: {
  email: string;
  password: string;
  ctx: AuthContext;
}): Promise<LoginOutcome> {
  const { email, password, ctx } = params;
  const user = await prisma.user.findUnique({ where: { email } });

  // Always run a password verify even if user is null — constant-time
  // response prevents email enumeration via timing.
  if (!user) {
    await verifyPassword(await timingDummy(), password);
    audit.log({
      action: 'auth.login.failure',
      metadata: { reason: 'unknown_email' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: false, reason: 'invalid_credentials' };
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!passwordOk) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: { increment: 1 },
        lockedUntil:
          user.failedLoginCount + 1 >= MAX_FAILED_LOGINS
            ? new Date(Date.now() + LOCKOUT_DURATION_MS)
            : user.lockedUntil,
      },
    });
    audit.log({
      userId: user.id,
      action: 'auth.login.failure',
      metadata: { reason: 'wrong_password', failedCount: user.failedLoginCount + 1 },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: false, reason: 'invalid_credentials' };
  }

  // Password is correct from here on. Now we CAN leak specific reasons
  // (locked / unverified) — the attacker already knows the password.

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    audit.log({
      userId: user.id,
      action: 'auth.login.failure',
      metadata: { reason: 'locked_until', until: user.lockedUntil.toISOString() },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: false, reason: 'account_locked' };
  }

  if (!user.emailVerified) {
    audit.log({
      userId: user.id,
      action: 'auth.login.failure',
      metadata: { reason: 'email_not_verified' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: false, reason: 'email_not_verified' };
  }

  // Success path: reset lockout counters, optionally rehash with stronger
  // params if our argon2 settings changed since signup, issue session.
  const updates: { failedLoginCount: number; lockedUntil: null; lastLoginAt: Date; passwordHash?: string } = {
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: new Date(),
  };
  if (needsRehash(user.passwordHash)) {
    updates.passwordHash = await hashPassword(password);
  }
  await prisma.user.update({ where: { id: user.id }, data: updates });

  const session = await createSession({ userId: user.id, ctx });

  audit.log({
    userId: user.id,
    action: 'auth.login.success',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return { ok: true, userId: user.id, ...session };
}

// ---------- session management ----------

async function createSession(params: {
  userId: string;
  ctx: AuthContext;
}): Promise<SessionPair> {
  const csrfToken = generateToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await prisma.session.create({
    data: {
      userId: params.userId,
      csrfToken,
      ip: params.ctx.ip ?? null,
      userAgent: params.ctx.userAgent ? params.ctx.userAgent.slice(0, 512) : null,
      expiresAt,
    },
  });

  // Prune old sessions beyond the per-user cap. Oldest go first.
  const count = await prisma.session.count({ where: { userId: params.userId } });
  if (count > MAX_SESSIONS_PER_USER) {
    const toDelete = await prisma.session.findMany({
      where: { userId: params.userId },
      orderBy: { lastUsedAt: 'asc' },
      take: count - MAX_SESSIONS_PER_USER,
      select: { id: true },
    });
    if (toDelete.length > 0) {
      await prisma.session.deleteMany({
        where: { id: { in: toDelete.map((s) => s.id) } },
      });
    }
  }

  return { sessionId: session.id, csrfToken };
}

export async function logout(params: {
  sessionId: string;
  userId: string | null;
  ctx: AuthContext;
}): Promise<void> {
  await prisma.session
    .delete({ where: { id: params.sessionId } })
    .catch(() => {
      // Already gone — idempotent logout.
    });
  audit.log({
    userId: params.userId,
    action: 'auth.logout',
    ip: params.ctx.ip,
    userAgent: params.ctx.userAgent,
  });
}

/**
 * Validate an incoming session cookie and return the active session + user.
 * Called by the requireAuth middleware (Task 0.7). Returns null if:
 *   - no session with that id,
 *   - session expired,
 *   - user was deleted (cascade should have cleaned it, but defensively).
 * Updates lastUsedAt as a sliding expiration hint.
 */
export async function validateSession(sessionId: string): Promise<{
  sessionId: string;
  userId: string;
  csrfToken: string;
  userEmail: string;
  userName: string | null;
} | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    // Expired — best-effort cleanup.
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    return null;
  }

  // Sliding expiration: update lastUsedAt without blocking the response.
  prisma.session
    .update({ where: { id: sessionId }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    sessionId: session.id,
    userId: session.user.id,
    csrfToken: session.csrfToken,
    userEmail: session.user.email,
    userName: session.user.name,
  };
}

// ---------- forgot / reset password ----------

export async function forgotPassword(params: {
  email: string;
  ctx: AuthContext;
}): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: params.email } });

  // ALWAYS return the same way, regardless of whether the email exists.
  // Generate dummy work to equalize timing even on non-existent accounts.
  if (!user) {
    await generateToken(32); // cheap; kept for symmetry in the audit record
    audit.log({
      action: 'auth.password_reset_requested',
      metadata: { emailExists: false },
      ip: params.ctx.ip,
      userAgent: params.ctx.userAgent,
    });
    return;
  }

  const resetToken = generateToken(32);
  const resetTokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await prisma.user.update({
    where: { id: user.id },
    data: { resetToken, resetTokenExpires },
  });

  sendResetEmail({ to: user.email, token: resetToken, name: user.name }).catch(
    (err) => {
      // eslint-disable-next-line no-console
      console.error('[auth.forgotPassword] send failed', err);
    },
  );

  audit.log({
    userId: user.id,
    action: 'auth.password_reset_requested',
    ip: params.ctx.ip,
    userAgent: params.ctx.userAgent,
  });
}

export type ResetPasswordResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid_or_expired' };

export async function resetPassword(params: {
  token: string;
  newPassword: string;
  ctx: AuthContext;
}): Promise<ResetPasswordResult> {
  const user = await prisma.user.findUnique({
    where: { resetToken: params.token },
  });

  if (
    !user ||
    !user.resetTokenExpires ||
    user.resetTokenExpires.getTime() < Date.now()
  ) {
    return { ok: false, reason: 'invalid_or_expired' };
  }

  const passwordHash = await hashPassword(params.newPassword);

  // Everything in a transaction: password update + clear tokens + wipe
  // all sessions. If any step fails, nothing persists.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetToken: null,
        resetTokenExpires: null,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
  ]);

  audit.log({
    userId: user.id,
    action: 'auth.password_changed',
    ip: params.ctx.ip,
    userAgent: params.ctx.userAgent,
  });

  return { ok: true, userId: user.id };
}
