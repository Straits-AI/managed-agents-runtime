import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
    expiresAt?: Date;
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
      patch: { current_attempt_id: attemptId },
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

  it('does not fall back to a broader grant when the selected grant is exhausted concurrently', async () => {
    const { run, attempt } = await runningRun([
      { action: 'connector.records.read', resource: '*' },
      { action: 'connector.records.read', resource: 'private-records', maxCalls: 1 },
    ]);
    let dispatched = false;
    await expect(executeGovernedAction(
      context(run, attempt, {
        resolve: async () => {
          await db.pool.query(
            `UPDATE capability_grants SET calls_used = max_calls
             WHERE run_id = $1 AND resource_pattern = 'private-records'`,
            [run.id],
          );
          return null;
        },
      }),
      {
        connector: 'test',
        action: 'connector.records.read',
        resource: 'private-records',
        args: {},
        classification: 'read',
        requireGrant: false,
        preferExactResourceGrant: true,
        recovery: 'retry_with_idempotency',
        dispatch: async () => {
          dispatched = true;
          return { value: { ok: true } };
        },
      },
    )).rejects.toThrow(/capability disappeared/);
    expect(dispatched).toBe(false);
    const { rows } = await db.pool.query(
      'SELECT id FROM tool_receipts WHERE run_id = $1',
      [run.id],
    );
    expect(rows).toEqual([]);
  });

  it('uses the database clock when deciding whether a grant is expired', async () => {
    const NativeDate = Date;
    const { run, attempt } = await runningRun([
      {
        action: 'connector.records.read',
        resource: 'records',
        expiresAt: new NativeDate('2025-01-01T00:00:00Z'),
      },
    ]);
    class SkewedDate extends NativeDate {
      constructor(value?: string | number | Date) {
        super(value === undefined ? '2000-01-01T00:00:00Z' : value);
      }
      static override now() {
        return NativeDate.parse('2000-01-01T00:00:00Z');
      }
    }
    vi.stubGlobal('Date', SkewedDate);
    let dispatched = false;
    try {
      const result = await executeGovernedAction(context(run, attempt), {
        connector: 'test',
        action: 'connector.records.read',
        resource: 'records',
        args: {},
        classification: 'read',
        requireGrant: true,
        recovery: 'retry_with_idempotency',
        dispatch: async () => {
          dispatched = true;
          return { value: { ok: true } };
        },
      });
      expect(result).toMatchObject({ kind: 'denied' });
      expect(dispatched).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('revalidates grant expiry after credential resolution at dispatch boundary', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write',
      resource: 'records',
      expiresAt: new Date(Date.now() + 60_000),
    }]);
    const baseSpec = {
      connector: 'test', action: 'connector.records.write', resource: 'records',
      args: { id: 'R-grant-toctou' }, classification: 'mutation' as const,
      requireGrant: true, recovery: 'reconcile' as const,
      dispatch: async () => ({ value: { changed: true } }),
      afterDispatch: () => { throw new Error('crash after remote commit'); },
    };
    await expect(executeGovernedAction(context(run, attempt), baseSpec))
      .rejects.toThrow('crash after remote commit');
    let dispatched = false;
    const result = await executeGovernedAction(
      context(run, attempt, {
        resolve: async () => {
          await db.pool.query(
            `UPDATE capability_grants
             SET expires_at = clock_timestamp() - interval '1 second'
             WHERE run_id = $1`,
            [run.id],
          );
          return null;
        },
      }),
      {
        ...baseSpec,
        afterDispatch: undefined,
        reconcile: async () => ({ status: 'not_found' as const, terminal: true as const }),
        dispatch: async () => {
          dispatched = true;
          return { value: { changed: true } };
        },
      },
    );
    expect(result).toEqual({
      kind: 'denied',
      reason: 'capability grant expired before dispatch for connector.records.write',
    });
    expect(dispatched).toBe(false);
    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM tool_receipts WHERE run_id = $1', [run.id],
    );
    expect(rows).toEqual([{ status: 'FAILED' }]);
  });

  it('fails a fresh undispatched receipt when its grant expires at the final boundary', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records',
      expiresAt: new Date(Date.now() + 60_000),
    }]);
    let dispatched = false;
    const result = await executeGovernedAction(context(run, attempt), {
      connector: 'test', action: 'connector.records.write', resource: 'records',
      args: { id: 'R-fresh-grant-expiry' }, classification: 'mutation',
      requireGrant: true, recovery: 'retry_with_idempotency',
      beforeDispatch: async () => {
        await db.pool.query(
          `UPDATE capability_grants
           SET expires_at = clock_timestamp() - interval '1 second'
           WHERE run_id = $1`,
          [run.id],
        );
      },
      dispatch: async () => {
        dispatched = true;
        return { value: { changed: true } };
      },
    });
    expect(result.kind).toBe('denied');
    expect(dispatched).toBe(false);
    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM tool_receipts WHERE run_id = $1', [run.id],
    );
    expect(rows).toEqual([{ status: 'FAILED' }]);
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
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, run.id, {
        expectFrom: ['WAITING_APPROVAL'], to: 'QUEUED', event: { type: 'ApprovalReceived' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' },
      });
    });
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

  it('rejects an APPROVED decision that expired by the database clock', async () => {
    const { run, attempt } = await runningRun([
      {
        action: 'connector.records.write',
        resource: 'records',
        requiresApproval: true,
      },
    ]);
    const spec = {
      connector: 'test',
      action: 'connector.records.write',
      resource: 'records',
      args: { id: 'R-expired-approved' },
      classification: 'mutation' as const,
      requireGrant: true,
      recovery: 'retry_with_idempotency' as const,
      dispatch: async () => ({ value: { changed: true } }),
    };
    const suspended = await executeGovernedAction(context(run, attempt), spec);
    expect(suspended.kind).toBe('suspend_approval');
    const [approval] = await listApprovals(db.pool, run.id, 'PENDING');
    await db.pool.query(
      `UPDATE approvals
       SET status = 'APPROVED', decided_at = clock_timestamp(),
           expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [approval!.id],
    );
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, run.id, {
        expectFrom: ['WAITING_APPROVAL'], to: 'QUEUED', event: { type: 'ApprovalReceived' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' },
      });
    });

    let dispatched = false;
    const result = await executeGovernedAction(context(run, attempt), {
      ...spec,
      dispatch: async () => {
        dispatched = true;
        return { value: { changed: true } };
      },
    });
    expect(result).toEqual({
      kind: 'denied',
      reason: 'approval expired for connector.records.write',
    });
    expect(dispatched).toBe(false);
    expect((await listApprovals(db.pool, run.id))[0]?.status).toBe('EXPIRED');
  });

  it('revalidates approval after slow credential resolution before dispatch', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records', requiresApproval: true,
    }]);
    const args = { id: 'R-approval-toctou' };
    const spec = {
      connector: 'test', action: 'connector.records.write', resource: 'records', args,
      classification: 'mutation' as const, requireGrant: true,
      recovery: 'retry_with_idempotency' as const,
      dispatch: async () => ({ value: { changed: true } }),
    };
    expect((await executeGovernedAction(context(run, attempt), spec)).kind)
      .toBe('suspend_approval');
    const [approval] = await listApprovals(db.pool, run.id, 'PENDING');
    await db.pool.query(
      `UPDATE approvals SET status = 'APPROVED', decided_at = clock_timestamp(),
         expires_at = clock_timestamp() + interval '1 minute' WHERE id = $1`,
      [approval!.id],
    );
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, run.id, {
        expectFrom: ['WAITING_APPROVAL'], to: 'QUEUED', event: { type: 'ApprovalReceived' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' },
      });
    });
    let dispatched = false;
    const result = await executeGovernedAction(
      context(run, attempt, {
        resolve: async () => {
          await db.pool.query(
            `UPDATE approvals SET expires_at = clock_timestamp() - interval '1 second'
             WHERE id = $1`,
            [approval!.id],
          );
          return { headerName: 'authorization', headerValue: 'scoped' };
        },
      }),
      { ...spec, dispatch: async () => {
        dispatched = true;
        return { value: { changed: true } };
      } },
    );
    expect(result).toEqual({
      kind: 'denied', reason: 'approval expired for connector.records.write',
    });
    expect(dispatched).toBe(false);
  });

  it('rechecks approval after receipt creation and requests fresh authority if expired', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records', requiresApproval: true,
    }]);
    const args = { id: 'R-final-approval-boundary' };
    const baseSpec = {
      connector: 'test', action: 'connector.records.write', resource: 'records', args,
      classification: 'mutation' as const, requireGrant: true,
      recovery: 'retry_with_idempotency' as const,
      dispatch: async () => ({ value: { changed: true } }),
    };
    expect((await executeGovernedAction(context(run, attempt), baseSpec)).kind)
      .toBe('suspend_approval');
    const [firstApproval] = await listApprovals(db.pool, run.id, 'PENDING');
    await db.pool.query(
      `UPDATE approvals SET status = 'APPROVED', decided_at = clock_timestamp(),
         expires_at = clock_timestamp() + interval '1 minute' WHERE id = $1`,
      [firstApproval!.id],
    );
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, run.id, {
        expectFrom: ['WAITING_APPROVAL'], to: 'QUEUED', event: { type: 'ApprovalReceived' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' },
      });
    });
    let dispatched = false;
    const result = await executeGovernedAction(context(run, attempt), {
      ...baseSpec,
      beforeDispatch: async () => {
        await db.pool.query(
          `UPDATE approvals SET expires_at = clock_timestamp() - interval '1 second'
           WHERE id = $1`,
          [firstApproval!.id],
        );
      },
      dispatch: async () => {
        dispatched = true;
        return { value: { changed: true } };
      },
    });
    expect(result.kind).toBe('suspend_approval');
    expect(dispatched).toBe(false);
    const approvals = await listApprovals(db.pool, run.id);
    expect(approvals.map((approval) => approval.status)).toEqual(['EXPIRED', 'PENDING']);
    const { rows: receipts } = await db.pool.query<{ approval_id: string; status: string }>(
      'SELECT approval_id, status FROM tool_receipts WHERE run_id = $1', [run.id],
    );
    expect(receipts).toEqual([{
      approval_id: (result as { kind: 'suspend_approval'; approvalId: string }).approvalId,
      status: 'PENDING',
    }]);
  });

  it('refreshes approval that expires during credentials after terminal not_found', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records', requiresApproval: true,
    }]);
    const args = { id: 'R-recovery-credential-expiry' };
    const baseSpec = {
      connector: 'test', action: 'connector.records.write', resource: 'records', args,
      classification: 'mutation' as const, requireGrant: true,
      recovery: 'reconcile' as const,
      dispatch: async () => ({ value: { changed: true } }),
    };
    expect((await executeGovernedAction(context(run, attempt), baseSpec)).kind)
      .toBe('suspend_approval');
    const [approval] = await listApprovals(db.pool, run.id, 'PENDING');
    await db.pool.query(
      `UPDATE approvals SET status = 'APPROVED', decision_by = 'reviewer',
         decided_at = clock_timestamp(), expires_at = clock_timestamp() + interval '1 minute'
       WHERE id = $1`,
      [approval!.id],
    );
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, run.id, {
        expectFrom: ['WAITING_APPROVAL'], to: 'QUEUED', event: { type: 'ApprovalReceived' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' },
      });
    });
    await expect(executeGovernedAction(context(run, attempt), {
      ...baseSpec,
      afterDispatch: () => { throw new Error('crash after remote commit'); },
    })).rejects.toThrow('crash after remote commit');

    const refreshed = await executeGovernedAction(
      context(run, attempt, {
        resolve: async () => {
          await db.pool.query(
            `UPDATE approvals SET expires_at = clock_timestamp() - interval '1 second'
             WHERE id = $1`,
            [approval!.id],
          );
          return null;
        },
      }),
      {
        ...baseSpec,
        reconcile: async () => ({ status: 'not_found' as const, terminal: true as const }),
      },
    );
    expect(refreshed.kind).toBe('suspend_approval');
    const approvals = await listApprovals(db.pool, run.id);
    expect(approvals.map((row) => row.status)).toEqual(['EXPIRED', 'PENDING']);
    const { rows } = await db.pool.query<{ status: string; approval_id: string }>(
      'SELECT status, approval_id FROM tool_receipts WHERE run_id = $1', [run.id],
    );
    expect(rows).toEqual([{
      status: 'PENDING',
      approval_id: (refreshed as { kind: 'suspend_approval'; approvalId: string }).approvalId,
    }]);
  });

  it('refreshes approval that expires during credentials for an idempotent retry', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records', requiresApproval: true,
    }]);
    const args = { id: 'R-idempotent-credential-expiry' };
    const baseSpec = {
      connector: 'test', action: 'connector.records.write', resource: 'records', args,
      classification: 'mutation' as const, requireGrant: true,
      recovery: 'retry_with_idempotency' as const,
      dispatch: async () => ({ value: { changed: true } }),
    };
    expect((await executeGovernedAction(context(run, attempt), baseSpec)).kind)
      .toBe('suspend_approval');
    const [approval] = await listApprovals(db.pool, run.id, 'PENDING');
    await db.pool.query(
      `UPDATE approvals SET status = 'APPROVED', decision_by = 'reviewer',
         decided_at = clock_timestamp(), expires_at = clock_timestamp() + interval '1 minute'
       WHERE id = $1`,
      [approval!.id],
    );
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, run.id, {
        expectFrom: ['WAITING_APPROVAL'], to: 'QUEUED', event: { type: 'ApprovalReceived' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' },
      });
    });
    let dispatches = 0;
    await expect(executeGovernedAction(context(run, attempt), {
      ...baseSpec,
      dispatch: async () => {
        dispatches += 1;
        return { value: { changed: true } };
      },
      afterDispatch: () => { throw new Error('crash after remote commit'); },
    })).rejects.toThrow('crash after remote commit');

    const refreshed = await executeGovernedAction(
      context(run, attempt, {
        resolve: async () => {
          await db.pool.query(
            `UPDATE approvals SET expires_at = clock_timestamp() - interval '1 second'
             WHERE id = $1`,
            [approval!.id],
          );
          return null;
        },
      }),
      {
        ...baseSpec,
        dispatch: async () => {
          dispatches += 1;
          return { value: { changed: true } };
        },
      },
    );
    expect(refreshed.kind).toBe('suspend_approval');
    expect(dispatches).toBe(1);
    const approvals = await listApprovals(db.pool, run.id);
    expect(approvals.map((row) => row.status)).toEqual(['EXPIRED', 'PENDING']);
    const { rows } = await db.pool.query<{ status: string; approval_id: string }>(
      'SELECT status, approval_id FROM tool_receipts WHERE run_id = $1', [run.id],
    );
    expect(rows).toEqual([{
      status: 'PENDING',
      approval_id: (refreshed as { kind: 'suspend_approval'; approvalId: string }).approvalId,
    }]);
  });

  it('fails a fresh undispatched receipt when final approval is denied', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records', requiresApproval: true,
    }]);
    const args = { id: 'R-final-approval-denial' };
    const baseSpec = {
      connector: 'test', action: 'connector.records.write', resource: 'records', args,
      classification: 'mutation' as const, requireGrant: true,
      recovery: 'retry_with_idempotency' as const,
      dispatch: async () => ({ value: { changed: true } }),
    };
    expect((await executeGovernedAction(context(run, attempt), baseSpec)).kind)
      .toBe('suspend_approval');
    const [approval] = await listApprovals(db.pool, run.id, 'PENDING');
    await db.pool.query(
      `UPDATE approvals SET status = 'APPROVED', decision_by = 'reviewer',
         decided_at = clock_timestamp() WHERE id = $1`,
      [approval!.id],
    );
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, run.id, {
        expectFrom: ['WAITING_APPROVAL'], to: 'QUEUED', event: { type: 'ApprovalReceived' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' },
      });
    });
    let dispatched = false;
    const result = await executeGovernedAction(context(run, attempt), {
      ...baseSpec,
      beforeDispatch: async () => {
        await db.pool.query(
          `UPDATE approvals SET status = 'DENIED', decision_by = 'reviewer',
             decided_at = clock_timestamp() WHERE id = $1`,
          [approval!.id],
        );
      },
      dispatch: async () => {
        dispatched = true;
        return { value: { changed: true } };
      },
    });
    expect(result).toEqual({
      kind: 'denied', reason: 'connector.records.write was denied by reviewer',
    });
    expect(dispatched).toBe(false);
    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM tool_receipts WHERE run_id = $1', [run.id],
    );
    expect(rows).toEqual([{ status: 'FAILED' }]);
  });

  it('does not commit a remote result after the current attempt loses ownership', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records',
    }]);
    await expect(executeGovernedAction(context(run, attempt), {
      connector: 'test', action: 'connector.records.write', resource: 'records',
      args: { id: 'R-stale-after-dispatch' }, classification: 'mutation',
      requireGrant: true, recovery: 'retry_with_idempotency',
      dispatch: async () => {
        await db.pool.query(
          `UPDATE run_attempts SET state = 'SUPERSEDED' WHERE id = $1`,
          [attempt.id],
        );
        return { value: { changed: true } };
      },
    })).rejects.toThrow(/no longer current/);
    const { rows: receipts } = await db.pool.query<{ status: string }>(
      'SELECT status FROM tool_receipts WHERE run_id = $1', [run.id],
    );
    expect(receipts).toEqual([{ status: 'PENDING' }]);
    const { rows: committed } = await db.pool.query(
      `SELECT 1 FROM run_events WHERE run_id = $1 AND type = 'ToolInvocationCommitted'`,
      [run.id],
    );
    expect(committed).toEqual([]);
  });

  it('does not dispatch after an async pre-dispatch hook loses ownership', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records',
    }]);
    let dispatched = false;
    await expect(executeGovernedAction(context(run, attempt), {
      connector: 'test', action: 'connector.records.write', resource: 'records',
      args: { id: 'R-stale-before-dispatch' }, classification: 'mutation',
      requireGrant: true, recovery: 'retry_with_idempotency',
      beforeDispatch: async () => {
        await db.pool.query(
          `UPDATE run_attempts SET state = 'SUPERSEDED' WHERE id = $1`, [attempt.id],
        );
      },
      dispatch: async () => {
        dispatched = true;
        return { value: { changed: true } };
      },
    })).rejects.toThrow(/no longer current/);
    expect(dispatched).toBe(false);
    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM tool_receipts WHERE run_id = $1', [run.id],
    );
    expect(rows).toEqual([{ status: 'PENDING' }]);
  });

  it('does not terminalize reconciliation after ownership is lost', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records',
    }]);
    const baseSpec = {
      connector: 'test', action: 'connector.records.write', resource: 'records',
      args: { id: 'R-stale-reconcile' }, classification: 'mutation' as const,
      requireGrant: true, recovery: 'reconcile' as const,
      dispatch: async () => ({ value: { changed: true } }),
      afterDispatch: () => { throw new Error('crash after remote commit'); },
    };
    await expect(executeGovernedAction(context(run, attempt), baseSpec))
      .rejects.toThrow('crash after remote commit');
    await expect(executeGovernedAction(context(run, attempt), {
      ...baseSpec,
      afterDispatch: undefined,
      reconcile: async () => {
        await db.pool.query(
          `UPDATE run_attempts SET state = 'SUPERSEDED' WHERE id = $1`, [attempt.id],
        );
        return { status: 'unknown' as const };
      },
    })).rejects.toThrow(/no longer current/);
    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM tool_receipts WHERE run_id = $1', [run.id],
    );
    expect(rows).toEqual([{ status: 'PENDING' }]);
  });

  it('serializes a pool-sized same-action recovery burst without starving the pool', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records',
    }]);
    let dispatches = 0;
    const spec = {
      connector: 'test', action: 'connector.records.write', resource: 'records',
      args: { id: 'R-pool-fence' }, classification: 'mutation' as const,
      requireGrant: true, recovery: 'retry_with_idempotency' as const,
      dispatch: async () => {
        dispatches += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { value: { changed: true } };
      },
    };
    const dbBackedCredentials: CredentialProvider = {
      resolve: async () => {
        await db.pool.query('SELECT 1');
        return null;
      },
    };
    const outcomes = await Promise.race([
      Promise.all(Array.from({ length: db.pool.options.max ?? 10 }, () =>
        executeGovernedAction(context(run, attempt, dbBackedCredentials), spec))),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('pool starvation timeout')), 2_000)),
    ]);
    expect(outcomes).toHaveLength(db.pool.options.max ?? 10);
    expect(dispatches).toBe(1);
    expect(outcomes.filter((outcome) =>
      outcome.kind === 'completed' && outcome.deduplicated)).toHaveLength(
      (db.pool.options.max ?? 10) - 1,
    );
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

  it('fails an authoritatively absent recovered receipt on validation denial', async () => {
    const { run, attempt } = await runningRun([{
      action: 'connector.records.write', resource: 'records',
    }]);
    const baseSpec = {
      connector: 'test', action: 'connector.records.write', resource: 'records',
      args: { id: 'R-validation-after-not-found' }, classification: 'mutation' as const,
      requireGrant: true, recovery: 'reconcile' as const,
      dispatch: async () => ({ value: { changed: true } }),
      afterDispatch: () => { throw new Error('crash after remote commit'); },
    };
    await expect(executeGovernedAction(context(run, attempt), baseSpec))
      .rejects.toThrow('crash after remote commit');
    const result = await executeGovernedAction(context(run, attempt), {
      ...baseSpec,
      afterDispatch: undefined,
      reconcile: async () => ({ status: 'not_found' as const, terminal: true as const }),
      validate: () => ({ ok: false as const, reason: 'connector policy changed' }),
    });
    expect(result).toEqual({ kind: 'denied', reason: 'connector policy changed' });
    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM tool_receipts WHERE run_id = $1', [run.id],
    );
    expect(rows).toEqual([{ status: 'FAILED' }]);
  });
});
