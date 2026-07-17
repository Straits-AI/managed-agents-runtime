import type { EpochContext } from './worker.js';
import type { EpochExitReason, SemanticAction } from '../core/types.js';
import { withTransaction } from '../db/tx.js';
import { appendEvent, transitionRun } from '../core/transition.js';
import { insertCheckpoint, latestCheckpoint } from '../store/checkpoints.js';
import { insertApproval, listApprovals } from '../store/approvals.js';
import { listEvents } from '../store/events.js';
import { spawnChildren } from '../scheduler/children.js';
import { tokenBudgetExceeded } from './limits.js';

/**
 * Deterministic no-model epoch used by tests and pre-credential milestones.
 * Interprets run.input.script — an array of ops — resuming from the last
 * checkpoint's step index, exactly as the real epoch resumes from a
 * checkpoint.
 */
export type ScriptOp =
  | { op: 'progress'; note: string }
  | { op: 'sleep'; ms: number }
  | { op: 'checkpoint' }
  | { op: 'requestApproval'; action: SemanticAction }
  | { op: 'waitSignal'; name: string }
  | { op: 'delegate'; goals: string[] }
  | { op: 'fail'; once?: boolean }
  | { op: 'complete' };

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
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

export async function scriptedEpoch(ctx: EpochContext): Promise<EpochExitReason> {
  const { pool, run, attempt, signal } = ctx;
  const script = (run.input.script ?? []) as ScriptOp[];

  const ckpt = await latestCheckpoint(pool, run.id);
  let step = ckpt?.agent_state.step ?? 0;

  while (step < script.length) {
    if (signal.aborted) return 'lease_lost';
    // Same hard ceilings the real epoch enforces, so budget/step exhaustion is
    // testable without a live model.
    if (step >= run.max_steps || (await tokenBudgetExceeded(pool, run.id))) {
      return 'budget_exhausted';
    }
    const op = script[step]!;

    switch (op.op) {
      case 'progress':
        await withTransaction(pool, (tx) =>
          appendEvent(tx, run.id, {
            type: 'ProgressUpdated',
            payload: { note: op.note, step },
          }, {
            attemptId: attempt.id,
            patch: { progress: { completed: [op.note] } },
          }),
        );
        break;

      case 'sleep':
        await abortableSleep(op.ms, signal);
        if (signal.aborted) return 'lease_lost';
        break;

      case 'checkpoint':
        await withTransaction(pool, async (tx) => {
          const seq = await appendEvent(
            tx,
            run.id,
            { type: 'WorkspaceCheckpointed', payload: { step } },
            { attemptId: attempt.id },
          );
          await insertCheckpoint(tx, {
            runId: run.id,
            attemptId: attempt.id,
            eventSeq: seq,
            progress: {},
            agentState: { step: step + 1 },
          });
        });
        break;

      case 'requestApproval': {
        // On resume after approval, this step is already decided — skip it.
        const decided = (await listApprovals(pool, run.id)).find(
          (a) =>
            a.status !== 'PENDING' &&
            (a.action.arguments as { scriptStep?: number }).scriptStep === step,
        );
        if (decided) break;

        await withTransaction(pool, async (tx) => {
          const approval = await insertApproval(tx, {
            runId: run.id,
            attemptId: attempt.id,
            action: {
              ...op.action,
              arguments: { ...op.action.arguments, scriptStep: step },
            },
          });
          const seq = await appendEvent(
            tx,
            run.id,
            {
              type: 'ApprovalRequested',
              payload: { approvalId: approval.id, action: op.action.action },
            },
            { attemptId: attempt.id },
          );
          await insertCheckpoint(tx, {
            runId: run.id,
            attemptId: attempt.id,
            eventSeq: seq,
            progress: {},
            agentState: { step: step + 1 },
          });
          await transitionRun(tx, run.id, {
            expectFrom: ['RUNNING'],
            to: 'WAITING_APPROVAL',
            event: { type: 'ApprovalRequested', payload: { approvalId: approval.id } },
            attemptId: attempt.id,
          });
        });
        return 'suspended_for_approval';
      }

      case 'waitSignal': {
        // Resume-safe: if the signal already arrived, continue past the wait.
        const { rows } = await pool.query(
          `SELECT 1 FROM run_events
           WHERE run_id = $1 AND type = 'SignalReceived' AND payload->>'name' = $2 LIMIT 1`,
          [run.id, op.name],
        );
        if (rows.length > 0) break;

        await withTransaction(pool, async (tx) => {
          const seq = await appendEvent(
            tx,
            run.id,
            { type: 'SignalReceived', payload: { waiting_for: op.name } },
            { attemptId: attempt.id },
          );
          await insertCheckpoint(tx, {
            runId: run.id,
            attemptId: attempt.id,
            eventSeq: seq,
            progress: {},
            agentState: { step: step + 1 },
          });
          await transitionRun(tx, run.id, {
            expectFrom: ['RUNNING'],
            to: 'WAITING_SIGNAL',
            event: { type: 'SignalReceived', payload: { waiting_for: op.name } },
            attemptId: attempt.id,
            patch: { awaited_signal: op.name },
          });
        });
        return 'suspended_for_signal';
      }

      case 'delegate': {
        // On resume after children resolve, this step is already done — skip it.
        const alreadySpawned = (await listEvents(pool, run.id)).some(
          (e) => e.type === 'ChildRunSpawned' && (e.payload as { childRunIds?: string[] }).childRunIds,
        );
        if (alreadySpawned) break;

        await withTransaction(pool, async (tx) => {
          await insertCheckpoint(tx, {
            runId: run.id,
            attemptId: attempt.id,
            eventSeq: BigInt(run.last_event_seq),
            progress: {},
            agentState: { step: step + 1 },
          });
          await spawnChildren(tx, {
            parentRunId: run.id,
            attemptId: attempt.id,
            children: op.goals.map((g) => ({
              agentVersionId: run.agent_version_id,
              goal: g,
              input: { script: [{ op: 'complete' }] as ScriptOp[] },
            })),
          });
        });
        return 'suspended_for_children';
      }

      case 'fail':
        if (op.once && attempt.attempt_no > 1) break; // succeed on retry
        throw new Error(`scripted failure at step ${step}`);

      case 'complete':
        await withTransaction(pool, async (tx) => {
          await transitionRun(tx, run.id, {
            expectFrom: ['RUNNING'],
            to: 'VERIFYING',
            event: { type: 'VerificationStarted' },
            attemptId: attempt.id,
          });
          await transitionRun(tx, run.id, {
            expectFrom: ['VERIFYING'],
            to: 'COMPLETED',
            event: { type: 'RunCompleted', payload: { verification: 'scripted-pass' } },
            attemptId: attempt.id,
          });
        });
        return 'completed';
    }
    step += 1;
  }

  // Script ended without an explicit complete op.
  await withTransaction(pool, async (tx) => {
    await transitionRun(tx, run.id, {
      expectFrom: ['RUNNING'],
      to: 'VERIFYING',
      event: { type: 'VerificationStarted' },
      attemptId: attempt.id,
    });
    await transitionRun(tx, run.id, {
      expectFrom: ['VERIFYING'],
      to: 'COMPLETED',
      event: { type: 'RunCompleted' },
      attemptId: attempt.id,
    });
  });
  return 'completed';
}
