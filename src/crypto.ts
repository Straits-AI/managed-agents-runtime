import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** An AES-256-GCM sealed secret; all fields base64. */
export interface Sealed {
  ct: string;
  iv: string;
  tag: string;
}

/** Load and validate a 32-byte (base64) AES-256 key. */
export function loadKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('encryption key must decode to 32 bytes (base64-encoded AES-256 key)');
  }
  return key;
}

/** Encrypt with AES-256-GCM (random 96-bit IV, authenticated). */
export function encryptSecret(plaintext: string, key: Buffer): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/** Decrypt; throws if the ciphertext or tag has been tampered with. */
export function decryptSecret(sealed: Sealed, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
