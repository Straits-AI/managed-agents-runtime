import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { newId } from '../ids.js';
import { canonicalJson, sha256 } from './receipts.js';
import { createRun, type CreateRunInput } from './runs.js';
import type { RunRow } from '../core/types.js';
import { transitionRun } from '../core/transition.js';
import { isTerminal } from '../core/stateMachine.js';
import { UnexpectedStatusError } from '../core/transition.js';

type Q = Pool | Tx;

export type ManagedSessionState =
  | 'IDLE'
  | 'ACTIVE'
  | 'WAITING'
  | 'REQUIRES_ACTION'
  | 'CANCELLED'
  | 'ARCHIVED';

export interface ManagedSessionRow {
  id: string;
  tenant_id: string;
  principal_id: string;
  agent_version_id: string;
  objective: string;
  correlation_ref: string | null;
  state: ManagedSessionState;
  version: string;
  policy: Record<string, unknown>;
  credential_grant_refs: string[];
  current_top_level_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export class SessionIdempotencyConflictError extends Error {
  constructor() {
    super('idempotency key was already used with a different request');
    this.name = 'SessionIdempotencyConflictError';
  }
}

export interface CreateManagedSessionInput {
  tenantId: string;
  principalId: string;
  idempotencyKey: string;
  agentVersionId: string;
  objective: string;
  correlationRef?: string;
  policy?: Record<string, unknown>;
  credentialGrantRefs?: string[];
  start?: Pick<CreateRunInput, 'goal' | 'input' | 'maxSteps' | 'tokenBudget'>;
}

export async function createManagedSession(
  tx: Tx,
  input: CreateManagedSessionInput,
): Promise<{ session: ManagedSessionRow; replayed: boolean }> {
  const { rows: ownedVersions } = await tx.query<{ id: string }>(
    `SELECT av.id FROM agent_versions av
     JOIN agent_definitions ad ON ad.id = av.agent_id
     WHERE av.id = $1 AND ad.tenant_id = $2`,
    [input.agentVersionId, input.tenantId],
  );
  if (!ownedVersions[0]) {
    throw new Error('managed session agent version does not belong to tenant');
  }
  const digest = sha256(canonicalJson({
    agentVersionId: input.agentVersionId,
    objective: input.objective,
    correlationRef: input.correlationRef ?? null,
    policy: input.policy ?? {},
    credentialGrantRefs: input.credentialGrantRefs ?? [],
    start: input.start ?? null,
  }));
  const receiptId = newId('scmd');
  const { rows: inserted } = await tx.query<{ id: string }>(
    `INSERT INTO session_command_receipts
       (id, tenant_id, principal_id, operation, target_scope,
        idempotency_key, request_digest)
     VALUES ($1, $2, $3, 'session.create', 'sessions', $4, $5)
     ON CONFLICT (tenant_id, principal_id, operation, target_scope, idempotency_key)
     DO NOTHING
     RETURNING id`,
    [receiptId, input.tenantId, input.principalId, input.idempotencyKey, digest],
  );
  if (!inserted[0]) {
    const { rows } = await tx.query<{ request_digest: string; session_id: string | null }>(
      `SELECT request_digest, session_id FROM session_command_receipts
       WHERE tenant_id = $1 AND principal_id = $2 AND operation = 'session.create'
         AND target_scope = 'sessions' AND idempotency_key = $3
       FOR UPDATE`,
      [input.tenantId, input.principalId, input.idempotencyKey],
    );
    const receipt = rows[0];
    if (!receipt || receipt.request_digest !== digest) {
      throw new SessionIdempotencyConflictError();
    }
    if (!receipt.session_id) throw new Error('session command receipt is incomplete');
    const session = await getManagedSession(tx, receipt.session_id, input.tenantId);
    if (!session) throw new Error('session command receipt target is missing');
    return { session, replayed: true };
  }

  const sessionId = newId('ses');
  const { rows } = await tx.query<ManagedSessionRow>(
    `INSERT INTO managed_sessions
       (id, tenant_id, principal_id, agent_version_id, objective,
        correlation_ref, policy, credential_grant_refs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      sessionId,
      input.tenantId,
      input.principalId,
      input.agentVersionId,
      input.objective,
      input.correlationRef ?? null,
      JSON.stringify(input.policy ?? {}),
      JSON.stringify(input.credentialGrantRefs ?? []),
    ],
  );
  let currentTopLevelRunId: string | null = null;
  if (input.start) {
    const run = await createRun(tx, {
      tenantId: input.tenantId,
      managedSessionId: sessionId,
      agentVersionId: input.agentVersionId,
      ...input.start,
    });
    currentTopLevelRunId = run.id;
  }
  await tx.query(
    `UPDATE session_command_receipts SET session_id = $2 WHERE id = $1`,
    [receiptId, sessionId],
  );
  return {
    session: currentTopLevelRunId
      ? (await getManagedSession(tx, sessionId))!
      : rows[0]!,
    replayed: false,
  };
}

export async function listManagedSessionRuns(
  q: Q,
  sessionId: string,
  tenantId: string,
): Promise<RunRow[]> {
  const { rows } = await q.query<RunRow>(
    `SELECT r.* FROM runs r
     JOIN managed_sessions s ON s.id = r.managed_session_id
     WHERE r.managed_session_id = $1 AND s.tenant_id = $2
     ORDER BY r.created_at ASC, r.id ASC`,
    [sessionId, tenantId],
  );
  return rows;
}

export interface CancelManagedSessionInput {
  tenantId: string;
  principalId: string;
  sessionId: string;
  idempotencyKey: string;
  reason: string;
}

export async function cancelManagedSession(
  tx: Tx,
  input: CancelManagedSessionInput,
): Promise<{ session: ManagedSessionRow; replayed: boolean } | null> {
  const { rows: initialRows } = await tx.query<ManagedSessionRow>(
    'SELECT * FROM managed_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [input.sessionId, input.tenantId],
  );
  const initial = initialRows[0] ?? null;
  if (!initial) return null;
  const digest = sha256(canonicalJson({ reason: input.reason }));
  const receiptId = newId('scmd');
  const targetScope = `sessions/${input.sessionId}`;
  const { rows: inserted } = await tx.query<{ id: string }>(
    `INSERT INTO session_command_receipts
       (id, tenant_id, principal_id, operation, target_scope,
        idempotency_key, request_digest)
     VALUES ($1, $2, $3, 'session.cancel', $4, $5, $6)
     ON CONFLICT (tenant_id, principal_id, operation, target_scope, idempotency_key)
     DO NOTHING
     RETURNING id`,
    [
      receiptId,
      input.tenantId,
      input.principalId,
      targetScope,
      input.idempotencyKey,
      digest,
    ],
  );
  if (!inserted[0]) {
    const { rows } = await tx.query<{ request_digest: string; session_id: string | null }>(
      `SELECT request_digest, session_id FROM session_command_receipts
       WHERE tenant_id = $1 AND principal_id = $2 AND operation = 'session.cancel'
         AND target_scope = $3 AND idempotency_key = $4
       FOR UPDATE`,
      [input.tenantId, input.principalId, targetScope, input.idempotencyKey],
    );
    const receipt = rows[0];
    if (!receipt || receipt.request_digest !== digest) {
      throw new SessionIdempotencyConflictError();
    }
    if (!receipt.session_id) throw new Error('session command receipt is incomplete');
    const session = await getManagedSession(tx, receipt.session_id, input.tenantId);
    if (!session) throw new Error('session command receipt target is missing');
    return { session, replayed: true };
  }

  const session = initial;

  if (session.state !== 'CANCELLED' && session.state !== 'ARCHIVED') {
    await fenceManagedSessionRuns(tx, {
      tenantId: input.tenantId,
      sessionId: session.id,
      reason: input.reason,
    });
    await tx.query(
      `UPDATE managed_sessions
       SET state = 'CANCELLED', current_top_level_run_id = $2,
           version = version + 1, updated_at = now()
       WHERE id = $1`,
      [session.id, session.current_top_level_run_id],
    );
  }
  await tx.query(
    'UPDATE session_command_receipts SET session_id = $2 WHERE id = $1',
    [receiptId, session.id],
  );
  return {
    session: (await getManagedSession(tx, session.id))!,
    replayed: false,
  };
}

const NONTERMINAL_RUN_STATES = [
  'CREATED', 'RESOLVING', 'QUEUED', 'STARTING', 'RUNNING',
  'WAITING_APPROVAL', 'WAITING_SIGNAL', 'WAITING_CHILDREN', 'SLEEPING',
  'SUSPENDED', 'RETRY_PENDING', 'VERIFYING',
] as const;

export async function fenceManagedSessionRuns(
  tx: Tx,
  input: { tenantId: string; sessionId: string; reason: string },
): Promise<void> {
  const { rows } = await tx.query<RunRow>(
    `SELECT r.* FROM runs r
     JOIN managed_sessions s ON s.id = r.managed_session_id
     WHERE r.managed_session_id = $1 AND s.tenant_id = $2
       AND r.status <> ALL($3::text[])
     ORDER BY (r.parent_run_id IS NULL) ASC, r.created_at, r.id`,
    [input.sessionId, input.tenantId, ['COMPLETED', 'FAILED', 'CANCELLED']],
  );
  for (const candidate of rows) {
    try {
      const cancelled = await transitionRun(tx, candidate.id, {
        expectFrom: [...NONTERMINAL_RUN_STATES],
        to: 'CANCELLED',
        event: { type: 'RunCancelled', payload: { reason: input.reason } },
        reason: 'managed_session_cancelled',
      });
      if (cancelled.current_attempt_id) {
        await tx.query(
          `UPDATE run_attempts SET state = 'EXITED', exit_reason = 'cancelled'
           WHERE id = $1 AND state = 'ACTIVE'`,
          [cancelled.current_attempt_id],
        );
      }
    } catch (error) {
      if (!(error instanceof UnexpectedStatusError) || !isTerminal(error.actual)) {
        throw error;
      }
    }
  }
}

export async function getManagedSession(
  q: Q,
  sessionId: string,
  tenantId?: string,
): Promise<ManagedSessionRow | null> {
  const { rows } = tenantId === undefined
    ? await q.query<ManagedSessionRow>('SELECT * FROM managed_sessions WHERE id = $1', [sessionId])
    : await q.query<ManagedSessionRow>(
        'SELECT * FROM managed_sessions WHERE id = $1 AND tenant_id = $2',
        [sessionId, tenantId],
      );
  return rows[0] ?? null;
}
