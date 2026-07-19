import type { Pool } from 'pg';
import type { CredentialProvider } from './types.js';
import type { SecretCipher } from './secretCipher.js';
import { consumeCredential } from '../store/credentials.js';
import type { CredentialReleaseRequest } from '../core/credentials.js';

/**
 * Credential broker (memo §9.5, §19 layer 5): releases a tenant's scoped secret
 * for a run's outbound call after the store atomically verifies the execution
 * subject, lineage, caller, purpose, action, resource, approval, expiry, and
 * use limit and records a secret-free receipt. Decryption is delegated to a SecretCipher — LocalCipher
 * (AES-256-GCM key in config) or KmsCipher (BytePlus KMS) — so key custody is a
 * deployment choice, not a code change.
 */
export class CredentialBroker implements CredentialProvider {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: SecretCipher,
  ) {}

  async resolve(input: CredentialReleaseRequest): Promise<{
    headerName: string;
    headerValue: string;
  } | null> {
    return consumeCredential(this.pool, input, this.cipher);
  }
}
