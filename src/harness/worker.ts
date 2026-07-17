import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { EpochExitReason, RunAttemptRow, RunRow } from '../core/types.js';
import { withTransaction } from '../db/tx.js';
import { transitionRun } from '../core/transition.js';
import { claimRun } from '../scheduler/claim.js';
import { reapExpiredLeases } from '../scheduler/reaper.js';
import { wakeReadyParents } from '../scheduler/children.js';
import { exitAttempt, heartbeatAttempt } from '../store/attempts.js';

export interface EpochContext {
  pool: Pool;
  cfg: Config;
  run: RunRow;
  attempt: RunAttemptRow;
  /** Fires when the lease is lost or the worker is shutting down. */
  signal: AbortSignal;
}

export type EpochRunner = (ctx: EpochContext) => Promise<EpochExitReason>;

export interface WorkerHandle {
  stop(): Promise<void>;
}

/**
 * The harness worker process (memo §13, §14): claim → epoch → repeat,
 * with heartbeat fencing and a lease reaper. One run executes at a time
 * per worker in Phase 1.
 */
export function startWorker(
  pool: Pool,
  cfg: Config,
  runEpoch: EpochRunner,
  hooks: { onSandboxOrphaned?: (sandboxId: string) => Promise<void> } = {},
): WorkerHandle {
  const shutdown = new AbortController();
  let loop: Promise<void>;

  async function reap(): Promise<void> {
    const reaped = await reapExpiredLeases(pool, cfg.MAX_ATTEMPTS);
    for (const r of reaped) {
      if (r.attempt.sandbox_id && hooks.onSandboxOrphaned) {
        await hooks.onSandboxOrphaned(r.attempt.sandbox_id).catch(() => {});
      }
    }
  }

  async function executeClaimed(run: RunRow, attempt: RunAttemptRow): Promise<void> {
    const epochAbort = new AbortController();
    const stopOnShutdown = () => epochAbort.abort();
    shutdown.signal.addEventListener('abort', stopOnShutdown);

    const heartbeat = setInterval(async () => {
      try {
        const ok = await heartbeatAttempt(pool, attempt.id, cfg.LEASE_TTL_MS);
        if (!ok) epochAbort.abort(); // fencing: lease lost, stop immediately
      } catch {
        // transient DB error: keep going; lease expiry is the backstop
      }
    }, cfg.HEARTBEAT_MS);

    let exitReason: EpochExitReason;
    try {
      const running = await withTransaction(pool, (tx) =>
        transitionRun(tx, run.id, {
          expectFrom: ['STARTING'],
          to: 'RUNNING',
          event: { type: 'AttemptStarted', payload: { phase: 'running' } },
          attemptId: attempt.id,
        }),
      );
      exitReason = await runEpoch({
        pool,
        cfg,
        run: running,
        attempt,
        signal: epochAbort.signal,
      });
    } catch (err) {
      exitReason = epochAbort.signal.aborted ? 'lease_lost' : 'error';
      if (exitReason === 'error') {
        console.error(`[worker] epoch error for ${run.id}:`, err);
      }
    } finally {
      clearInterval(heartbeat);
      shutdown.signal.removeEventListener('abort', stopOnShutdown);
    }

    await settleAttempt(pool, cfg, run.id, attempt, exitReason);
  }

  async function main(): Promise<void> {
    while (!shutdown.signal.aborted) {
      try {
        await reap();
        await wakeReadyParents(pool).catch(() => []); // subagent parents
        const claimed = await claimRun(pool, cfg.WORKER_ID, cfg.LEASE_TTL_MS);
        if (claimed) {
          await executeClaimed(claimed.run, claimed.attempt);
          continue; // look for more work immediately
        }
      } catch (err) {
        console.error('[worker] loop error:', err);
      }
      await sleep(cfg.POLL_MS, shutdown.signal);
    }
  }

  loop = main();
  return {
    async stop() {
      shutdown.abort();
      await loop;
    },
  };
}

/**
 * Record the attempt outcome and drive the run's next transition.
 * Suspension transitions (WAITING_APPROVAL, VERIFYING→…) are written by
 * the epoch itself before it returns; this handles the generic cases.
 */
async function settleAttempt(
  pool: Pool,
  cfg: Config,
  runId: string,
  attempt: RunAttemptRow,
  exitReason: EpochExitReason,
): Promise<void> {
  if (exitReason === 'lease_lost') return; // the reaper owns this run now

  await withTransaction(pool, async (tx) => {
    const owned = await exitAttempt(tx, attempt.id, exitReason);
    if (!owned) return; // lost the race to the reaper

    switch (exitReason) {
      case 'completed':
      case 'suspended_for_approval':
      case 'suspended_for_signal':
      case 'suspended_for_children':
      case 'cancelled':
        // Terminal-for-this-attempt transitions were already written by
        // the epoch (or the cancel API) inside their own transactions.
        break;
      case 'budget_exhausted':
        await transitionRun(tx, runId, {
          expectFrom: ['RUNNING'],
          to: 'FAILED',
          event: { type: 'RunFailed', payload: { reason: 'budget_exhausted' } },
          attemptId: attempt.id,
          reason: 'budget_exhausted',
        });
        break;
      case 'error': {
        if (attempt.attempt_no >= cfg.MAX_ATTEMPTS) {
          await transitionRun(tx, runId, {
            expectFrom: ['RUNNING', 'STARTING', 'VERIFYING'],
            to: 'FAILED',
            event: { type: 'RunFailed', payload: { reason: 'max_attempts_exhausted' } },
            attemptId: attempt.id,
            reason: 'max_attempts_exhausted',
          });
        } else {
          await transitionRun(tx, runId, {
            expectFrom: ['RUNNING', 'STARTING', 'VERIFYING'],
            to: 'QUEUED',
            event: { type: 'RetryScheduled', payload: { attemptNo: attempt.attempt_no } },
            attemptId: attempt.id,
            patch: { current_attempt_id: null },
          });
        }
        break;
      }
    }
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}
