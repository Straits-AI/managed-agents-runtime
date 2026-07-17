import { encryptSecret, decryptSecret, type Sealed } from '../crypto.js';

/**
 * Pluggable secret encryption for the credential broker. `LocalCipher` uses an
 * AES-256-GCM key held in config; `KmsCipher` (providers/byteplus) delegates to
 * BytePlus KMS. The store persists a `Sealed` blob either way — for KMS the ct
 * is the KMS ciphertext and iv/tag are unused.
 */
export interface SecretCipher {
  seal(plaintext: string): Promise<Sealed>;
  open(sealed: Sealed): Promise<string>;
}

export class LocalCipher implements SecretCipher {
  constructor(private readonly key: Buffer) {}
  async seal(plaintext: string): Promise<Sealed> {
    return encryptSecret(plaintext, this.key);
  }
  async open(sealed: Sealed): Promise<string> {
    return decryptSecret(sealed, this.key);
  }
}
