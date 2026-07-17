import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { withTransaction } from '../db/tx.js';
import { transitionRun, appendEvent } from '../core/transition.js';
import { createRun } from '../store/runs.js';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

export interface ChildSpec {
  agentVersionId: string;
  goal: string;
  input?: Record<string, unknown>;
  grants?: { action: string; resource?: string; requiresApproval?: boolean; maxCalls?: number }[];
  tokenBudget?: number;
  maxSteps?: number;
}

/**
 * Spawn delegated child runs and suspend the parent (RUNNING → WAITING_CHILDREN)
 * in one transaction. Children are QUEUED and picked up independently by the
 * scheduler, so they run in parallel. Returns the new child run ids.
 */
export async function spawnChildren(
  tx: Tx,
  input: { parentRunId: string; attemptId: string; children: ChildSpec[] },
): Promise<string[]> {
  const ids: string[] = [];
  for (const c of input.children) {
    const child = await createRun(tx, {
      agentVersionId: c.agentVersionId,
      goal: c.goal,
      input: c.input,
      grants: c.grants,
      tokenBudget: c.tokenBudget,
      maxSteps: c.maxSteps,
      parentRunId: input.parentRunId,
    });
    ids.push(child.id);
    await appendEvent(
      tx,
      input.parentRunId,
      { type: 'ChildRunSpawned', payload: { childRunId: child.id, goal: c.goal } },
      { attemptId: input.attemptId },
    );
  }
  await transitionRun(tx, input.parentRunId, {
    expectFrom: ['RUNNING'],
    to: 'WAITING_CHILDREN',
    event: { type: 'ChildRunSpawned', payload: { childRunIds: ids } },
    attemptId: input.attemptId,
    patch: { current_attempt_id: null },
  });
  return ids;
}

/**
 * Wake any parent run whose delegated children have all reached a terminal
 * state (memo §15). Runs in the worker loop alongside the lease reaper. Uses
 * FOR UPDATE SKIP LOCKED so concurrent workers never double-wake a parent.
 * Returns the woken parent ids.
 */
export async function wakeReadyParents(pool: Pool): Promise<string[]> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT p.id
       FROM runs p
       WHERE p.status = 'WAITING_CHILDREN'
         AND NOT EXISTS (
           SELECT 1 FROM runs c
           WHERE c.parent_run_id = p.id
             AND c.status <> ALL($1::text[])
         )
       FOR UPDATE SKIP LOCKED`,
      [TERMINAL],
    );

    const woken: string[] = [];
    for (const { id } of rows) {
      // Summarize child outcomes for the parent's resume context.
      const { rows: kids } = await tx.query<{ id: string; status: string; goal: string }>(
        `SELECT id, status, goal FROM runs WHERE parent_run_id = $1 ORDER BY created_at`,
        [id],
      );
      await transitionRun(tx, id, {
        expectFrom: ['WAITING_CHILDREN'],
        to: 'QUEUED',
        event: {
          type: 'ChildrenResolved',
          payload: {
            children: kids.map((k) => ({ id: k.id, status: k.status, goal: k.goal })),
          },
        },
        patch: { current_attempt_id: null },
      });
      woken.push(id);
    }
    return woken;
  });
}
