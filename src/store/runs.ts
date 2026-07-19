import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import type { RunRow } from '../core/types.js';
import { transitionRun } from '../core/transition.js';
import { newId } from '../ids.js';
import {
  prepareRunAdmission,
  recordRunAdmission,
  type RunAdmissionKind,
} from './admissions.js';

type Q = Pool | Tx;

export class AgentVersionTenantMismatchError extends Error {
  constructor(agentVersionId: string, tenantId: string) {
    super(`agent version ${agentVersionId} does not belong to tenant ${tenantId}`);
    this.name = 'AgentVersionTenantMismatchError';
  }
}

export interface CreateRunInput {
  /** Owning tenant. Internal callers must derive this explicitly. */
  tenantId: string;
  agentVersionId: string;
  goal: string;
  input?: Record<string, unknown>;
  maxSteps?: number;
  tokenBudget?: number | string | bigint;
  /** ISO timestamp; the run is not claimable until then (delayed start). */
  scheduledFor?: string;
  /** Parent run when this is a delegated subrun (memo §15/§19). */
  parentRunId?: string;
  /** The failed child this run replaces, when spawned as a replacement (§25). */
  replacesRunId?: string;
  /** Generation of this child in its replacement lineage (0 = original). */
  replacementGeneration?: number;
  /** The source run this run was forked from (memo §20 fork). */
  forkedFromRunId?: string;
  /** Seed the progress ledger (used by fork to carry the source's progress). */
  progress?: Record<string, unknown>;
  grants?: {
    action: string;
    resource?: string;
    requiresApproval?: boolean;
    maxCalls?: number;
    expiresAt?: Date | string;
  }[];
  debugFaultPoints?: string[];
}

function admissionKind(input: CreateRunInput): RunAdmissionKind {
  if (input.replacesRunId) return 'replacement';
  if (input.parentRunId) return 'delegated';
  if (input.forkedFromRunId) return 'fork';
  return 'direct';
}

/**
 * Create a run and drive it CREATED → RESOLVING → QUEUED in one
 * transaction (Phase 1 "resolving" only pins the agent version, which is
 * already immutable, and materializes capability grants).
 */
export async function createRun(tx: Tx, input: CreateRunInput): Promise<RunRow> {
  const capacity = await prepareRunAdmission(tx, input);
  const { rows: ownedVersions } = await tx.query<{ id: string }>(
    `SELECT av.id
     FROM agent_versions av
     JOIN agent_definitions ad ON ad.id = av.agent_id
     WHERE av.id = $1 AND ad.tenant_id = $2`,
    [input.agentVersionId, input.tenantId],
  );
  if (!ownedVersions[0]) {
    throw new AgentVersionTenantMismatchError(
      input.agentVersionId,
      input.tenantId,
    );
  }

  const runId = newId('run');
  const wsId = newId('ws');

  await tx.query(
    `INSERT INTO runs (id, tenant_id, agent_version_id, goal, input, status, progress, max_steps,
                       token_budget, scheduled_for, parent_run_id, debug_fault_points,
                       replaces_run_id, replacement_generation, forked_from_run_id)
     VALUES ($1, $2, $3, $4, $5, 'CREATED', $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      runId,
      input.tenantId,
      input.agentVersionId,
      input.goal,
      JSON.stringify(input.input ?? {}),
      JSON.stringify(input.progress ?? {}),
      input.maxSteps ?? 50,
      capacity.effectiveTokenBudget?.toString() ?? null,
      input.scheduledFor ?? null,
      input.parentRunId ?? null,
      JSON.stringify(input.debugFaultPoints ?? []),
      input.replacesRunId ?? null,
      input.replacementGeneration ?? 0,
      input.forkedFromRunId ?? null,
    ],
  );
  await recordRunAdmission(tx, {
    runId,
    tenantId: input.tenantId,
    kind: admissionKind(input),
    reservedTokens: capacity.reservedTokens,
  });
  await tx.query(`INSERT INTO workspaces (id, run_id) VALUES ($1, $2)`, [wsId, runId]);

  for (const g of input.grants ?? []) {
    await tx.query(
      `INSERT INTO capability_grants
         (id, run_id, action_pattern, resource_pattern, requires_approval, max_calls, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newId('cap'),
        runId,
        g.action,
        g.resource ?? '*',
        g.requiresApproval ?? false,
        g.maxCalls ?? null,
        g.expiresAt ?? null,
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
