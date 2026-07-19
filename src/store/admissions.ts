import type { Tx } from '../db/tx.js';

export type RunAdmissionKind = 'direct' | 'fork' | 'delegated' | 'replacement';

export type RunAdmissionReason =
  | 'tenant_unavailable'
  | 'concurrency_exhausted'
  | 'token_capacity_exhausted';

export class RunAdmissionRejectedError extends Error {
  constructor(public readonly reason: RunAdmissionReason) {
    super(
      reason === 'concurrency_exhausted'
        ? 'concurrent run quota exceeded'
        : reason === 'token_capacity_exhausted'
          ? 'daily token capacity exhausted'
          : 'tenant is unavailable',
    );
    this.name = 'RunAdmissionRejectedError';
  }
}

interface AdmissionCapacity {
  reservedTokens: bigint;
  effectiveTokenBudget: bigint | null;
}

export async function lockRunAdmissionTenantRow(
  tx: Tx,
  tenantId: string,
): Promise<{
  status: string;
  max_concurrent_runs: number | null;
  daily_token_budget: string | null;
}> {
  const { rows } = await tx.query<{
    status: string;
    max_concurrent_runs: number | null;
    daily_token_budget: string | null;
  }>(
    `SELECT status, max_concurrent_runs, daily_token_budget
     FROM tenants WHERE id = $1 FOR UPDATE`,
    [tenantId],
  );
  const tenant = rows[0];
  if (!tenant) {
    throw new RunAdmissionRejectedError('tenant_unavailable');
  }
  return tenant;
}

export async function lockRunAdmissionTenant(
  tx: Tx,
  tenantId: string,
): ReturnType<typeof lockRunAdmissionTenantRow> {
  const tenant = await lockRunAdmissionTenantRow(tx, tenantId);
  if (tenant.status !== 'active') {
    throw new RunAdmissionRejectedError('tenant_unavailable');
  }
  return tenant;
}

/**
 * Serialize admission for one tenant and reserve capacity before any run-owned
 * rows are created. Existing active reservations are authoritative; stale ones
 * whose runs are terminal are reconciled while the tenant lock is held.
 */
export async function prepareRunAdmission(
  tx: Tx,
  input: { tenantId: string; tokenBudget?: number | string | bigint },
): Promise<AdmissionCapacity> {
  const tenant = await lockRunAdmissionTenant(tx, input.tenantId);

  await tx.query(
    `UPDATE run_admissions a
     SET status = 'released', released_at = now(), release_reason = 'reconciled_terminal'
     FROM runs r
     WHERE a.run_id = r.id AND a.tenant_id = $1 AND a.status = 'active'
       AND r.status IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
    [input.tenantId],
  );

  const { rows: activeRows } = await tx.query<{ active: string }>(
    `SELECT COUNT(*) AS active FROM run_admissions
     WHERE tenant_id = $1 AND status = 'active'`,
    [input.tenantId],
  );
  if (
    tenant.max_concurrent_runs !== null &&
    BigInt(activeRows[0]!.active) >= BigInt(tenant.max_concurrent_runs)
  ) {
    throw new RunAdmissionRejectedError('concurrency_exhausted');
  }

  const requested =
    input.tokenBudget === undefined ? null : BigInt(input.tokenBudget);
  if (requested !== null && requested <= 0n) {
    throw new RunAdmissionRejectedError('token_capacity_exhausted');
  }
  if (tenant.daily_token_budget === null) {
    return {
      reservedTokens: requested ?? 0n,
      effectiveTokenBudget: requested,
    };
  }

  const { rows: tokenRows } = await tx.query<{
    used_today: string;
    remaining_reserved: string;
  }>(
    `SELECT
       COALESCE((
         SELECT SUM(
           COALESCE((e.payload->'usage'->>'inputTokens')::bigint, 0) +
           COALESCE((e.payload->'usage'->>'outputTokens')::bigint, 0)
         )
         FROM run_events e
         JOIN runs used_run ON used_run.id = e.run_id
         WHERE used_run.tenant_id = $1
           AND e.type = 'ModelInvocationCompleted'
           AND e.created_at >=
               (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
           AND e.created_at <
               (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
               + interval '1 day'
       ), 0) AS used_today,
       COALESCE((
         SELECT SUM(GREATEST(a.reserved_tokens - r.tokens_used, 0))
         FROM run_admissions a
         JOIN runs r ON r.id = a.run_id
         WHERE a.tenant_id = $1 AND a.status = 'active'
       ), 0) AS remaining_reserved`,
    [input.tenantId],
  );
  const daily = BigInt(tenant.daily_token_budget);
  const available =
    daily - BigInt(tokenRows[0]!.used_today) - BigInt(tokenRows[0]!.remaining_reserved);
  const reservation = requested ?? available;
  if (reservation <= 0n || reservation > available) {
    throw new RunAdmissionRejectedError('token_capacity_exhausted');
  }
  return { reservedTokens: reservation, effectiveTokenBudget: reservation };
}

export async function recordRunAdmission(
  tx: Tx,
  input: {
    runId: string;
    tenantId: string;
    kind: RunAdmissionKind;
    reservedTokens: bigint;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO run_admissions (run_id, tenant_id, kind, reserved_tokens)
     VALUES ($1, $2, $3, $4)`,
    [input.runId, input.tenantId, input.kind, input.reservedTokens.toString()],
  );
}

export async function releaseRunAdmission(
  tx: Tx,
  runId: string,
  reason: string,
): Promise<void> {
  await tx.query(
    `UPDATE run_admissions
     SET status = 'released', released_at = now(), release_reason = $2
     WHERE run_id = $1 AND status = 'active'`,
    [runId, reason],
  );
}
