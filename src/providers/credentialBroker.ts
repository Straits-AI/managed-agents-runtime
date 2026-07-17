import type { Pool } from 'pg';
import type { CredentialProvider } from './types.js';
import type { SecretCipher } from './secretCipher.js';
import { consumeCredential } from '../store/credentials.js';

/**
 * Credential broker (memo §9.5, §19 layer 5): releases a tenant's scoped secret
 * for a run's outbound call after the store verifies tenant + action + resource
 * + expiry + call-limit. Decryption is delegated to a SecretCipher — LocalCipher
 * (AES-256-GCM key in config) or KmsCipher (BytePlus KMS) — so key custody is a
 * deployment choice, not a code change.
 */
export class CredentialBroker implements CredentialProvider {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: SecretCipher,
  ) {}

  async resolve(input: {
    tenantId: string;
    runId: string;
    action: string;
    resource: string;
  }): Promise<{ headerName: string; headerValue: string } | null> {
    const hit = await consumeCredential(this.pool, {
      tenantId: input.tenantId,
      action: input.action,
      resource: input.resource,
    });
    if (!hit) return null;
    return { headerName: hit.headerName, headerValue: await this.cipher.open(hit.sealed) };
  }
}
