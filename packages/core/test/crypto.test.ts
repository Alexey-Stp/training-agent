import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  parseEncKey,
  SecretDecryptError,
} from '../src/crypto';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const PLAINTEXT = 'icu-api-key-0123456789abcdef';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips plaintext', () => {
    const enc = encryptSecret(PLAINTEXT, KEY);
    expect(decryptSecret(enc, KEY)).toBe(PLAINTEXT);
  });

  it('ciphertext differs from and does not contain the plaintext', () => {
    const enc = encryptSecret(PLAINTEXT, KEY);
    expect(enc.ciphertext).not.toBe(PLAINTEXT);
    expect(enc.ciphertext).not.toContain(PLAINTEXT);
    expect(Buffer.from(enc.ciphertext, 'base64').toString('utf8')).not.toContain(PLAINTEXT);
  });

  it('uses a fresh 12-byte IV for each encryption', () => {
    const a = encryptSecret(PLAINTEXT, KEY);
    const b = encryptSecret(PLAINTEXT, KEY);
    expect(Buffer.from(a.iv, 'base64')).toHaveLength(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('throws SecretDecryptError with the wrong key', () => {
    const enc = encryptSecret(PLAINTEXT, KEY);
    expect(() => decryptSecret(enc, OTHER_KEY)).toThrow(SecretDecryptError);
  });

  it('throws SecretDecryptError when ciphertext is tampered with', () => {
    const enc = encryptSecret(PLAINTEXT, KEY);
    const bytes = Buffer.from(enc.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    expect(() => decryptSecret({ ...enc, ciphertext: bytes.toString('base64') }, KEY)).toThrow(
      SecretDecryptError
    );
  });

  it('throws SecretDecryptError on malformed input', () => {
    expect(() => decryptSecret({ ciphertext: 'AA==', iv: 'AA==' }, KEY)).toThrow(
      SecretDecryptError
    );
  });

  it('rotation: decrypts data written with the previous key using [current, previous]', () => {
    const enc = encryptSecret(PLAINTEXT, OTHER_KEY);
    expect(decryptSecret(enc, [KEY, OTHER_KEY])).toBe(PLAINTEXT);
  });
});

describe('parseEncKey', () => {
  it('accepts base64 of 32 bytes', () => {
    expect(parseEncKey(KEY.toString('base64'))).toEqual(KEY);
  });

  it('rejects keys of the wrong length', () => {
    expect(() => parseEncKey(randomBytes(16).toString('base64'))).toThrow();
    expect(() => parseEncKey('')).toThrow();
  });
});

describe('maskSecret', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskSecret('abcdefghijkl')).toBe('••••••••ijkl');
  });

  it('hides short secrets completely', () => {
    expect(maskSecret('abc')).toBe('••••••••');
  });
});
