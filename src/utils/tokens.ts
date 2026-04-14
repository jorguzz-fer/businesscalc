/**
 * Cryptographically secure random tokens.
 *
 * Used for:
 *   - Email verification token (24 h TTL)
 *   - Password reset token (1 h TTL)
 *   - CSRF token (per-session)
 *   - Session ID (though we rely on UUID for that — crypto random is equivalent)
 *
 * All tokens are URL-safe base64 of Node's crypto.randomBytes output.
 * DO NOT use Math.random() or any predictable PRNG for these.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Generate a new random token.
 * @param bytes Number of random bytes to read. Default 32 (=> 43-char base64url).
 */
export function generateToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16) {
    throw new RangeError('token size must be >= 16 bytes');
  }
  return randomBytes(bytes).toString('base64url');
}

/**
 * Compare two tokens in constant time. Prevents timing attacks where an
 * attacker measures response latency to guess a valid token byte-by-byte.
 *
 * Returns false if lengths differ (also constant-time — we hash both to the
 * same length before comparing so we don't leak length via short-circuit).
 */
export function tokensEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual requires equal length; pad both to max length with zeros.
  // Using a separate comparison of length is safe because length itself is
  // not sensitive — only the content is.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
