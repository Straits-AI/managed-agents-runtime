import type { Pool } from 'pg';
import { withTransaction } from '../db/tx.js';
import { transitionRun } from '../core/transition.js';
import type { RunAttemptRow } from '../core/types.js';

export interface ReapedAttempt {
  attempt: RunAttemptRow;
  outcome: 'requeued' | 'failed';
}

/**
 * Detect orphaned attempts (memo §14): ACTIVE attempts whose lease has
 * expired. Mark them ORPHANED, then requeue the run — or FAIL it once
 * maxAttempts is exhausted. Returns sandbox ids so the caller can
 * best-effort terminate them.
 */
export async function reapExpiredLeases(
  pool: Pool,
  maxAttempts: number,
): Promise<ReapedAttempt[]> {
  const reaped: ReapedAttempt[] = [];

  for (;;) {
    const result = await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<RunAttemptRow>(
        `SELECT * FROM run_attempts
         WHERE state = 'ACTIVE' AND lease_expires_at < now()
         ORDER BY lease_expires_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      const attempt = rows[0];
      if (!attempt) return null;

      await tx.query(
        `UPDATE run_attempts SET state = 'ORPHANED', exit_reason = 'lease_expired'
         WHERE id = $1`,
        [attempt.id],
      );

      // The run may legitimately be elsewhere (e.g. WAITING_APPROVAL wrote
      // its own transition before the worker died) — only requeue if it is
      // still in an execution status tied to this attempt.
      const { rows: runRows } = await tx.query<{ status: string }>(
        `SELECT status FROM runs WHERE id = $1 FOR UPDATE`,
        [attempt.run_id],
      );
      const status = runRows[0]!.status;
      if (status !== 'STARTING' && status !== 'RUNNING' && status !== 'VERIFYING') {
        return { attempt, outcome: 'requeued' as const, skippedTransition: true };
      }

      if (attempt.attempt_no >= maxAttempts) {
        await transitionRun(tx, attempt.run_id, {
          expectFrom: ['STARTING', 'RUNNING', 'VERIFYING'],
          to: 'FAILED',
          event: {
            type: 'RunFailed',
            payload: { reason: 'max_attempts_exhausted', attemptNo: attempt.attempt_no },
          },
          attemptId: attempt.id,
          reason: 'max_attempts_exhausted',
        });
        return { attempt, outcome: 'failed' as const };
      }

      await transitionRun(tx, attempt.run_id, {
        expectFrom: ['STARTING', 'RUNNING', 'VERIFYING'],
        to: 'QUEUED',
        event: {
          type: 'AttemptOrphaned',
          payload: { attemptNo: attempt.attempt_no, workerId: attempt.worker_id },
        },
        attemptId: attempt.id,
        patch: { current_attempt_id: null },
      });
      return { attempt, outcome: 'requeued' as const };
    });

    if (!result) break;
    reaped.push({ attempt: result.attempt, outcome: result.outcome });
  }
  return reaped;
}
