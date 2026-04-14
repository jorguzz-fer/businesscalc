/**
 * Authentication + CSRF middleware.
 *
 * Applied per-route (or per-plugin-scope) to routes that need a logged-in
 * user. Two independent checks:
 *
 * 1. Session: reads the signed `sid` cookie, validates against the DB
 *    (session exists, not expired). Populates `request.user` and
 *    `request.sessionId` for downstream handlers.
 *
 * 2. CSRF: for state-changing methods (POST/PUT/PATCH/DELETE), the client
 *    must send the session's csrfToken in the `X-CSRF-Token` header. The
 *    token was handed out at login (in a non-httpOnly cookie readable by
 *    our own JS) and the server compares it against the value stored with
 *    the session. Mismatch => 403.
 *
 *    This is the "double-submit cookie" pattern. Combined with SameSite=Strict
 *    on the session cookie, it's defense in depth against CSRF.
 *
 * Why we return 404 instead of 403 for "session missing/expired":
 *   - Because /api/* routes are behind requireAuth, their existence is not
 *     a secret. 401 is the accurate status.
 *   - But for RESOURCE access later (e.g. GET /api/periods/:id), we return
 *     404 instead of 403 when the caller doesn't own the resource, so the
 *     caller can't enumerate valid UUIDs. That's a separate layer.
 *
 * Here, 401 is correct: authentication is missing.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { tokensEqual } from '../utils/tokens.js';
import { validateSession } from '../services/auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
      name: string | null;
    };
    session?: {
      id: string;
      csrfToken: string;
    };
  }
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SESSION_COOKIE = 'sid';

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Read signed session cookie. @fastify/cookie unsignCookie returns
  // { valid, value } — we accept only validly signed values.
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Sessão não encontrada' });
    return;
  }
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Sessão inválida' });
    return;
  }
  const sessionId = unsigned.value;

  const session = await validateSession(sessionId);
  if (!session) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Sessão expirada' });
    return;
  }

  // CSRF check for state-changing methods.
  if (STATE_CHANGING.has(request.method)) {
    const header = request.headers['x-csrf-token'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || !tokensEqual(String(provided), session.csrfToken)) {
      reply.code(403).send({ error: 'Forbidden', message: 'CSRF token inválido' });
      return;
    }
  }

  request.user = {
    id: session.userId,
    email: session.userEmail,
    name: session.userName,
  };
  request.session = {
    id: session.sessionId,
    csrfToken: session.csrfToken,
  };
}
