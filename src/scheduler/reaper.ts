import type { Pool } from 'pg';
import { withTransaction } from '../db/tx.js';
import { transitionRun } from '../core/transition.js';
import type { RunAttemptRow } from '../core/types.js';
import { MODEL_INVOCATION_LOCK_SEED } from '../core/locks.js';

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
      const { rows: candidates } = await tx.query<Pick<RunAttemptRow, 'id' | 'run_id'>>(
        `SELECT id, run_id FROM run_attempts
         WHERE state = 'ACTIVE' AND lease_expires_at < now()
         ORDER BY lease_expires_at ASC, id`,
      );
      let attempt: RunAttemptRow | undefined;
      for (const candidate of candidates) {
        // Never orphan an attempt while its provider call is still in flight.
        // Skip an invocation-locked run and continue scanning so one slow model
        // call cannot starve unrelated expired attempts behind it.
        const { rows: invocationLocks } = await tx.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1, $2)) AS locked',
          [candidate.run_id, MODEL_INVOCATION_LOCK_SEED],
        );
        if (!invocationLocks[0]?.locked) continue;
        const { rows } = await tx.query<RunAttemptRow>(
          `SELECT * FROM run_attempts
           WHERE id = $1 AND state = 'ACTIVE' AND lease_expires_at < now()
           FOR UPDATE SKIP LOCKED`,
          [candidate.id],
        );
        if (rows[0]) {
          attempt = rows[0];
          break;
        }
      }
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
