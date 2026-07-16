import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { startExternalSystem, type ExternalSystem } from '../bench/externalSystem.js';
import { withTransaction } from '../src/db/tx.js';
import { loadConfig } from '../src/config.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { transitionRun } from '../src/core/transition.js';
import { decideApproval, listApprovals } from '../src/store/approvals.js';
import { findReceiptByKey, idempotencyKey } from '../src/store/receipts.js';
import { dispatchTool, type ToolContext } from '../src/harness/toolRouter.js';
import { newId } from '../src/ids.js';
import type { RunAttemptRow, RunRow } from '../src/core/types.js';

let db: TestDb;
let external: ExternalSystem;
let agentVersionId: string;
const cfg = loadConfig({ ...process.env, HARNESS_ENABLE_FAULTS: '0' });

// The external.http tool never touches the sandbox — these stubs prove it.
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error('sandbox/objectStore must not be touched by external.http');
    },
  },
);

beforeAll(async () => {
  db = await createTestDb();
  external = await startExternalSystem();
  const def = await createAgentDefinition(db.pool, { name: 'router-agent' });
  const ver = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, {
      agentId: def.id,
      instructions: 'x',
      modelPolicy: { model: 'none' },
    }),
  );
  agentVersionId = ver.id;
});

afterAll(async () => {
  await external.close();
  await db.drop();
});

async function runningRun(
  grants: { action: string; resource?: string; requiresApproval?: boolean; maxCalls?: number }[],
): Promise<{ run: RunRow; attempt: RunAttemptRow }> {
  const run = await withTransaction(db.pool, (tx) =>
    createRun(tx, { agentVersionId, goal: 'router test', grants }),
  );
  const attemptId = newId('att');
  const { rows } = await db.pool.query<RunAttemptRow>(
    `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
     VALUES ($1, $2, 1, 'test-worker', 'ACTIVE', now() + interval '60 seconds')
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

function ctx(run: RunRow, attempt: RunAttemptRow): ToolContext {
  return {
    pool: db.pool,
    cfg,
    run,
    attempt,
    sandbox: untouchable as ToolContext['sandbox'],
    sandboxProvider: untouchable as ToolContext['sandboxProvider'],
    objectStore: untouchable as ToolContext['objectStore'],
    step: 1,
  };
}

describe('external.http.request', () => {
  it('rejects a write with no matching grant', async () => {
    const { run, attempt } = await runningRun([]);
    const outcome = await dispatchTool(ctx(run, attempt), 'external_http_request', {
      method: 'POST',
      url: `${external.url}/deploy`,
      body: { app: 'x' },
    });
    expect(outcome).toMatchObject({ kind: 'result' });
    expect((outcome as { content: string }).content).toMatch(
      /no capability grant|private host/,
    );
    expect(external.actions()).toHaveLength(0);
  });

  it('refuses ungranted requests to private hosts and non-http schemes (SSRF guard)', async () => {
    const { run, attempt } = await runningRun([]);
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:8080/v1/runs',
      'file:///etc/passwd',
    ]) {
      const outcome = await dispatchTool(ctx(run, attempt), 'external_http_request', {
        method: 'GET',
        url,
      });
      expect((outcome as { content: string }).content).toMatch(
        /private host|not allowed|invalid URL/,
      );
    }
  });

  it('executes an approval-free write exactly once and dedupes retries', async () => {
    const { run, attempt } = await runningRun([
      { action: 'external.http.*', resource: '*' },
    ]);
    const args = { method: 'POST', url: `${external.url}/orders`, body: { sku: 'a1' } };

    const first = await dispatchTool(ctx(run, attempt), 'external_http_request', args);
    expect((first as { content: string }).content).toContain('transactionId');

    const countAfterFirst = external.actions().length;

    // Identical proposal after a "recovery": receipt dedupe, no new action.
    const second = await dispatchTool(ctx(run, attempt), 'external_http_request', args);
    expect((second as { content: string }).content).toContain('deduplicated');
    expect(external.actions()).toHaveLength(countAfterFirst);

    const key = idempotencyKey({
      runId: run.id,
      action: 'external.http.request',
      args,
    });
    const receipt = await findReceiptByKey(db.pool, run.id, key);
    expect(receipt!.status).toBe('COMMITTED');
    expect(receipt!.external_txn_id).toBeTruthy();
  });

  it('retries a PENDING receipt with the same idempotency key (at-least-once + dedupe)', async () => {
    const { run, attempt } = await runningRun([
      { action: 'external.http.*', resource: '*' },
    ]);
    const args = { method: 'POST', url: `${external.url}/payments`, body: { amount: 5 } };

    // First dispatch commits normally.
    await dispatchTool(ctx(run, attempt), 'external_http_request', args);
    // Simulate a crash after send but before commit on a DIFFERENT action:
    const args2 = { method: 'POST', url: `${external.url}/payments`, body: { amount: 9 } };
    const key2 = idempotencyKey({ runId: run.id, action: 'external.http.request', args: args2 });
    // Pre-send the request as the "crashed" attempt did:
    await fetch(`${external.url}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key2 },
      body: JSON.stringify(args2.body),
    });
    const before = external.actions().length;

    // Recovery re-dispatches the same proposal: same key, external system
    // replays the original result — still exactly one action.
    const outcome = await dispatchTool(ctx(run, attempt), 'external_http_request', args2);
    expect((outcome as { content: string }).content).toContain('transactionId');
    expect(external.actions()).toHaveLength(before);
    const action = external
      .actions()
      .find((a) => a.idempotencyKey === key2);
    expect(action!.receivedCount).toBe(2); // received twice, recorded once
  });

  it('suspends for approval, then executes exactly once after approve', async () => {
    const { run, attempt } = await runningRun([
      { action: 'external.http.*', resource: '*', requiresApproval: true },
    ]);
    const args = { method: 'POST', url: `${external.url}/deploys`, body: { env: 'prod' } };

    const outcome = await dispatchTool(ctx(run, attempt), 'external_http_request', args);
    expect(outcome.kind).toBe('suspend_approval');

    const suspended = await getRun(db.pool, run.id);
    expect(suspended!.status).toBe('WAITING_APPROVAL');
    expect(external.actions().filter((a) => a.path === '/deploys')).toHaveLength(0);

    const approvals = await listApprovals(db.pool, run.id, 'PENDING');
    expect(approvals).toHaveLength(1);

    // Human approves; the run is requeued (as the API route does).
    await withTransaction(db.pool, async (tx) => {
      await decideApproval(tx, approvals[0]!.id, 'APPROVED', 'tester');
      await transitionRun(tx, run.id, {
        expectFrom: ['WAITING_APPROVAL'],
        to: 'QUEUED',
        event: { type: 'ApprovalReceived', payload: { approvalId: approvals[0]!.id } },
      });
      // Next epoch: back to RUNNING.
      await transitionRun(tx, run.id, {
        expectFrom: ['QUEUED'],
        to: 'STARTING',
        event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['STARTING'],
        to: 'RUNNING',
        event: { type: 'AttemptStarted' },
      });
    });

    const resumed = await getRun(db.pool, run.id);
    const retried = await dispatchTool(
      ctx(resumed!, attempt),
      'external_http_request',
      args,
    );
    expect(retried.kind).toBe('result');
    expect((retried as { content: string }).content).toContain('transactionId');
    expect(external.actions().filter((a) => a.path === '/deploys')).toHaveLength(1);

    // A later identical proposal dedupes off the receipt.
    const again = await dispatchTool(ctx(resumed!, attempt), 'external_http_request', args);
    expect((again as { content: string }).content).toContain('deduplicated');
    expect(external.actions().filter((a) => a.path === '/deploys')).toHaveLength(1);
  });

  it('reports a denial to the model without executing', async () => {
    const { run, attempt } = await runningRun([
      { action: 'external.http.*', resource: '*', requiresApproval: true },
    ]);
    const args = { method: 'DELETE', url: `${external.url}/databases/prod` };

    const outcome = await dispatchTool(ctx(run, attempt), 'external_http_request', args);
    expect(outcome.kind).toBe('suspend_approval');

    const approvals = await listApprovals(db.pool, run.id, 'PENDING');
    await withTransaction(db.pool, async (tx) => {
      await decideApproval(tx, approvals[0]!.id, 'DENIED', 'tester');
      await transitionRun(tx, run.id, {
        expectFrom: ['WAITING_APPROVAL'],
        to: 'QUEUED',
        event: { type: 'ApprovalDenied' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['QUEUED'],
        to: 'STARTING',
        event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['STARTING'],
        to: 'RUNNING',
        event: { type: 'AttemptStarted' },
      });
    });

    const resumed = await getRun(db.pool, run.id);
    const retried = await dispatchTool(
      ctx(resumed!, attempt),
      'external_http_request',
      args,
    );
    expect((retried as { content: string }).content).toContain('denied');
    expect(external.actions().filter((a) => a.path === '/databases/prod')).toHaveLength(0);
  });

  it('allows granted GET reads and records a reversible receipt', async () => {
    const { run, attempt } = await runningRun([
      { action: 'external.http.*', resource: '*' },
    ]);
    const args = { method: 'GET', url: `${external.url}/status` };
    const outcome = await dispatchTool(ctx(run, attempt), 'external_http_request', args);
    expect((outcome as { content: string }).content).toContain('"ok":true');

    const key = idempotencyKey({ runId: run.id, action: 'external.http.request', args });
    const receipt = await findReceiptByKey(db.pool, run.id, key);
    expect(receipt!.status).toBe('COMMITTED');
    expect(receipt!.reversibility).toBe('reversible');
  });
});

describe('progress_update', () => {
  it('persists the ledger to the run row', async () => {
    const { run, attempt } = await runningRun([]);
    await dispatchTool(ctx(run, attempt), 'progress_update', {
      objective: 'test objective',
      completed: ['step one'],
      remaining: ['step two'],
    });
    const after = await getRun(db.pool, run.id);
    expect(after!.progress).toMatchObject({
      objective: 'test objective',
      completed: ['step one'],
    });
  });
});
