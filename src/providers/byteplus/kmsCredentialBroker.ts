import type { CredentialProvider } from '../types.js';

/**
 * KMS-backed credential broker — SEAM, not wired (memo §10 maps Secrets → KMS).
 *
 * The local broker (`src/providers/local/credentialBroker.ts`) keeps the
 * AES-256 data key in an env var. The production hardening is envelope
 * encryption: store each secret encrypted under a data key, wrap the data key
 * with a BytePlus KMS customer master key, and unwrap it via KMS at release time
 * so the plaintext key never lives in app config. The store, scoping, and
 * consume-on-use logic (src/store/credentials.ts) are identical — only key
 * custody changes.
 *
 * To implement: on `resolve`, look up + consume the credential (reuse
 * `consumeCredential`), call KMS `Decrypt` to unwrap the data key, then decrypt
 * the secret. Needs a KMS client + a provisioned CMK + IAM permission — none
 * carried here yet. Until implemented, selecting this adapter throws.
 */
export class KmsCredentialProvider implements CredentialProvider {
  async resolve(): Promise<{ headerName: string; headerValue: string } | null> {
    throw new Error(
      'KmsCredentialProvider is a seam — implement KMS envelope decryption and ' +
        'provision a CMK before using it (see src/providers/byteplus/kmsCredentialBroker.ts)',
    );
  }
}
