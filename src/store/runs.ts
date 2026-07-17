import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import type { RunRow } from '../core/types.js';
import { transitionRun } from '../core/transition.js';
import { newId } from '../ids.js';

type Q = Pool | Tx;

export interface CreateRunInput {
  /** Owning tenant. Defaults to 'default' for back-compat / internal callers. */
  tenantId?: string;
  agentVersionId: string;
  goal: string;
  input?: Record<string, unknown>;
  maxSteps?: number;
  tokenBudget?: number;
  /** ISO timestamp; the run is not claimable until then (delayed start). */
  scheduledFor?: string;
  /** Parent run when this is a delegated subrun (memo §15/§19). */
  parentRunId?: string;
  /** The failed child this run replaces, when spawned as a replacement (§25). */
  replacesRunId?: string;
  /** Generation of this child in its replacement lineage (0 = original). */
  replacementGeneration?: number;
  grants?: {
    action: string;
    resource?: string;
    requiresApproval?: boolean;
    maxCalls?: number;
  }[];
  debugFaultPoints?: string[];
}

/**
 * Create a run and drive it CREATED → RESOLVING → QUEUED in one
 * transaction (Phase 1 "resolving" only pins the agent version, which is
 * already immutable, and materializes capability grants).
 */
export async function createRun(tx: Tx, input: CreateRunInput): Promise<RunRow> {
  const runId = newId('run');
  const wsId = newId('ws');

  await tx.query(
    `INSERT INTO runs (id, tenant_id, agent_version_id, goal, input, status, max_steps,
                       token_budget, scheduled_for, parent_run_id, debug_fault_points,
                       replaces_run_id, replacement_generation)
     VALUES ($1, $2, $3, $4, $5, 'CREATED', $6, $7, $8, $9, $10, $11, $12)`,
    [
      runId,
      input.tenantId ?? 'default',
      input.agentVersionId,
      input.goal,
      JSON.stringify(input.input ?? {}),
      input.maxSteps ?? 50,
      input.tokenBudget ?? null,
      input.scheduledFor ?? null,
      input.parentRunId ?? null,
      JSON.stringify(input.debugFaultPoints ?? []),
      input.replacesRunId ?? null,
      input.replacementGeneration ?? 0,
    ],
  );
  await tx.query(`INSERT INTO workspaces (id, run_id) VALUES ($1, $2)`, [wsId, runId]);

  for (const g of input.grants ?? []) {
    await tx.query(
      `INSERT INTO capability_grants
         (id, run_id, action_pattern, resource_pattern, requires_approval, max_calls)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        newId('cap'),
        runId,
        g.action,
        g.resource ?? '*',
        g.requiresApproval ?? false,
        g.maxCalls ?? null,
      ],
    );
  }

  await transitionRun(tx, runId, {
    expectFrom: ['CREATED'],
    to: 'RESOLVING',
    event: {
      type: 'RunCreated',
      payload: { goal: input.goal, agentVersionId: input.agentVersionId },
    },
    patch: { workspace_id: wsId },
  });
  return transitionRun(tx, runId, {
    expectFrom: ['RESOLVING'],
    to: 'QUEUED',
    event: { type: 'RunQueued' },
  });
}

/**
 * Fetch a run by id. When `tenantId` is given, a run owned by a different tenant
 * is returned as null — the caller reports it as not-found so cross-tenant
 * probing can't even confirm a run exists. Internal callers (scheduler, worker,
 * child spawning) omit `tenantId` and see all runs.
 */
export async function getRun(q: Q, id: string, tenantId?: string): Promise<RunRow | null> {
  const { rows } =
    tenantId === undefined
      ? await q.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id])
      : await q.query<RunRow>('SELECT * FROM runs WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  return rows[0] ?? null;
}
