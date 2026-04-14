/**
 * Password hashing with argon2id.
 *
 * Parameters follow the OWASP 2023 recommendation for argon2id:
 *   memoryCost: 19 MiB (19456 KiB)
 *   timeCost:   2 iterations
 *   parallelism: 1
 *
 * These values are a deliberate trade-off:
 *   - Resilient to GPU/ASIC attacks (memory-hard).
 *   - ~50-150 ms on a typical x86_64 (good user experience).
 *   - Not so heavy that a login burst can DoS the server.
 *
 * If you ever change these numbers, argon2 encodes them inside the hash
 * string so old hashes keep working. Users logging in with an outdated
 * hash can be transparently re-hashed with the new params (see
 * `verifyAndMaybeRehash` below).
 *
 * Security (vibesec):
 *   - Never log the plain password or the hash.
 *   - `verify` MUST be used for comparison — it's constant-time internally.
 *   - Do NOT expose the hash in any API response, ever.
 */
import argon2 from 'argon2';

// Exported for tests; DO NOT change in production without a migration plan.
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hash a plaintext password for storage.
 * Returns the encoded string: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored argon2 hash.
 * Constant-time; returns false for malformed or invalid hashes.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  if (typeof hash !== 'string' || typeof plain !== 'string') return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // argon2.verify throws on malformed hash strings; treat that as "no match"
    // so an attacker can't distinguish between "user not found" and "bad hash".
    return false;
  }
}

/**
 * Check whether an existing hash was created with parameters that no longer
 * match our current defaults. If `true`, the caller should re-hash the
 * password (with the new params) and update the DB. This lets us strengthen
 * params over time without forcing mass resets.
 */
export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS);
}
