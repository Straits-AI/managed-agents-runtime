import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createTenant, createApiKey } from '../src/store/tenants.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { transitionRun } from '../src/core/transition.js';
import { spawnChildren, wakeReadyParents } from '../src/scheduler/children.js';
import { authorizeAndConsume, listGrants } from '../src/store/grants.js';
import { claimRun } from '../src/scheduler/claim.js';
import { exitAttempt } from '../src/store/attempts.js';
import { listEvents } from '../src/store/events.js';
import { decideApproval, listApprovals } from '../src/store/approvals.js';
import { WorkspaceManager } from '../src/harness/workspace.js';
import { createRealEpoch } from '../src/harness/epoch.js';
import { LocalSandboxProvider } from '../src/providers/local/localSandbox.js';
import { FsObjectStore } from '../src/providers/local/fsObjectStore.js';
import type { ModelProvider } from '../src/providers/types.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/api/server.js';
import { dispatchTool } from '../src/harness/toolRouter.js';
import type { SafeHttpRequest } from '../src/net/safeHttp.js';
import {
  commitReceipt,
  idempotencyKey,
  insertPendingReceipt,
  replacementRootRunId,
} from '../src/store/receipts.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe('delegated run tenancy and policy', () => {
  it('derives child ownership from the locked non-default parent', async () => {
    const grantExpiry = new Date(Date.now() + 60_000);
    const storeDir = mkdtempSync(join(tmpdir(), 'ma-child-tenant-'));
    const objectStore = new FsObjectStore(storeDir);
    const sandbox = new LocalSandboxProvider();
    await objectStore.start();
    const tenant = await createTenant(db.pool, { name: 'Delegation tenant' });
    const definition = await createAgentDefinition(db.pool, {
      tenantId: tenant.id,
      name: 'delegating-agent',
    });
    const version = await withTransaction(db.pool, (tx) =>
      createAgentVersion(tx, {
        agentId: definition.id,
        instructions: 'delegate safely',
        modelPolicy: { model: 'none' },
      }),
    );
    const parent = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenant.id,
        agentVersionId: version.id,
        goal: 'parent objective',
      }),
    );

    const workspaces = new WorkspaceManager(db.pool, sandbox, objectStore);
    const parentSandbox = await sandbox.create({ runId: parent.id, timeoutMinutes: 1 });
    await workspaces.restore(parentSandbox, {
      runId: parent.id,
      attemptId: 'att_parent_seed',
      workspaceId: parent.workspace_id!,
      seedFiles: { 'tenant-seed.txt': 'owned-seed' },
    });
    const parentRevisionId = await workspaces.checkpoint(parentSandbox, {
      runId: parent.id,
      attemptId: 'att_parent_seed',
      workspaceId: parent.workspace_id!,
    });
    await sandbox.terminate(parentSandbox);

    const childId = await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, parent.id, {
        expectFrom: ['QUEUED'],
        to: 'STARTING',
        event: { type: 'AttemptStarted', payload: { attemptNo: 1 } },
        attemptId: 'att_parent_test',
        patch: { current_attempt_id: 'att_parent_test' },
      });
      await transitionRun(tx, parent.id, {
        expectFrom: ['STARTING'],
        to: 'RUNNING',
        event: { type: 'AttemptStarted', payload: { phase: 'running' } },
        attemptId: 'att_parent_test',
      });
      const ids = await spawnChildren(tx, {
        parentRunId: parent.id,
        attemptId: 'att_parent_test',
        children: [
          {
            agentVersionId: version.id,
            goal: 'tenant-bound child',
            tokenBudget: 40_000,
            maxSteps: 7,
            grants: [
              {
                action: 'external.http.request',
                resource: 'https://api.example.com',
                requiresApproval: true,
                maxCalls: 2,
                expiresAt: grantExpiry,
              },
            ],
          },
        ],
      });
      return ids[0]!;
    });

    const child = await getRun(db.pool, childId, tenant.id);
    expect(child).not.toBeNull();
    expect(child).toMatchObject({
      tenant_id: tenant.id,
      parent_run_id: parent.id,
      agent_version_id: version.id,
      max_steps: 7,
      token_budget: '40000',
    });
    expect(child!.workspace_id).not.toBe(parent.workspace_id);
    expect(await getRun(db.pool, childId, 'default')).toBeNull();

    const grants = await listGrants(db.pool, childId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      action_pattern: 'external.http.request',
      resource_pattern: 'https://api.example.com',
      requires_approval: true,
      max_calls: 2,
      calls_used: 0,
      expires_at: grantExpiry,
    });

    const claimed = await claimRun(db.pool, 'workspace-seed-test', 30_000);
    expect(claimed?.run.id).toBe(childId);
    const runningChild = await withTransaction(db.pool, (tx) =>
      transitionRun(tx, childId, {
        expectFrom: ['STARTING'],
        to: 'RUNNING',
        event: { type: 'AttemptStarted', payload: { phase: 'running' } },
        attemptId: claimed!.attempt.id,
      }),
    );
    let modelObservedSeed = false;
    let modelCalls = 0;
    const model: ModelProvider = {
      async chat(req) {
        modelCalls += 1;
        const toolMessage = req.messages.findLast((message) => message.role === 'tool');
        if (toolMessage) {
          modelObservedSeed = toolMessage.content === 'owned-seed';
          throw new Error('workspace seed proof complete');
        }
        return {
          message: {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'read-seed',
                name: 'file_read',
                arguments: { path: 'tenant-seed.txt' },
              },
            ],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const cfg = loadConfig({
      ...process.env,
      DATABASE_URL: db.url,
      API_AUTH_TOKEN: 'delegation-test-token',
      SUPERVISOR_ENABLED: '0',
    });
    await expect(
      createRealEpoch({ model, sandbox, objectStore })({
        pool: db.pool,
        cfg,
        run: runningChild,
        attempt: claimed!.attempt,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('workspace seed proof complete');
    expect(modelCalls).toBe(2);
    expect(modelObservedSeed).toBe(true);
    const restored = (await listEvents(db.pool, childId)).find(
      (event) => event.type === 'WorkspaceRestored',
    );
    expect(restored?.payload.fromRevision).toBe(parentRevisionId);

    const consumed = await withTransaction(db.pool, (tx) =>
      authorizeAndConsume(
        tx,
        childId,
        'external.http.request',
        'https://api.example.com',
      ),
    );
    expect(consumed.allowed).toBe(true);
    const externalArgs = {
      method: 'POST',
      url: 'https://api.example.com/items',
      body: { id: 42 },
    };
    const originalScope = await replacementRootRunId(db.pool, childId);
    expect(originalScope).toBe(childId);
    const originalKey = idempotencyKey({
      runId: originalScope,
      action: 'external.http.request',
      args: externalArgs,
    });
    await withTransaction(db.pool, async (tx) => {
      const receipt = await insertPendingReceipt(tx, {
        runId: childId,
        attemptId: claimed!.attempt.id,
        step: 1,
        action: 'external.http.request',
        args: externalArgs,
        idempotencyKey: originalKey,
        reversibility: 'irreversible',
      });
      await commitReceipt(tx, receipt.id, {
        externalTxnId: 'txn-original',
        result: { status: 201, body: { id: 42 } },
      });
    });
    const pendingArgs = {
      method: 'POST',
      url: 'https://api.example.com/items',
      body: { id: 43 },
    };
    const finalConsumption = await withTransaction(db.pool, (tx) =>
      authorizeAndConsume(
        tx,
        childId,
        'external.http.request',
        'https://api.example.com',
      ),
    );
    expect(finalConsumption.allowed).toBe(true);
    const pendingKey = idempotencyKey({
      runId: originalScope,
      action: 'external.http.request',
      args: pendingArgs,
    });
    const pendingReceipt = await withTransaction(db.pool, (tx) =>
      insertPendingReceipt(tx, {
        runId: childId,
        attemptId: claimed!.attempt.id,
        step: 2,
        action: 'external.http.request',
        args: pendingArgs,
        idempotencyKey: pendingKey,
        reversibility: 'irreversible',
      }),
    );

    await withTransaction(db.pool, async (tx) => {
      await exitAttempt(tx, claimed!.attempt.id, 'test failure');
      await transitionRun(tx, childId, {
        expectFrom: ['RUNNING'],
        to: 'FAILED',
        event: { type: 'RunFailed', payload: { reason: 'test failure' } },
        reason: 'test failure',
      });
    });

    const wake = await wakeReadyParents(db.pool, 1);
    expect(wake.woken).toEqual([]);
    expect(wake.replaced).toHaveLength(1);

    const replacement = await getRun(db.pool, wake.replaced[0]!, tenant.id);
    expect(replacement).not.toBeNull();
    expect(replacement).toMatchObject({
      tenant_id: tenant.id,
      parent_run_id: parent.id,
      replaces_run_id: childId,
      replacement_generation: 1,
      agent_version_id: version.id,
      max_steps: 7,
      // The failed child consumed 2 tokens before replacement; only its
      // remaining allocation may be reserved again.
      token_budget: '39998',
    });
    expect(replacement!.input).toMatchObject({
      replacedFrom: childId,
      replacementGeneration: 1,
    });
    expect(await getRun(db.pool, replacement!.id, 'default')).toBeNull();

    const replacementGrants = await listGrants(db.pool, replacement!.id);
    expect(replacementGrants).toHaveLength(1);
    expect(replacementGrants[0]).toMatchObject({
      action_pattern: 'external.http.request',
      resource_pattern: 'https://api.example.com',
      requires_approval: true,
      max_calls: 0,
      calls_used: 0,
      expires_at: grantExpiry,
    });
    expect(await replacementRootRunId(db.pool, replacement!.id)).toBe(childId);

    const replacementClaim = await claimRun(db.pool, 'replacement-test', 30_000);
    expect(replacementClaim?.run.id).toBe(replacement!.id);
    const runningReplacement = await withTransaction(db.pool, (tx) =>
      transitionRun(tx, replacement!.id, {
        expectFrom: ['STARTING'],
        to: 'RUNNING',
        event: { type: 'AttemptStarted', payload: { phase: 'running' } },
        attemptId: replacementClaim!.attempt.id,
      }),
    );
    const deduplicated = await dispatchTool(
      {
        pool: db.pool,
        cfg,
        run: runningReplacement,
        attempt: replacementClaim!.attempt,
        sandbox: { sandboxId: 'unused', baseUrl: 'unused' },
        sandboxProvider: sandbox,
        objectStore,
        step: 1,
      },
      'external_http_request',
      externalArgs,
    );
    expect(deduplicated).toMatchObject({ kind: 'result' });
    expect(JSON.parse((deduplicated as { content: string }).content)).toMatchObject({
      deduplicated: true,
      result: { status: 201, body: { id: 42 } },
    });
    const httpRequest = vi.fn(async (_input: SafeHttpRequest) => ({
      status: 201,
      headers: { 'content-type': 'application/json', 'x-transaction-id': 'txn-recovered' },
      body: JSON.stringify({ id: 43 }),
      redirects: 0,
    }));
    const recoveryContext = {
      pool: db.pool,
      cfg,
      run: runningReplacement,
      attempt: replacementClaim!.attempt,
      sandbox: { sandboxId: 'unused', baseUrl: 'unused' },
      sandboxProvider: sandbox,
      objectStore,
      http: { request: httpRequest },
      step: 2,
    };
    const suspendedRecovery = await dispatchTool(
      recoveryContext,
      'external_http_request',
      pendingArgs,
    );
    expect(suspendedRecovery.kind).toBe('suspend_approval');
    expect(httpRequest).not.toHaveBeenCalled();
    const [recoveryApproval] = await listApprovals(
      db.pool,
      replacement!.id,
      'PENDING',
    );
    expect(recoveryApproval).toBeDefined();
    await db.pool.query(
      `UPDATE approvals SET status = 'EXPIRED', decided_at = clock_timestamp()
       WHERE id = $1`,
      [recoveryApproval!.id],
    );
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, replacement!.id, {
        expectFrom: ['WAITING_APPROVAL'],
        to: 'QUEUED',
        event: { type: 'ApprovalReceived', payload: { approvalId: recoveryApproval!.id } },
      });
      await transitionRun(tx, replacement!.id, {
        expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, replacement!.id, {
        expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' },
      });
    });
    const expiredApprovalRun = await getRun(db.pool, replacement!.id);
    const refreshed = await dispatchTool(
      { ...recoveryContext, run: expiredApprovalRun! },
      'external_http_request',
      pendingArgs,
    );
    expect(refreshed.kind).toBe('suspend_approval');
    const [freshApproval] = await listApprovals(db.pool, replacement!.id, 'PENDING');
    expect(freshApproval?.id).not.toBe(recoveryApproval!.id);
    await withTransaction(db.pool, async (tx) => {
      await decideApproval(tx, freshApproval!.id, 'APPROVED', 'replacement-test');
      await transitionRun(tx, replacement!.id, {
        expectFrom: ['WAITING_APPROVAL'], to: 'QUEUED',
        event: { type: 'ApprovalReceived', payload: { approvalId: freshApproval!.id } },
      });
      await transitionRun(tx, replacement!.id, {
        expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, replacement!.id, {
        expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' },
      });
    });
    const resumedReplacement = await getRun(db.pool, replacement!.id);
    const recovered = await dispatchTool(
      {
        ...recoveryContext,
        run: resumedReplacement!,
      },
      'external_http_request',
      pendingArgs,
    );
    expect(recovered).toMatchObject({ kind: 'result' });
    expect(httpRequest).toHaveBeenCalledTimes(1);
    const requestHeaders = httpRequest.mock.calls[0]?.[0].headers as Record<string, string>;
    expect(requestHeaders['idempotency-key']).toBe(pendingKey);
    const { rows: recoveredReceipts } = await db.pool.query<{ status: string }>(
      'SELECT status FROM tool_receipts WHERE id = $1',
      [pendingReceipt.id],
    );
    expect(recoveredReceipts[0]?.status).toBe('COMMITTED');

    const foreignTenant = await createTenant(db.pool, { name: 'Foreign reader' });
    const ownerKey = (await createApiKey(db.pool, { tenantId: tenant.id })).plaintext;
    const foreignKey = (await createApiKey(db.pool, { tenantId: foreignTenant.id })).plaintext;
    const app = buildServer({ pool: db.pool, cfg });
    try {
      for (const runId of [parent.id, childId, replacement!.id]) {
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/v1/runs/${runId}`,
              headers: { authorization: `Bearer ${ownerKey}` },
            })
          ).statusCode,
        ).toBe(200);
        for (const key of [foreignKey, 'delegation-test-token']) {
          expect(
            (
              await app.inject({
                method: 'GET',
                url: `/v1/runs/${runId}`,
                headers: { authorization: `Bearer ${key}` },
              })
            ).statusCode,
          ).toBe(404);
        }
      }
      const ownerUsage = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: { authorization: `Bearer ${ownerKey}` },
      });
      expect(ownerUsage.json()).toMatchObject({ tenantId: tenant.id, runs: 3 });
      const foreignUsage = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: { authorization: `Bearer ${foreignKey}` },
      });
      expect(foreignUsage.json()).toMatchObject({ tenantId: foreignTenant.id, runs: 0 });
    } finally {
      await app.close();
      await objectStore.close();
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('rejects a delegated agent version owned by another tenant', async () => {
    const tenant = await createTenant(db.pool, { name: 'Delegating tenant' });
    const otherTenant = await createTenant(db.pool, { name: 'Foreign agent tenant' });
    const parentDefinition = await createAgentDefinition(db.pool, {
      tenantId: tenant.id,
      name: 'tenant-parent-agent',
    });
    const foreignDefinition = await createAgentDefinition(db.pool, {
      tenantId: otherTenant.id,
      name: 'foreign-child-agent',
    });
    const [parentVersion, foreignVersion] = await Promise.all([
      withTransaction(db.pool, (tx) =>
        createAgentVersion(tx, {
          agentId: parentDefinition.id,
          instructions: 'parent',
          modelPolicy: { model: 'none' },
        }),
      ),
      withTransaction(db.pool, (tx) =>
        createAgentVersion(tx, {
          agentId: foreignDefinition.id,
          instructions: 'foreign child',
          modelPolicy: { model: 'none' },
        }),
      ),
    ]);
    const parent = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenant.id,
        agentVersionId: parentVersion.id,
        goal: 'parent objective',
      }),
    );

    await expect(
      withTransaction(db.pool, async (tx) => {
        await transitionRun(tx, parent.id, {
          expectFrom: ['QUEUED'],
          to: 'STARTING',
          event: { type: 'AttemptStarted', payload: { attemptNo: 1 } },
          attemptId: 'att_cross_tenant',
          patch: { current_attempt_id: 'att_cross_tenant' },
        });
        await transitionRun(tx, parent.id, {
          expectFrom: ['STARTING'],
          to: 'RUNNING',
          event: { type: 'AttemptStarted', payload: { phase: 'running' } },
          attemptId: 'att_cross_tenant',
        });
        await spawnChildren(tx, {
          parentRunId: parent.id,
          attemptId: 'att_cross_tenant',
          children: [{ agentVersionId: foreignVersion.id, goal: 'must be rejected' }],
        });
      }),
    ).rejects.toThrow(/does not belong to tenant/);

    const unchangedParent = await getRun(db.pool, parent.id, tenant.id);
    expect(unchangedParent?.status).toBe('QUEUED');
    const { rows: children } = await db.pool.query(
      'SELECT id FROM runs WHERE parent_run_id = $1',
      [parent.id],
    );
    expect(children).toEqual([]);
  });

  it('enforces explicit tenant ownership and same-tenant lineage in the database', async () => {
    const tenantA = await createTenant(db.pool, { name: 'Lineage tenant A' });
    const tenantB = await createTenant(db.pool, { name: 'Lineage tenant B' });
    const definitionA = await createAgentDefinition(db.pool, {
      tenantId: tenantA.id,
      name: 'lineage-agent-a',
    });
    const definitionB = await createAgentDefinition(db.pool, {
      tenantId: tenantB.id,
      name: 'lineage-agent-b',
    });
    const versionA = await withTransaction(db.pool, (tx) =>
      createAgentVersion(tx, {
        agentId: definitionA.id,
        instructions: 'a',
        modelPolicy: { model: 'none' },
      }),
    );
    const versionB = await withTransaction(db.pool, (tx) =>
      createAgentVersion(tx, {
        agentId: definitionB.id,
        instructions: 'b',
        modelPolicy: { model: 'none' },
      }),
    );
    const parent = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenantA.id,
        agentVersionId: versionA.id,
        goal: 'tenant A parent',
      }),
    );

    await expect(
      db.pool.query(
        `INSERT INTO runs (id, agent_version_id, goal, status)
         VALUES ('run_missing_tenant', $1, 'must fail', 'CREATED')`,
        [versionA.id],
      ),
    ).rejects.toThrow(/tenant_id/);

    await expect(
      db.pool.query(
        `INSERT INTO runs (id, tenant_id, agent_version_id, parent_run_id, goal, status)
         VALUES ('run_cross_tenant_child', $1, $2, $3, 'must fail', 'CREATED')`,
        [tenantB.id, versionB.id, parent.id],
      ),
    ).rejects.toThrow(/runs_parent_same_tenant/);
  });
});
