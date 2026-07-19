import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createTenant } from '../src/store/tenants.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { transitionRun } from '../src/core/transition.js';
import { spawnChildren, wakeReadyParents } from '../src/scheduler/children.js';
import { listGrants } from '../src/store/grants.js';
import { tenantUsage } from '../src/store/usage.js';

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
            tokenBudget: 4_000,
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
      token_budget: '4000',
    });
    expect(child!.workspace_id).not.toBe(parent.workspace_id);
    expect(await getRun(db.pool, childId, 'default')).toBeNull();
    const workspaceSeed = await getRun(
      db.pool,
      child!.parent_run_id!,
      child!.tenant_id,
    );
    expect(workspaceSeed?.workspace_id).toBe(parent.workspace_id);

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

    await withTransaction(db.pool, (tx) =>
      transitionRun(tx, childId, {
        expectFrom: ['QUEUED'],
        to: 'FAILED',
        event: { type: 'RunFailed', payload: { reason: 'test failure' } },
        reason: 'test failure',
      }),
    );

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
      token_budget: '4000',
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
      max_calls: 2,
      calls_used: 0,
      expires_at: grantExpiry,
    });

    const usage = await tenantUsage(
      db.pool,
      tenant.id,
      { inputPerMTok: 0, outputPerMTok: 0 },
      new Date(0).toISOString(),
    );
    expect(usage.runs).toBe(3);
    const defaultUsage = await tenantUsage(
      db.pool,
      'default',
      { inputPerMTok: 0, outputPerMTok: 0 },
      new Date(0).toISOString(),
    );
    expect(defaultUsage.runs).toBe(0);
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
