/**
 * AES-256-GCM column-level encryption.
 *
 * Reserved for Phase 3. The helper is implemented now (not stubbed) because:
 *   1. It's small and fully testable in isolation.
 *   2. Lets us test `ENCRYPTION_KEY` rotation early.
 *   3. Nothing calls it yet, so there's no risk of partial coverage.
 *
 * When used: stored value is `iv:ciphertext:authTag`, all hex, separated by
 * colons (total 32 + cipher_length*2 + 32 chars). AES-GCM is authenticated
 * encryption — tampering with any byte makes decrypt() throw.
 *
 * Key rotation plan (documented for Phase 3):
 *   - ENCRYPTION_KEY stays 32 bytes hex.
 *   - Rotate by: (a) decrypt with old key, (b) re-encrypt with new key,
 *     (c) set new key in env. Script under scripts/rotate-encryption-key.ts.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM recommended IV size
const KEY_BYTES = 32; // 256-bit

function getKey(): Buffer {
  // config.ts already asserted 64 hex chars (32 bytes); this parse is safe.
  const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes`);
  }
  return key;
}

export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() expects a string');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ciphertext.toString('hex')}:${authTag.toString('hex')}`;
}

export function decrypt(encoded: string): string {
  if (typeof encoded !== 'string') {
    throw new TypeError('decrypt() expects a string');
  }
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw new Error('malformed ciphertext envelope');
  }
  const [ivHex, ctHex, tagHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const ciphertext = Buffer.from(ctHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
