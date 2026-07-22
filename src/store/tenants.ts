import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { newId } from '../ids.js';

type Q = Pool | Tx;

export interface TenantRow {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  max_concurrent_runs: number | null;
  daily_token_budget: string | null; // BIGINT as string
  created_at: Date;
}

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  key_hash: string;
  name: string | null;
  status: 'active' | 'revoked';
  created_at: Date;
  last_used_at: Date | null;
}

export interface ApiKeyResolution {
  tenant: TenantRow;
  principalId: string;
}

/** SHA-256 of the presented key; only the hash is ever stored or compared. */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export interface TenantQuota {
  maxConcurrentRuns?: number;
  dailyTokenBudget?: number;
}

export async function createTenant(
  q: Q,
  input: { name: string; quota?: TenantQuota; id?: string },
): Promise<TenantRow> {
  const id = input.id ?? newId('tnt');
  const { rows } = await q.query<TenantRow>(
    `INSERT INTO tenants (id, name, max_concurrent_runs, daily_token_budget)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, input.name, input.quota?.maxConcurrentRuns ?? null, input.quota?.dailyTokenBudget ?? null],
  );
  return rows[0]!;
}

/**
 * Mint an API key for a tenant. Returns the PLAINTEXT key exactly once — it is
 * never persisted or logged; only its SHA-256 hash is stored. The caller must
 * hand the plaintext to the user immediately and then forget it.
 */
export async function createApiKey(
  q: Q,
  input: { tenantId: string; name?: string },
): Promise<{ id: string; plaintext: string }> {
  const id = newId('key');
  // 32 random bytes → base64url; prefixed so keys are recognizable in logs/UI
  // without revealing the secret (the prefix is not secret; the body is).
  const plaintext = `mak_${randomBytes(32).toString('base64url')}`;
  await q.query(
    `INSERT INTO api_keys (id, tenant_id, key_hash, name) VALUES ($1, $2, $3, $4)`,
    [id, input.tenantId, hashApiKey(plaintext), input.name ?? null],
  );
  return { id, plaintext };
}

/**
 * Resolve a presented API key to its active tenant, or null. Touches
 * last_used_at (best-effort). Only active keys of active tenants resolve.
 */
export async function resolveApiKeyContext(
  pool: Pool,
  plaintext: string,
): Promise<ApiKeyResolution | null> {
  const { rows } = await pool.query<TenantRow & { key_id: string }>(
    `SELECT t.*, k.id AS key_id
     FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = $1 AND k.status = 'active' AND t.status = 'active'`,
    [hashApiKey(plaintext)],
  );
  const row = rows[0];
  if (!row) return null;
  const { key_id: keyId, ...tenant } = row;
  // Best-effort usage stamp; never block auth on it.
  void pool
    .query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [keyId])
    .catch(() => {});
  return { tenant, principalId: `api-key:${keyId}` };
}

export async function resolveApiKey(pool: Pool, plaintext: string): Promise<TenantRow | null> {
  return (await resolveApiKeyContext(pool, plaintext))?.tenant ?? null;
}

export async function getTenant(q: Q, id: string): Promise<TenantRow | null> {
  const { rows } = await q.query<TenantRow>('SELECT * FROM tenants WHERE id = $1', [id]);
  return rows[0] ?? null;
}
