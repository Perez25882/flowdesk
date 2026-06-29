import { describe, it, expect } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  decryptSecretCompat,
} from '../src/utils/crypto.js';

describe('crypto (AES-256-GCM secret encryption)', () => {
  it('round-trips a secret value', () => {
    const plaintext = 'EAAG-some-long-whatsapp-access-token-value-12345';
    const token = encryptSecret(plaintext);
    expect(token).not.toEqual(plaintext);
    expect(decryptSecret(token)).toEqual(plaintext);
  });

  it('produces a versioned, self-describing token', () => {
    const token = encryptSecret('hello');
    expect(token.startsWith('v1:')).toBe(true);
    expect(token.split(':')).toHaveLength(4);
    expect(isEncrypted(token)).toBe(true);
  });

  it('uses a unique IV per encryption (ciphertexts differ)', () => {
    const a = encryptSecret('same-input');
    const b = encryptSecret('same-input');
    expect(a).not.toEqual(b);
    expect(decryptSecret(a)).toEqual(decryptSecret(b));
  });

  it('rejects a tampered ciphertext', () => {
    const token = encryptSecret('sensitive');
    const parts = token.split(':');
    // Flip a character in the ciphertext segment.
    const ciphertext = parts[3] as string;
    const tamperedChar = ciphertext[0] === 'a' ? 'b' : 'a';
    parts[3] = tamperedChar + ciphertext.slice(1);
    const tampered = parts.join(':');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects malformed tokens', () => {
    expect(() => decryptSecret('not-a-valid-token')).toThrow();
    expect(() => decryptSecret('v2:aa:bb:cc')).toThrow();
  });

  describe('decryptSecretCompat', () => {
    it('returns null for null/undefined', () => {
      expect(decryptSecretCompat(null)).toBeNull();
      expect(decryptSecretCompat(undefined)).toBeNull();
    });

    it('passes through legacy plaintext values', () => {
      expect(decryptSecretCompat('legacy-plaintext-token')).toEqual('legacy-plaintext-token');
    });

    it('decrypts encrypted values', () => {
      const token = encryptSecret('real-secret');
      expect(decryptSecretCompat(token)).toEqual('real-secret');
    });
  });
});
