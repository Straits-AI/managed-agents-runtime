import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import type { RunAttemptRow } from '../core/types.js';

type Q = Pool | Tx;

export async function getAttempt(q: Q, id: string): Promise<RunAttemptRow | null> {
  const { rows } = await q.query<RunAttemptRow>(
    'SELECT * FROM run_attempts WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function listAttempts(q: Q, runId: string): Promise<RunAttemptRow[]> {
  const { rows } = await q.query<RunAttemptRow>(
    'SELECT * FROM run_attempts WHERE run_id = $1 ORDER BY attempt_no ASC',
    [runId],
  );
  return rows;
}

export async function countActiveAttempts(q: Q, runId: string): Promise<number> {
  const { rows } = await q.query<{ n: string }>(
    `SELECT count(*) AS n FROM run_attempts WHERE run_id = $1 AND state = 'ACTIVE'`,
    [runId],
  );
  return Number(rows[0]!.n);
}

/**
 * Renew a worker's lease. Returns false when the lease was lost (attempt
 * no longer ACTIVE) — the worker must abort its epoch immediately (fencing).
 */
export async function heartbeatAttempt(
  q: Q,
  attemptId: string,
  leaseTtlMs: number,
): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE run_attempts
     SET heartbeat_at = now(),
         lease_expires_at = now() + ($2 || ' milliseconds')::interval
     WHERE id = $1 AND state = 'ACTIVE'`,
    [attemptId, String(leaseTtlMs)],
  );
  return (rowCount ?? 0) > 0;
}

export async function setAttemptSandbox(
  q: Q,
  attemptId: string,
  sandboxId: string,
  sandboxDomain: string | null,
): Promise<void> {
  await q.query(
    `UPDATE run_attempts SET sandbox_id = $2, sandbox_domain = $3 WHERE id = $1`,
    [attemptId, sandboxId, sandboxDomain],
  );
}

/** Mark an attempt exited. Only valid while it is still ACTIVE. */
export async function exitAttempt(
  tx: Tx,
  attemptId: string,
  exitReason: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE run_attempts SET state = 'EXITED', exit_reason = $2
     WHERE id = $1 AND state = 'ACTIVE'`,
    [attemptId, exitReason],
  );
  return (rowCount ?? 0) > 0;
}
