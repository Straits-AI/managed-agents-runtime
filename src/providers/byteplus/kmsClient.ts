import { signedCall } from './signer.js';

/**
 * Minimal BytePlus KMS client (top-gateway Encrypt/Decrypt), signed with the
 * same SignerV4 used for other BytePlus OpenAPI services. Secrets are small
 * (tokens/headers), so we encrypt them directly under the CMK rather than using
 * envelope data keys.
 */
export interface KmsClientConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  host: string; // e.g. open.byteplusapi.com
  region: string; // e.g. ap-southeast-1
  keyringName: string;
  keyName: string;
}

const SERVICE = 'kms';
const VERSION = '2021-02-18';

export class KmsClient {
  constructor(private readonly cfg: KmsClientConfig) {}

  /** Encrypt a UTF-8 secret; returns the KMS ciphertext blob (base64). */
  async encrypt(plaintext: string): Promise<string> {
    const res = await signedCall<{ CiphertextBlob: string }>({
      host: this.cfg.host,
      region: this.cfg.region,
      service: SERVICE,
      action: 'Encrypt',
      version: VERSION,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      sessionToken: this.cfg.sessionToken,
      body: JSON.stringify({
        KeyringName: this.cfg.keyringName,
        KeyName: this.cfg.keyName,
        Plaintext: Buffer.from(plaintext, 'utf8').toString('base64'),
      }),
    });
    return res.CiphertextBlob;
  }

  /** Decrypt a KMS ciphertext blob back to the UTF-8 secret. */
  async decrypt(ciphertextBlob: string): Promise<string> {
    const res = await signedCall<{ Plaintext: string }>({
      host: this.cfg.host,
      region: this.cfg.region,
      service: SERVICE,
      action: 'Decrypt',
      version: VERSION,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      sessionToken: this.cfg.sessionToken,
      body: JSON.stringify({ CiphertextBlob: ciphertextBlob }),
    });
    return Buffer.from(res.Plaintext, 'base64').toString('utf8');
  }
}
