import crypto from 'node:crypto';
import { env } from '../config/env.js';

// AES-256-GCM authenticated encryption for secrets at rest (e.g. WhatsApp
// access tokens). Format of the stored string:
//   v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
// The version prefix lets us rotate algorithms/keys in future without
// ambiguity. The key is a 32-byte value provided as 64 hex chars via
// ENCRYPTION_KEY.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce recommended for GCM
const VERSION = 'v1';

function getKey(): Buffer {
  const key = Buffer.from(env.ENCRYPTION_KEY, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters');
  }
  return key;
}

/** Encrypts a UTF-8 plaintext string. Returns a versioned, self-describing token. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Decrypts a token produced by {@link encryptSecret}. Throws if tampered or malformed. */
export function decryptSecret(token: string): string {
  const parts = token.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed or unsupported encrypted secret');
  }
  const [, ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex as string, 'hex');
  const authTag = Buffer.from(authTagHex as string, 'hex');
  const ciphertext = Buffer.from(ciphertextHex as string, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** True if the value looks like an encrypted token (vs. a legacy plaintext value). */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`);
}

/**
 * Decrypts a stored secret, transparently passing through legacy plaintext
 * values that predate encryption. This keeps existing rows working while new
 * writes are always encrypted.
 */
export function decryptSecretCompat(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isEncrypted(value)) return value;
  return decryptSecret(value);
}
