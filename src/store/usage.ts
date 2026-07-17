import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { estimateModelCostUsd, type ModelPrice } from '../core/costs.js';

type Q = Pool | Tx;

export interface RunUsage {
  runId: string;
  tenantId: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelCalls: number;
  attempts: number;
  estimatedCostUsd: number;
}

/**
 * Per-run usage rollup. Token totals come from the durable `runs.tokens_used`
 * counter split by the per-step `ModelInvocationCompleted` event payloads;
 * model-call and attempt counts come from the ledger and attempts table.
 */
export async function runUsage(q: Q, runId: string, price: ModelPrice): Promise<RunUsage | null> {
  const { rows } = await q.query<{
    tenant_id: string;
    status: string;
    input_tokens: string;
    output_tokens: string;
    model_calls: string;
    attempts: string;
  }>(
    `SELECT r.tenant_id, r.status,
            COALESCE(SUM((e.payload->'usage'->>'inputTokens')::bigint), 0)  AS input_tokens,
            COALESCE(SUM((e.payload->'usage'->>'outputTokens')::bigint), 0) AS output_tokens,
            COUNT(e.*) FILTER (WHERE e.type = 'ModelInvocationCompleted')    AS model_calls,
            (SELECT COUNT(*) FROM run_attempts a WHERE a.run_id = r.id)      AS attempts
     FROM runs r
     LEFT JOIN run_events e
       ON e.run_id = r.id AND e.type = 'ModelInvocationCompleted'
     WHERE r.id = $1
     GROUP BY r.id, r.tenant_id, r.status`,
    [runId],
  );
  const row = rows[0];
  if (!row) return null;
  const inputTokens = Number(row.input_tokens);
  const outputTokens = Number(row.output_tokens);
  return {
    runId,
    tenantId: row.tenant_id,
    status: row.status,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    modelCalls: Number(row.model_calls),
    attempts: Number(row.attempts),
    estimatedCostUsd: estimateModelCostUsd(inputTokens, outputTokens, price),
  };
}

export interface TenantUsage {
  tenantId: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  since: string;
}

/**
 * Tenant-wide usage since `sinceIso` (default: start of the current UTC day).
 * Aggregates the input/output token split from the ledger across the tenant's
 * runs so cost can be priced accurately (not a hot path).
 */
export async function tenantUsage(
  pool: Pool,
  tenantId: string,
  price: ModelPrice,
  sinceIso?: string,
): Promise<TenantUsage> {
  const since = sinceIso ?? new Date(new Date().toISOString().slice(0, 10)).toISOString();
  const { rows } = await pool.query<{
    runs: string;
    input_tokens: string;
    output_tokens: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM runs r WHERE r.tenant_id = $1 AND r.created_at >= $2) AS runs,
       COALESCE(SUM((e.payload->'usage'->>'inputTokens')::bigint), 0)  AS input_tokens,
       COALESCE(SUM((e.payload->'usage'->>'outputTokens')::bigint), 0) AS output_tokens
     FROM runs r
     JOIN run_events e ON e.run_id = r.id AND e.type = 'ModelInvocationCompleted'
     WHERE r.tenant_id = $1 AND r.created_at >= $2`,
    [tenantId, since],
  );
  const inputTokens = Number(rows[0]!.input_tokens);
  const outputTokens = Number(rows[0]!.output_tokens);
  return {
    tenantId,
    runs: Number(rows[0]!.runs),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: estimateModelCostUsd(inputTokens, outputTokens, price),
    since,
  };
}

/** Count a tenant's runs that are not in a terminal state (for concurrency quota). */
export async function countActiveRuns(pool: Pool, tenantId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM runs
     WHERE tenant_id = $1 AND status <> ALL($2::text[])`,
    [tenantId, ['COMPLETED', 'FAILED', 'CANCELLED']],
  );
  return Number(rows[0]!.n);
}

/** Sum a tenant's tokens_used across runs created since the start of the UTC day. */
export async function tenantTokensToday(pool: Pool, tenantId: string): Promise<bigint> {
  const since = new Date(new Date().toISOString().slice(0, 10)).toISOString();
  const { rows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(tokens_used), 0) AS total
     FROM runs WHERE tenant_id = $1 AND created_at >= $2`,
    [tenantId, since],
  );
  return BigInt(rows[0]!.total);
}
