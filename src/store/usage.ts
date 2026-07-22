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
  until: string;
}

/**
 * Tenant-wide usage in the half-open `[since, until)` window. Token attribution
 * uses immutable ModelInvocationCompleted event time; the independent run count
 * describes Runs created in the same window. The default is the current UTC day,
 * matching daily admission. A caller-supplied `since` without `until` preserves
 * the historical `since`-through-now behavior.
 */
export async function tenantUsage(
  pool: Pool,
  tenantId: string,
  price: ModelPrice,
  sinceIso?: string,
  untilIso?: string,
): Promise<TenantUsage> {
  const now = new Date();
  const utcDayStart = new Date(now.toISOString().slice(0, 10));
  const sinceDate = sinceIso === undefined ? utcDayStart : new Date(sinceIso);
  const untilDate = untilIso === undefined
    ? sinceIso === undefined
      ? new Date(utcDayStart.getTime() + 24 * 60 * 60 * 1_000)
      : now
    : new Date(untilIso);
  if (
    !Number.isFinite(sinceDate.getTime()) ||
    !Number.isFinite(untilDate.getTime()) ||
    sinceDate >= untilDate
  ) {
    throw new Error('usage window must be valid and satisfy since < until');
  }
  const since = sinceDate.toISOString();
  const until = untilDate.toISOString();
  const { rows } = await pool.query<{
    runs: string;
    input_tokens: string;
    output_tokens: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM runs counted_run
        WHERE counted_run.tenant_id = $1
          AND counted_run.created_at >= $2
          AND counted_run.created_at < $3) AS runs,
       COALESCE(SUM((e.payload->'usage'->>'inputTokens')::bigint), 0)  AS input_tokens,
       COALESCE(SUM((e.payload->'usage'->>'outputTokens')::bigint), 0) AS output_tokens
     FROM runs r
     JOIN run_events e ON e.run_id = r.id AND e.type = 'ModelInvocationCompleted'
     WHERE r.tenant_id = $1
       AND e.created_at >= $2
       AND e.created_at < $3`,
    [tenantId, since, until],
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
    until,
  };
}
