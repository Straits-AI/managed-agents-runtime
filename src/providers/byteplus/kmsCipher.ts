import type { SecretCipher } from '../secretCipher.js';
import type { Sealed } from '../../crypto.js';
import type { KmsClient } from './kmsClient.js';

/**
 * SecretCipher backed by BytePlus KMS (memo §10 Secrets → KMS). The plaintext
 * key never lives in app config; encrypt/decrypt happen in KMS. The store's
 * Sealed.ct holds the KMS ciphertext; iv/tag are unused.
 */
export class KmsCipher implements SecretCipher {
  constructor(private readonly kms: KmsClient) {}
  async seal(plaintext: string): Promise<Sealed> {
    return { ct: await this.kms.encrypt(plaintext), iv: '', tag: '' };
  }
  async open(sealed: Sealed): Promise<string> {
    return this.kms.decrypt(sealed.ct);
  }
}
