import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { transitionRun } from '../src/core/transition.js';
import { newId } from '../src/ids.js';
import type { RunAttemptRow, RunRow } from '../src/core/types.js';
import type { CredentialProvider } from '../src/providers/types.js';
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

function context(
  run: RunRow,
  attempt: RunAttemptRow,
  credentials?: CredentialProvider,
): GovernedActionContext {
  return { pool: db.pool, run, attempt, step: 3, credentials };
}

describe('governed action pipeline', () => {
  it('runs a classified read through policy, credentials, receipt, dispatch, and audit', async () => {
    const { run, attempt } = await runningRun([
      { action: 'connector.records.read', resource: 'records', maxCalls: 1 },
    ]);
    const seen: Record<string, unknown> = {};
    let credentialRequest: Parameters<CredentialProvider['resolve']>[0] | undefined;
    const result = await executeGovernedAction(
      context(run, attempt, {
        resolve: async (input) => {
          credentialRequest = input;
          return { headerName: 'authorization', headerValue: 'secret' };
        },
      }),
      {
      connector: 'test',
      action: 'connector.records.read',
      resource: 'records',
      args: { id: 'R-1' },
      classification: 'read',
      requireGrant: true,
      recovery: 'retry_with_idempotency',
      audit: {
        connector: 'forged',
        action: 'forged',
        classification: 'mutation',
        receiptId: 'forged',
        method: 'GET',
      },
      dispatch: async (input) => {
        Object.assign(seen, input);
        return {
          value: { record: 'R-1' },
          externalTxnId: 'read-1',
          audit: { connector: 'also-forged', status: 200 },
        };
      },
      },
    );

    expect(result).toMatchObject({
      kind: 'completed',
      deduplicated: false,
      value: { record: 'R-1' },
    });
    expect(seen).toMatchObject({
      credential: { headerName: 'authorization', headerValue: 'secret' },
    });
    expect(String(seen.idempotencyKey)).toHaveLength(64);
    expect(credentialRequest).toMatchObject({
      tenantId: 'default',
      runId: run.id,
      attemptId: attempt.id,
      caller: 'test',
      purpose: 'connector.records.read',
      action: 'connector.records.read',
      resource: 'records',
      idempotencyKey: seen.idempotencyKey,
    });
    expect((await listGrants(db.pool, run.id))[0]?.calls_used).toBe(1);
    const { rows: receipts } = await db.pool.query<{
      id: string;
      status: string;
      reversibility: string;
    }>('SELECT id, status, reversibility FROM tool_receipts WHERE run_id = $1', [run.id]);
    expect(receipts).toMatchObject([{ status: 'COMMITTED', reversibility: 'reversible' }]);
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
      receiptId: receipts[0]?.id,
      connector: 'test',
      action: 'connector.records.read',
      classification: 'read',
      method: 'GET',
    });
    expect(events[1]?.payload).toMatchObject({
      receiptId: receipts[0]?.id,
      connector: 'test',
      action: 'connector.records.read',
      classification: 'read',
      status: 200,
    });
  });

  it('audits validation denials through the same canonical envelope', async () => {
    const { run, attempt } = await runningRun([]);
    const result = await executeGovernedAction(context(run, attempt), {
      connector: 'test',
      action: 'connector.records.read',
      resource: 'records',
      args: {},
      classification: 'read',
      requireGrant: false,
      recovery: 'retry_with_idempotency',
      audit: { connector: 'forged', reason: 'forged' },
      validate: () => ({ ok: false, reason: 'resource is outside policy' }),
      dispatch: async () => ({ value: {} }),
    });

    expect(result).toEqual({ kind: 'denied', reason: 'resource is outside policy' });
    const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM run_events
       WHERE run_id = $1 AND type = 'ActionDenied'`,
      [run.id],
    );
    expect(rows[0]?.payload).toMatchObject({
      connector: 'test',
      action: 'connector.records.read',
      classification: 'read',
      stage: 'validation',
      reason: 'resource is outside policy',
    });
  });

  it('audits credential failures before receipt creation and allows a clean retry', async () => {
    const { run, attempt } = await runningRun([
      { action: 'connector.records.write', resource: 'records', maxCalls: 1 },
    ]);
    const spec = {
      connector: 'test',
      action: 'connector.records.write',
      resource: 'records',
      args: { id: 'R-credential' },
      classification: 'mutation' as const,
      requireGrant: true,
      recovery: 'reconcile' as const,
      dispatch: async () => ({ value: { ok: true } }),
    };

    await expect(
      executeGovernedAction(
        context(run, attempt, {
          resolve: async () => {
            throw new Error('kms secret must not leak');
          },
        }),
        spec,
      ),
    ).rejects.toThrow('credential resolution failed for connector.records.write');
    expect((await listGrants(db.pool, run.id))[0]?.calls_used).toBe(0);
    const { rows: receipts } = await db.pool.query(
      'SELECT id FROM tool_receipts WHERE run_id = $1',
      [run.id],
    );
    expect(receipts).toEqual([]);
    const { rows: failures } = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM run_events
       WHERE run_id = $1 AND type = 'ToolInvocationFailed'`,
      [run.id],
    );
    expect(failures[0]?.payload).toMatchObject({
      stage: 'credential',
      reconciliationRequired: false,
    });
    expect(JSON.stringify(failures)).not.toContain('kms secret');

    const retry = await executeGovernedAction(context(run, attempt), spec);
    expect(retry).toMatchObject({ kind: 'completed', value: { ok: true } });
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
    const result = await executeGovernedAction(
      context(run, attempt, {
        resolve: async () => {
          credentialsResolved = true;
          return null;
        },
      }),
      {
      connector: 'test',
      action: 'connector.records.write',
      resource: 'records',
      args: { id: 'R-2' },
      classification: 'mutation',
      requireGrant: true,
      recovery: 'reconcile',
      dispatch: async () => {
        dispatched = true;
        return { value: {} };
      },
      },
    );

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
        return { value: {} };
      },
    });

    expect(result.kind).toBe('suspend_approval');
    expect(dispatched).toBe(false);
    const [approval] = await listApprovals(db.pool, run.id, 'PENDING');
    expect(approval).toBeDefined();

    await db.pool.query(
      `UPDATE approvals SET status = 'EXPIRED', decided_at = now() WHERE id = $1`,
      [approval!.id],
    );
    const expired = await executeGovernedAction(context(run, attempt), {
      connector: 'test',
      action: 'connector.records.read',
      resource: 'records',
      args: { id: 'R-sensitive' },
      classification: 'read',
      requireGrant: true,
      recovery: 'retry_with_idempotency',
      dispatch: async () => {
        dispatched = true;
        return { value: {} };
      },
    });
    expect(expired).toEqual({
      kind: 'denied',
      reason: 'approval expired for connector.records.read',
    });
    expect(dispatched).toBe(false);
    const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM run_events
       WHERE run_id = $1 AND type = 'ActionDenied'`,
      [run.id],
    );
    expect(rows.at(-1)?.payload).toMatchObject({
      stage: 'approval',
      reason: 'approval expired for connector.records.read',
    });
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
