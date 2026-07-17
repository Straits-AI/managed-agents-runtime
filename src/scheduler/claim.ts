import type { Pool } from 'pg';
import { withTransaction } from '../db/tx.js';
import type { RunAttemptRow, RunRow } from '../core/types.js';
import { transitionRun } from '../core/transition.js';
import { newId } from '../ids.js';

export interface ClaimedRun {
  run: RunRow;
  attempt: RunAttemptRow;
}

/**
 * Claim one QUEUED run (memo §14): FOR UPDATE SKIP LOCKED so concurrent
 * workers never double-claim, then — in the same transaction — transition
 * to STARTING and create an ACTIVE attempt holding a time-limited lease.
 */
export async function claimRun(
  pool: Pool,
  workerId: string,
  leaseTtlMs: number,
): Promise<ClaimedRun | null> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM runs
       WHERE status = 'QUEUED'
         AND (scheduled_for IS NULL OR scheduled_for <= now())
       ORDER BY updated_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (rows.length === 0) return null;
    const runId = rows[0]!.id;

    const { rows: nrows } = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM run_attempts WHERE run_id = $1`,
      [runId],
    );
    const attemptNo = nrows[0]!.next;
    const attemptId = newId('att');

    const { rows: arows } = await tx.query<RunAttemptRow>(
      `INSERT INTO run_attempts
         (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now() + ($5 || ' milliseconds')::interval)
       RETURNING *`,
      [attemptId, runId, attemptNo, workerId, String(leaseTtlMs)],
    );

    const run = await transitionRun(tx, runId, {
      expectFrom: ['QUEUED'],
      to: 'STARTING',
      event: { type: 'AttemptStarted', payload: { attemptNo, workerId } },
      attemptId,
      patch: { current_attempt_id: attemptId },
    });
    return { run, attempt: arows[0]! };
  });
}
