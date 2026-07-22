import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { withTransaction } from '../db/tx.js';
import { transitionRun, appendEvent, RunNotFoundError } from '../core/transition.js';
import { createRun } from '../store/runs.js';
import { listGrants } from '../store/grants.js';
import {
  lockRunAdmissionTenant,
  lockRunAdmissionTenantRow,
  RunAdmissionRejectedError,
} from '../store/admissions.js';
import { childLineageProjection } from '../store/childLineage.js';
import {
  MAX_DELEGATED_CHILDREN,
  MAX_DELEGATED_GOAL_BYTES,
} from '../core/delegatedResults.js';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

export interface ChildSpec {
  agentVersionId: string;
  goal: string;
  input?: Record<string, unknown>;
  grants?: {
    action: string;
    resource?: string;
    requiresApproval?: boolean;
    maxCalls?: number;
    expiresAt?: Date | string;
  }[];
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
  if (input.children.length < 1 || input.children.length > MAX_DELEGATED_CHILDREN) {
    throw new Error(`delegation requires 1-${MAX_DELEGATED_CHILDREN} children`);
  }
  if (input.children.some((child) => Buffer.byteLength(child.goal) > MAX_DELEGATED_GOAL_BYTES)) {
    throw new Error(`delegated goals must not exceed ${MAX_DELEGATED_GOAL_BYTES} encoded bytes`);
  }
  const { rows: ownershipRows } = await tx.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM runs WHERE id = $1',
    [input.parentRunId],
  );
  const ownership = ownershipRows[0];
  if (!ownership) throw new RunNotFoundError(input.parentRunId);
  // All creation paths lock tenant capacity before lineage rows. Keeping this
  // order prevents fork/delegation admission from deadlocking each other.
  await lockRunAdmissionTenant(tx, ownership.tenant_id);
  const { rows: parentRows } = await tx.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM runs WHERE id = $1 FOR UPDATE',
    [input.parentRunId],
  );
  const parent = parentRows[0];
  if (!parent) throw new RunNotFoundError(input.parentRunId);

  const ids: string[] = [];
  for (const c of input.children) {
    const child = await createRun(tx, {
      tenantId: parent.tenant_id,
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

interface ChildResolution {
  id: string;
  status: string;
  goal: string;
  agent_version_id: string;
  input: Record<string, unknown>;
  tenant_id: string;
  max_steps: number;
  token_budget: string | null;
  tokens_used: string;
  replacement_generation: number;
  superseded: boolean;
}

export interface WakeResult {
  /** Parent ids resumed because their children fully resolved. */
  woken: string[];
  /** Replacement child ids spawned for failed subtasks (memo §25). */
  replaced: string[];
}

/**
 * Resolve parents whose delegated children have all reached a terminal state
 * (memo §15). For each such parent, before waking it:
 *   - a child that FAILED and is still under the replacement cap is replaced
 *     with a fresh child for the same subtask (memo §25 subagent replacement),
 *     and the parent keeps waiting;
 *   - only once every current-generation child has COMPLETED (or failed at the
 *     cap) does the parent resume, with the latest child outcomes to merge.
 *
 * Runs in the worker loop alongside the lease reaper. FOR UPDATE SKIP LOCKED so
 * concurrent workers never double-resolve a parent.
 */
export async function wakeReadyParents(
  pool: Pool,
  maxChildReplacements = 0,
): Promise<WakeResult> {
  const { rows: candidates } = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT p.id, p.tenant_id
     FROM runs p
     WHERE p.status = 'WAITING_CHILDREN'
       AND NOT EXISTS (
         SELECT 1 FROM runs c
         WHERE c.parent_run_id = p.id
           AND c.status <> ALL($1::text[])
       )
     ORDER BY p.updated_at, p.id
     LIMIT 32`,
    [TERMINAL],
  );

  for (const candidate of candidates) {
    const outcome = await withTransaction(pool, async (tx) => {
      const empty: WakeResult = { woken: [], replaced: [] };
      // Claim one parent per transaction. A transaction-scoped advisory lock
      // lets concurrent workers choose different parents without taking a run
      // row before its tenant row (which would invert admission's lock order).
      const { rows: locks } = await tx.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`,
        [candidate.id],
      );
      if (!locks[0]?.locked) return empty;
      await lockRunAdmissionTenantRow(tx, candidate.tenant_id);
      const { rows: claimed } = await tx.query<{ id: string; tenant_id: string }>(
        `SELECT p.id, p.tenant_id
         FROM runs p
         WHERE p.id = $1 AND p.status = 'WAITING_CHILDREN'
           AND NOT EXISTS (
             SELECT 1 FROM runs c
             WHERE c.parent_run_id = p.id
               AND c.status <> ALL($2::text[])
           )
         FOR UPDATE SKIP LOCKED`,
        [candidate.id, TERMINAL],
      );
      const parent = claimed[0];
      if (!parent) return empty;

      const { id, tenant_id: parentTenantId } = parent;
      const { rows: kids } = await tx.query<ChildResolution>(
        `SELECT c.id, c.status, c.goal, c.agent_version_id, c.input, c.tenant_id,
                c.max_steps, c.token_budget, c.tokens_used,
                c.replacement_generation,
                EXISTS (SELECT 1 FROM runs r WHERE r.replaces_run_id = c.id) AS superseded
         FROM runs c WHERE c.parent_run_id = $1 ORDER BY c.created_at`,
        [id],
      );
      // Only the current generation of each subtask matters for resolution.
      const active = kids.filter((k) => !k.superseded);
      const replaceable = active.filter(
        (k) =>
          k.status === 'FAILED' &&
          k.replacement_generation < maxChildReplacements &&
          (k.token_budget === null || BigInt(k.token_budget) > BigInt(k.tokens_used)),
      );

      if (replaceable.length > 0) {
        // Swap each failed subtask for a fresh attempt; the parent keeps waiting.
        await tx.query('SAVEPOINT replace_parent');
        const replacementsForParent: string[] = [];
        try {
          for (const k of replaceable) {
            if (k.tenant_id !== parentTenantId) {
              throw new Error(`child ${k.id} tenant does not match parent ${id}`);
            }
            const gen = k.replacement_generation + 1;
            const grants = await listGrants(tx, k.id);
            const child = await createRun(tx, {
              tenantId: parentTenantId,
              agentVersionId: k.agent_version_id,
              goal: k.goal,
              input: {
                ...k.input,
                // Give the fresh attempt the context that its predecessor failed.
                replacedFrom: k.id,
                replacementGeneration: gen,
              },
              parentRunId: id,
              replacesRunId: k.id,
              replacementGeneration: gen,
              maxSteps: k.max_steps,
              tokenBudget:
                k.token_budget === null
                  ? undefined
                  : BigInt(k.token_budget) - BigInt(k.tokens_used),
              grants: grants.map((grant) => ({
                action: grant.action_pattern,
                resource: grant.resource_pattern,
                requiresApproval: grant.requires_approval,
                maxCalls:
                  grant.max_calls === null
                    ? undefined
                    : Math.max(0, grant.max_calls - grant.calls_used),
                expiresAt: grant.expires_at ?? undefined,
              })),
            });
            await appendEvent(tx, id, {
              type: 'ChildRunReplaced',
              payload: {
                failedChildId: k.id,
                replacementChildId: child.id,
                goal: k.goal,
                generation: gen,
              },
            });
            replacementsForParent.push(child.id);
          }
          await tx.query('RELEASE SAVEPOINT replace_parent');
          return { woken: [], replaced: replacementsForParent };
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT replace_parent');
          await tx.query('RELEASE SAVEPOINT replace_parent');
          if (!(err instanceof RunAdmissionRejectedError)) throw err;
          // Capacity or tenant status can change independently for each parent.
          // Record each distinct reason once, then only rotate updated_at. This
          // preserves audit evidence and candidate-window liveness without
          // generating an unbounded event/outbox stream on every worker poll.
          const { rowCount: alreadyRecorded } = await tx.query(
            `SELECT 1 FROM run_events
             WHERE run_id = $1
               AND type = 'ChildReplacementDeferred'
               AND payload->>'reason' = $2
             LIMIT 1`,
            [id, err.reason],
          );
          if ((alreadyRecorded ?? 0) === 0) {
            await appendEvent(tx, id, {
              type: 'ChildReplacementDeferred',
              payload: { reason: err.reason },
            });
          } else {
            await tx.query('UPDATE runs SET updated_at = now() WHERE id = $1', [id]);
          }
          return empty;
        }
      }

      // Every current-generation child is resolved and none is replaceable.
      const lineage = await childLineageProjection(tx, id, parentTenantId);
      if (!lineage) throw new Error(`parent ${id} disappeared while resolving children`);
      await transitionRun(tx, id, {
        expectFrom: ['WAITING_CHILDREN'],
        to: 'QUEUED',
        event: {
          type: 'ChildrenResolved',
          payload: {
            children: lineage.selected,
          },
        },
        patch: { current_attempt_id: null },
      });
      return { woken: [id], replaced: [] };
    });
    if (outcome.woken.length > 0 || outcome.replaced.length > 0) return outcome;
  }
  return { woken: [], replaced: [] };
}
