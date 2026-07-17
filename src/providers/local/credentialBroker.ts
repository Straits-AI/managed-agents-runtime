import type { Pool } from 'pg';
import type { CredentialProvider } from '../types.js';
import { consumeCredential } from '../../store/credentials.js';
import { decryptSecret } from '../../crypto.js';

/**
 * Local credential broker: credentials live encrypted (AES-256-GCM) in Postgres;
 * this holds the decryption key and releases a matching credential's header for
 * a run's outbound call. The KMS adapter (seam) differs only in where the key
 * lives — the store, scoping, and consume-on-use logic are identical.
 */
export class LocalCredentialProvider implements CredentialProvider {
  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer,
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
    return { headerName: hit.headerName, headerValue: decryptSecret(hit.sealed, this.key) };
  }
}
