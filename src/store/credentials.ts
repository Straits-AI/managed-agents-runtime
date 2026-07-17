import type { Pool } from 'pg';
import { withTransaction } from '../db/tx.js';
import { newId } from '../ids.js';
import type { Sealed } from '../crypto.js';
import type { SecretCipher } from '../providers/secretCipher.js';
import { patternMatches } from './grants.js';

export interface CredentialRow {
  id: string;
  tenant_id: string;
  name: string;
  action_pattern: string;
  resource_pattern: string;
  header_name: string;
  secret_ct: string;
  iv: string;
  auth_tag: string;
  expires_at: Date | null;
  max_uses: number | null;
  uses: number;
  status: string;
  created_at: Date;
}

export async function createCredential(
  pool: Pool,
  input: {
    tenantId: string;
    name: string;
    action: string;
    resource?: string;
    headerName: string;
    secret: string;
    cipher: SecretCipher;
    expiresAt?: string;
    maxUses?: number;
  },
): Promise<{ id: string }> {
  const id = newId('cred');
  const sealed = await input.cipher.seal(input.secret);
  await pool.query(
    `INSERT INTO credentials
       (id, tenant_id, name, action_pattern, resource_pattern, header_name,
        secret_ct, iv, auth_tag, expires_at, max_uses)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      input.tenantId,
      input.name,
      input.action,
      input.resource ?? '*',
      input.headerName,
      sealed.ct,
      sealed.iv,
      sealed.tag,
      input.expiresAt ?? null,
      input.maxUses ?? null,
    ],
  );
  return { id };
}

/** Non-secret metadata for listing (never returns ciphertext). */
export async function listCredentials(pool: Pool, tenantId: string) {
  const { rows } = await pool.query(
    `SELECT id, name, action_pattern, resource_pattern, header_name, expires_at,
            max_uses, uses, status, created_at
     FROM credentials WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return rows;
}

export async function revokeCredential(pool: Pool, id: string, tenantId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE credentials SET status = 'revoked' WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Find and CONSUME one credential matching a run's outbound action+resource for
 * its tenant (memo §9.5): active, unexpired, within its call limit. Row-locks
 * and increments `uses` so a max-use budget holds under concurrency (mirrors
 * capability `authorizeAndConsume`). Returns the sealed secret + header, or null.
 */
export async function consumeCredential(
  pool: Pool,
  input: { tenantId: string; action: string; resource: string },
): Promise<{ headerName: string; sealed: Sealed } | null> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<CredentialRow>(
      `SELECT * FROM credentials
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY created_at ASC
       FOR UPDATE`,
      [input.tenantId],
    );
    const now = new Date();
    const match = rows.find(
      (c) =>
        patternMatches(c.action_pattern, input.action) &&
        patternMatches(c.resource_pattern, input.resource) &&
        (c.expires_at === null || c.expires_at > now) &&
        (c.max_uses === null || c.uses < c.max_uses),
    );
    if (!match) return null;
    await tx.query('UPDATE credentials SET uses = uses + 1 WHERE id = $1', [match.id]);
    return {
      headerName: match.header_name,
      sealed: { ct: match.secret_ct, iv: match.iv, tag: match.auth_tag },
    };
  });
}
