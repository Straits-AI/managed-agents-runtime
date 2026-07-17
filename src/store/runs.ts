import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import type { RunRow } from '../core/types.js';
import { transitionRun } from '../core/transition.js';
import { newId } from '../ids.js';

type Q = Pool | Tx;

export interface CreateRunInput {
  agentVersionId: string;
  goal: string;
  input?: Record<string, unknown>;
  maxSteps?: number;
  tokenBudget?: number;
  /** ISO timestamp; the run is not claimable until then (delayed start). */
  scheduledFor?: string;
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
    `INSERT INTO runs (id, agent_version_id, goal, input, status, max_steps,
                       token_budget, scheduled_for, debug_fault_points)
     VALUES ($1, $2, $3, $4, 'CREATED', $5, $6, $7, $8)`,
    [
      runId,
      input.agentVersionId,
      input.goal,
      JSON.stringify(input.input ?? {}),
      input.maxSteps ?? 50,
      input.tokenBudget ?? null,
      input.scheduledFor ?? null,
      JSON.stringify(input.debugFaultPoints ?? []),
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

export async function getRun(q: Q, id: string): Promise<RunRow | null> {
  const { rows } = await q.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
  return rows[0] ?? null;
}
