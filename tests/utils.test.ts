import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, needsRehash, ARGON2_OPTIONS } from '../src/utils/password.js';
import { generateToken, tokensEqual } from '../src/utils/tokens.js';
import { encrypt, decrypt } from '../src/utils/crypto.js';

describe('password (argon2id)', () => {
  it('hashes produce argon2id format strings', async () => {
    const h = await hashPassword('correct horse battery staple!');
    expect(h).toMatch(/^\$argon2id\$/);
    // Encoded params must match our OWASP-aligned defaults.
    expect(h).toContain(`m=${ARGON2_OPTIONS.memoryCost}`);
    expect(h).toContain(`t=${ARGON2_OPTIONS.timeCost}`);
    expect(h).toContain(`p=${ARGON2_OPTIONS.parallelism}`);
  });

  it('each hash is unique (salted) even for the same password', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password-123456'),
      hashPassword('same-password-123456'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifyPassword returns true for matching pair', async () => {
    const h = await hashPassword('correctpassword12');
    expect(await verifyPassword(h, 'correctpassword12')).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    const h = await hashPassword('correctpassword12');
    expect(await verifyPassword(h, 'wrongpassword12!')).toBe(false);
  });

  it('verifyPassword returns false (does not throw) for malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
    expect(await verifyPassword('', 'whatever')).toBe(false);
  });

  it('hashPassword throws on empty input', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });

  it('needsRehash returns false for hashes with current params', async () => {
    const h = await hashPassword('password-12345678');
    expect(needsRehash(h)).toBe(false);
  });
});

describe('tokens', () => {
  it('generateToken produces different tokens each call', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });

  it('generateToken produces url-safe base64 (no + / =)', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generateToken respects byte count argument', () => {
    // base64url length ~= ceil(bytes * 4 / 3), no padding.
    const t16 = generateToken(16); // ~22 chars
    const t32 = generateToken(32); // ~43 chars
    expect(t32.length).toBeGreaterThan(t16.length);
  });

  it('generateToken rejects too-small sizes', () => {
    expect(() => generateToken(8)).toThrow(RangeError);
    expect(() => generateToken(0)).toThrow(RangeError);
  });

  it('tokensEqual returns true for identical tokens', () => {
    const t = generateToken();
    expect(tokensEqual(t, t)).toBe(true);
  });

  it('tokensEqual returns false for different tokens', () => {
    expect(tokensEqual(generateToken(), generateToken())).toBe(false);
  });

  it('tokensEqual returns false for length mismatch', () => {
    expect(tokensEqual('short', 'muchlongertoken')).toBe(false);
  });

  it('tokensEqual returns false for non-strings', () => {
    // @ts-expect-error intentional wrong type for runtime safety test
    expect(tokensEqual(null, 'x')).toBe(false);
    // @ts-expect-error
    expect(tokensEqual('x', undefined)).toBe(false);
  });
});

describe('crypto (AES-256-GCM)', () => {
  it('roundtrips plaintext through encrypt/decrypt', () => {
    const plain = 'hello world';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('each encrypt() uses a fresh IV (ciphertexts differ)', () => {
    const a = encrypt('same-plaintext');
    const b = encrypt('same-plaintext');
    expect(a).not.toBe(b);
  });

  it('decrypt rejects tampered ciphertext', () => {
    const valid = encrypt('sensitive-data');
    // Flip one hex character in the ciphertext section (part index 1).
    const parts = valid.split(':');
    const ct = parts[1] as string;
    const tampered = parts.slice();
    tampered[1] = (ct[0] === 'a' ? 'b' : 'a') + ct.slice(1);
    expect(() => decrypt(tampered.join(':'))).toThrow();
  });

  it('decrypt rejects malformed envelope', () => {
    expect(() => decrypt('bad-format')).toThrow('malformed ciphertext envelope');
    expect(() => decrypt('only:two')).toThrow('malformed ciphertext envelope');
  });

  it('handles unicode', () => {
    const plain = 'Olá, mundo 🌍 açaí';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });
});
