import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedSecret {
  /** base64(ciphertext || authTag) */
  ciphertext: string;
  /** base64 12-byte IV */
  iv: string;
}

export class SecretDecryptError extends Error {
  constructor(message = 'Failed to decrypt secret with any configured key') {
    super(message);
    this.name = 'SecretDecryptError';
  }
}

/** Decodes a base64 encryption key and checks it is exactly 32 bytes (AES-256). */
export function parseEncKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be base64 of ${KEY_BYTES.toString()} bytes`);
  }
  return key;
}

export function isValidEncKey(b64: string): boolean {
  try {
    parseEncKey(b64);
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([ciphertext, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

/**
 * Decrypts with each key in order (current key first, then previous keys), so
 * secrets written before a key rotation stay readable. GCM authentication
 * rejects a wrong key, so the first key that authenticates wins.
 */
export function decryptSecret(secret: EncryptedSecret, keys: Buffer | Buffer[]): string {
  const keyring = Array.isArray(keys) ? keys : [keys];
  const data = Buffer.from(secret.ciphertext, 'base64');
  const iv = Buffer.from(secret.iv, 'base64');
  if (data.length < TAG_BYTES || iv.length !== IV_BYTES) {
    throw new SecretDecryptError('Malformed encrypted secret');
  }
  const ciphertext = data.subarray(0, data.length - TAG_BYTES);
  const tag = data.subarray(data.length - TAG_BYTES);

  for (const key of keyring) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // wrong key or tampered data — try the next key
    }
  }
  throw new SecretDecryptError();
}

/** Masks a secret for display, keeping only the last 4 characters. */
export function maskSecret(secret: string): string {
  const visible = secret.length > 8 ? secret.slice(-4) : '';
  return `••••••••${visible}`;
}
