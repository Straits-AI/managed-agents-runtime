import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { transitionRun } from '../src/core/transition.js';
import { newId } from '../src/ids.js';
import type { RunAttemptRow, RunRow } from '../src/core/types.js';
import {
  executeGovernedAction,
  type GovernedActionContext,
} from '../src/harness/governedAction.js';
import { listApprovals } from '../src/store/approvals.js';
import { listGrants } from '../src/store/grants.js';

let db: TestDb;
let agentVersionId: string;

beforeAll(async () => {
  db = await createTestDb();
  const definition = await createAgentDefinition(db.pool, { name: 'governed-action-agent' });
  const version = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, {
      agentId: definition.id,
      instructions: 'exercise governed actions',
      modelPolicy: { model: 'none' },
    }),
  );
  agentVersionId = version.id;
});

afterAll(async () => {
  await db.drop();
});

async function runningRun(
  grants: {
    action: string;
    resource?: string;
    requiresApproval?: boolean;
    maxCalls?: number;
  }[],
): Promise<{ run: RunRow; attempt: RunAttemptRow }> {
  const run = await withTransaction(db.pool, (tx) =>
    createRun(tx, {
      tenantId: 'default',
      agentVersionId,
      goal: 'governed action test',
      grants,
    }),
  );
  const attemptId = newId('att');
  const { rows } = await db.pool.query<RunAttemptRow>(
    `INSERT INTO run_attempts
       (id, run_id, attempt_no, worker_id, state, lease_expires_at)
     VALUES ($1, $2, 1, 'governed-test', 'ACTIVE', now() + interval '1 minute')
     RETURNING *`,
    [attemptId, run.id],
  );
  const running = await withTransaction(db.pool, async (tx) => {
    await transitionRun(tx, run.id, {
      expectFrom: ['QUEUED'],
      to: 'STARTING',
      event: { type: 'AttemptStarted' },
      attemptId,
    });
    return transitionRun(tx, run.id, {
      expectFrom: ['STARTING'],
      to: 'RUNNING',
      event: { type: 'AttemptStarted' },
      attemptId,
    });
  });
  return { run: running, attempt: rows[0]! };
}

function context(run: RunRow, attempt: RunAttemptRow): GovernedActionContext {
  return { pool: db.pool, run, attempt, step: 3 };
}

describe('governed action pipeline', () => {
  it('runs a classified read through policy, credentials, receipt, dispatch, and audit', async () => {
    const { run, attempt } = await runningRun([
      { action: 'connector.records.read', resource: 'records', maxCalls: 1 },
    ]);
    const seen: Record<string, unknown> = {};
    const result = await executeGovernedAction(context(run, attempt), {
      connector: 'test',
      action: 'connector.records.read',
      resource: 'records',
      args: { id: 'R-1' },
      classification: 'read',
      requireGrant: true,
      recovery: 'retry_with_idempotency',
      resolveCredential: async () => ({ headerName: 'authorization', headerValue: 'secret' }),
      dispatch: async (input) => {
        Object.assign(seen, input);
        return {
          value: { record: 'R-1' },
          receiptResult: { record: 'R-1' },
          externalTxnId: 'read-1',
        };
      },
    });

    expect(result).toMatchObject({
      kind: 'completed',
      deduplicated: false,
      value: { record: 'R-1' },
    });
    expect(seen).toMatchObject({
      credential: { headerName: 'authorization', headerValue: 'secret' },
    });
    expect(String(seen.idempotencyKey)).toHaveLength(64);
    expect((await listGrants(db.pool, run.id))[0]?.calls_used).toBe(1);
    const { rows: receipts } = await db.pool.query<{
      status: string;
      reversibility: string;
    }>('SELECT status, reversibility FROM tool_receipts WHERE run_id = $1', [run.id]);
    expect(receipts).toEqual([{ status: 'COMMITTED', reversibility: 'reversible' }]);
    const { rows: events } = await db.pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM run_events
       WHERE run_id = $1 AND type LIKE 'ToolInvocation%'
       ORDER BY seq`,
      [run.id],
    );
    expect(events.map((event) => event.type)).toEqual([
      'ToolInvocationStarted',
      'ToolInvocationCommitted',
    ]);
    expect(events[0]?.payload).toMatchObject({
      connector: 'test',
      classification: 'read',
    });
  });

  it('suspends an approval-gated mutation before credentials, receipt, or dispatch', async () => {
    const { run, attempt } = await runningRun([
      {
        action: 'connector.records.write',
        resource: 'records',
        requiresApproval: true,
      },
    ]);
    let credentialsResolved = false;
    let dispatched = false;
    const result = await executeGovernedAction(context(run, attempt), {
      connector: 'test',
      action: 'connector.records.write',
      resource: 'records',
      args: { id: 'R-2' },
      classification: 'mutation',
      requireGrant: true,
      recovery: 'reconcile',
      resolveCredential: async () => {
        credentialsResolved = true;
        return null;
      },
      dispatch: async () => {
        dispatched = true;
        return { value: {}, receiptResult: {} };
      },
    });

    expect(result.kind).toBe('suspend_approval');
    expect(credentialsResolved).toBe(false);
    expect(dispatched).toBe(false);
    expect(await listApprovals(db.pool, run.id, 'PENDING')).toHaveLength(1);
    const { rows: receipts } = await db.pool.query(
      'SELECT id FROM tool_receipts WHERE run_id = $1',
      [run.id],
    );
    expect(receipts).toEqual([]);
  });

  it('honors an explicit approval grant even for a classified read', async () => {
    const { run, attempt } = await runningRun([
      {
        action: 'connector.records.read',
        resource: 'records',
        requiresApproval: true,
      },
    ]);
    let dispatched = false;
    const result = await executeGovernedAction(context(run, attempt), {
      connector: 'test',
      action: 'connector.records.read',
      resource: 'records',
      args: { id: 'R-sensitive' },
      classification: 'read',
      requireGrant: true,
      recovery: 'retry_with_idempotency',
      dispatch: async () => {
        dispatched = true;
        return { value: {}, receiptResult: {} };
      },
    });

    expect(result.kind).toBe('suspend_approval');
    expect(dispatched).toBe(false);
    expect(await listApprovals(db.pool, run.id, 'PENDING')).toHaveLength(1);
  });

  it('marks uncertain mutation failures for reconciliation and will not redispatch them', async () => {
    const { run, attempt } = await runningRun([
      { action: 'connector.records.write', resource: 'records' },
    ]);
    const spec = {
      connector: 'test',
      action: 'connector.records.write',
      resource: 'records',
      args: { id: 'R-3' },
      classification: 'mutation' as const,
      requireGrant: true,
      recovery: 'reconcile' as const,
      dispatch: async () => {
        throw new Error('transport outcome unknown');
      },
    };

    await expect(executeGovernedAction(context(run, attempt), spec)).rejects.toThrow(
      'transport outcome unknown',
    );
    const { rows: first } = await db.pool.query<{ status: string }>(
      'SELECT status FROM tool_receipts WHERE run_id = $1',
      [run.id],
    );
    expect(first[0]?.status).toBe('NEEDS_RECONCILIATION');

    const again = await executeGovernedAction(context(run, attempt), spec);
    expect(again).toMatchObject({ kind: 'reconciliation_required' });
  });
});
