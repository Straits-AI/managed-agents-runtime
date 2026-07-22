import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { createTenant } from '../src/store/tenants.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { withTransaction } from '../src/db/tx.js';
import { appendEvent, transitionRun } from '../src/core/transition.js';
import { RunAdmissionRejectedError } from '../src/store/admissions.js';
import { spawnChildren, wakeReadyParents } from '../src/scheduler/children.js';
import { newId } from '../src/ids.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

async function fixture(
  name: string,
  quota: { maxConcurrentRuns?: number; dailyTokenBudget?: number },
) {
  const tenant = await createTenant(db.pool, { name, quota });
  const agent = await createAgentDefinition(db.pool, {
    tenantId: tenant.id,
    name: `${name}-${tenant.id}`,
  });
  const version = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, {
      agentId: agent.id,
      instructions: 'x',
      modelPolicy: { model: 'none' },
    }),
  );
  return { tenant, version };
}

async function admissionRows(tenantId: string) {
  const { rows } = await db.pool.query<{
    run_id: string;
    kind: string;
    status: string;
    reserved_tokens: string;
  }>(
    `SELECT run_id, kind, status, reserved_tokens
     FROM run_admissions WHERE tenant_id = $1 ORDER BY created_at, run_id`,
    [tenantId],
  );
  return rows;
}

describe('atomic run admission', () => {
  it('admits at most one direct run under a parallel burst and leaks no child rows', async () => {
    const { tenant, version } = await fixture('Burst admission', {
      maxConcurrentRuns: 1,
    });
    const attempts = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        withTransaction(db.pool, (tx) =>
          createRun(tx, {
            tenantId: tenant.id,
            agentVersionId: version.id,
            goal: `burst-${i}`,
            grants: [{ action: 'external.http.request', resource: '*' }],
          }),
        ),
      ),
    );

    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(15);
    expect(
      rejected.every(
        (result) =>
          result.reason instanceof RunAdmissionRejectedError &&
          result.reason.reason === 'concurrency_exhausted',
      ),
    ).toBe(true);

    const counts = await db.pool.query<{
      runs: string;
      workspaces: string;
      grants: string;
      admissions: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM runs WHERE tenant_id = $1) AS runs,
         (SELECT COUNT(*) FROM workspaces w JOIN runs r ON r.id = w.run_id
          WHERE r.tenant_id = $1) AS workspaces,
         (SELECT COUNT(*) FROM capability_grants g JOIN runs r ON r.id = g.run_id
          WHERE r.tenant_id = $1) AS grants,
         (SELECT COUNT(*) FROM run_admissions WHERE tenant_id = $1) AS admissions`,
      [tenant.id],
    );
    expect(counts.rows[0]).toEqual({
      runs: '1',
      workspaces: '1',
      grants: '1',
      admissions: '1',
    });
  });

  it('reserves token capacity atomically and releases it on terminal transition', async () => {
    const { tenant, version } = await fixture('Token capacity', {
      dailyTokenBudget: 100,
    });
    const first = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenant.id,
        agentVersionId: version.id,
        goal: 'reserve 60',
        tokenBudget: 60,
      }),
    );
    await expect(
      withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: tenant.id,
          agentVersionId: version.id,
          goal: 'overflow by one',
          tokenBudget: 41,
          grants: [{ action: 'must-not-leak' }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'token_capacity_exhausted' });
    const second = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenant.id,
        agentVersionId: version.id,
        goal: 'reserve remaining 40',
        tokenBudget: 40,
      }),
    );
    expect((await admissionRows(tenant.id)).map((row) => row.reserved_tokens)).toEqual([
      '60',
      '40',
    ]);

    await withTransaction(db.pool, (tx) =>
      transitionRun(tx, first.id, {
        expectFrom: ['QUEUED'],
        to: 'FAILED',
        event: { type: 'RunFailed' },
        reason: 'test_terminal_release',
      }),
    );
    await expect(
      withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: tenant.id,
          agentVersionId: version.id,
          goal: 'reuse released 60',
          tokenBudget: 60,
        }),
      ),
    ).resolves.toBeTruthy();
    expect(
      (await admissionRows(tenant.id)).find((row) => row.run_id === first.id)?.status,
    ).toBe('released');
    expect(second.status).toBe('QUEUED');
  });

  it('assigns an omitted run budget to remaining daily capacity', async () => {
    const { tenant, version } = await fixture('Implicit token capacity', {
      dailyTokenBudget: 75,
    });
    const run = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenant.id,
        agentVersionId: version.id,
        goal: 'bounded automatically',
      }),
    );
    expect(run.token_budget).toBe('75');
    await expect(
      withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: tenant.id,
          agentVersionId: version.id,
          goal: 'no capacity remains',
        }),
      ),
    ).rejects.toMatchObject({ reason: 'token_capacity_exhausted' });
  });

  it('charges today\'s invocation event even when its run predates UTC midnight', async () => {
    const { tenant, version } = await fixture('Event-time token capacity', {
      dailyTokenBudget: 100,
    });
    const historical = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenant.id,
        agentVersionId: version.id,
        goal: 'run created yesterday, model called today',
        tokenBudget: 100,
      }),
    );
    await db.pool.query(
      `UPDATE runs
       SET created_at = (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                        - interval '1 minute'
       WHERE id = $1`,
      [historical.id],
    );
    await withTransaction(db.pool, async (tx) => {
      await appendEvent(tx, historical.id, {
        type: 'ModelInvocationCompleted',
        payload: { usage: { inputTokens: 40, outputTokens: 20 } },
      }, { patch: { tokens_used: '60' } });
      await transitionRun(tx, historical.id, {
        expectFrom: ['QUEUED'],
        to: 'FAILED',
        event: { type: 'RunFailed' },
        reason: 'fixture_complete',
      });
    });

    await expect(
      withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: tenant.id,
          agentVersionId: version.id,
          goal: 'one token beyond today\'s remaining capacity',
          tokenBudget: 41,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'token_capacity_exhausted' });
    await expect(
      withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: tenant.id,
          agentVersionId: version.id,
          goal: 'exactly today\'s remaining capacity',
          tokenBudget: 40,
        }),
      ),
    ).resolves.toMatchObject({ token_budget: '40' });
  });

  it('serializes token reservations under a parallel burst', async () => {
    const { tenant, version } = await fixture('Token burst', {
      dailyTokenBudget: 100,
    });
    const burst = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        withTransaction(db.pool, (tx) =>
          createRun(tx, {
            tenantId: tenant.id,
            agentVersionId: version.id,
            goal: `token-burst-${i}`,
            tokenBudget: 60,
          }),
        ),
      ),
    );
    expect(burst.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      burst
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .every((result) => result.reason?.reason === 'token_capacity_exhausted'),
    ).toBe(true);
  });

  it('holds scheduled and fork capacity, while retry reuses the same reservation', async () => {
    const { tenant, version } = await fixture('Lifecycle admission', {
      maxConcurrentRuns: 1,
    });
    const source = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenant.id,
        agentVersionId: version.id,
        goal: 'scheduled source',
        scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    await expect(
      withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: tenant.id,
          agentVersionId: version.id,
          goal: 'fork while source active',
          forkedFromRunId: source.id,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'concurrency_exhausted' });

    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, source.id, {
        expectFrom: ['QUEUED'],
        to: 'STARTING',
        event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, source.id, {
        expectFrom: ['STARTING'],
        to: 'RUNNING',
        event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, source.id, {
        expectFrom: ['RUNNING'],
        to: 'QUEUED',
        event: { type: 'RetryScheduled' },
      });
    });
    expect(await admissionRows(tenant.id)).toHaveLength(1);
    await withTransaction(db.pool, (tx) =>
      transitionRun(tx, source.id, {
        expectFrom: ['QUEUED'],
        to: 'FAILED',
        event: { type: 'RunFailed' },
      }),
    );
    const fork = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenant.id,
        agentVersionId: version.id,
        goal: 'fork after release',
        forkedFromRunId: source.id,
      }),
    );
    expect(
      (await admissionRows(tenant.id)).find((row) => row.run_id === fork.id)?.kind,
    ).toBe('fork');
  });

  it('rolls back rejected delegation and admits a replacement in the released child slot', async () => {
    const limited = await fixture('Delegation rejection', { maxConcurrentRuns: 1 });
    const limitedParent = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: limited.tenant.id,
        agentVersionId: limited.version.id,
        goal: 'limited parent',
      }),
    );
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, limitedParent.id, {
        expectFrom: ['QUEUED'],
        to: 'STARTING',
        event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, limitedParent.id, {
        expectFrom: ['STARTING'],
        to: 'RUNNING',
        event: { type: 'AttemptStarted' },
      });
    });
    await expect(
      withTransaction(db.pool, (tx) =>
        spawnChildren(tx, {
          parentRunId: limitedParent.id,
          attemptId: 'att_admission_rejection',
          children: [
            {
              agentVersionId: limited.version.id,
              goal: 'must roll back',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'concurrency_exhausted' });
    const limitedState = await db.pool.query<{ status: string; children: string }>(
      `SELECT p.status,
              (SELECT COUNT(*) FROM runs c WHERE c.parent_run_id = p.id) AS children
       FROM runs p WHERE p.id = $1`,
      [limitedParent.id],
    );
    expect(limitedState.rows[0]).toEqual({ status: 'RUNNING', children: '0' });

    const roomy = await fixture('Replacement admission', { maxConcurrentRuns: 2 });
    const parent = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: roomy.tenant.id,
        agentVersionId: roomy.version.id,
        goal: 'parent',
      }),
    );
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, parent.id, {
        expectFrom: ['QUEUED'],
        to: 'STARTING',
        event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, parent.id, {
        expectFrom: ['STARTING'],
        to: 'RUNNING',
        event: { type: 'AttemptStarted' },
      });
    });
    const [childId] = await withTransaction(db.pool, (tx) =>
      spawnChildren(tx, {
        parentRunId: parent.id,
        attemptId: 'att_replacement',
        children: [{ agentVersionId: roomy.version.id, goal: 'child' }],
      }),
    );
    await withTransaction(db.pool, (tx) =>
      transitionRun(tx, childId!, {
        expectFrom: ['QUEUED'],
        to: 'FAILED',
        event: { type: 'RunFailed' },
      }),
    );
    const wake = await wakeReadyParents(db.pool, 1);
    expect(wake.replaced).toHaveLength(1);
    expect(
      (await admissionRows(roomy.tenant.id)).find(
        (row) => row.run_id === wake.replaced[0],
      )?.kind,
    ).toBe('replacement');
  });

  it('rolls back admission when agent ownership validation fails', async () => {
    const owner = await fixture('Agent owner', {});
    const attacker = await fixture('Wrong tenant admission', {});
    await expect(
      withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: attacker.tenant.id,
          agentVersionId: owner.version.id,
          goal: 'must fail after capacity check',
        }),
      ),
    ).rejects.toThrow(/does not belong/);
    expect(await admissionRows(attacker.tenant.id)).toEqual([]);
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM runs WHERE tenant_id = $1`,
      [attacker.tenant.id],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('isolates a suspended tenant replacement rejection from other parent wake-ups', async () => {
    async function waitingParent(
      label: string,
      childStatus: 'COMPLETED' | 'FAILED',
    ) {
      const scoped = await fixture(label, { maxConcurrentRuns: 2 });
      const parent = await withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: scoped.tenant.id,
          agentVersionId: scoped.version.id,
          goal: `${label} parent`,
        }),
      );
      await withTransaction(db.pool, async (tx) => {
        await transitionRun(tx, parent.id, {
          expectFrom: ['QUEUED'],
          to: 'STARTING',
          event: { type: 'AttemptStarted' },
        });
        await transitionRun(tx, parent.id, {
          expectFrom: ['STARTING'],
          to: 'RUNNING',
          event: { type: 'AttemptStarted' },
        });
      });
      const [childId] = await withTransaction(db.pool, (tx) =>
        spawnChildren(tx, {
          parentRunId: parent.id,
          attemptId: `att_${label}`,
          children: [
            {
              agentVersionId: scoped.version.id,
              goal: `${label} child`,
            },
          ],
        }),
      );
      await withTransaction(db.pool, async (tx) => {
        if (childStatus === 'FAILED') {
          await transitionRun(tx, childId!, {
            expectFrom: ['QUEUED'],
            to: 'FAILED',
            event: { type: 'RunFailed' },
          });
          return;
        }
        await transitionRun(tx, childId!, {
          expectFrom: ['QUEUED'],
          to: 'STARTING',
          event: { type: 'AttemptStarted' },
        });
        await transitionRun(tx, childId!, {
          expectFrom: ['STARTING'],
          to: 'RUNNING',
          event: { type: 'AttemptStarted' },
        });
        await transitionRun(tx, childId!, {
          expectFrom: ['RUNNING'],
          to: 'VERIFYING',
          event: { type: 'VerificationStarted' },
        });
        await transitionRun(tx, childId!, {
          expectFrom: ['VERIFYING'],
          to: 'COMPLETED',
          event: { type: 'RunCompleted' },
        });
      });
      return { ...scoped, parent };
    }

    const suspended = await waitingParent('Suspended replacement', 'FAILED');
    const healthy = await waitingParent('Healthy wake', 'COMPLETED');
    await db.pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [
      suspended.tenant.id,
    ]);

    const result = await wakeReadyParents(db.pool, 1);
    expect(result.woken).toContain(healthy.parent.id);
    expect(result.replaced).toEqual([]);
    const { rows } = await db.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM runs WHERE id = ANY($1::text[]) ORDER BY id`,
      [[suspended.parent.id, healthy.parent.id]],
    );
    expect(rows.find((row) => row.id === suspended.parent.id)?.status).toBe(
      'WAITING_CHILDREN',
    );
    expect(rows.find((row) => row.id === healthy.parent.id)?.status).toBe('QUEUED');
  });

  it('reserves only the failed child remaining token budget for its replacement', async () => {
    const scoped = await fixture('Replacement remaining budget', {
      maxConcurrentRuns: 2,
      dailyTokenBudget: 100,
    });
    const parent = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: scoped.tenant.id,
        agentVersionId: scoped.version.id,
        goal: 'parent with bounded share',
        tokenBudget: 20,
      }),
    );
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, parent.id, {
        expectFrom: ['QUEUED'],
        to: 'STARTING',
        event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, parent.id, {
        expectFrom: ['STARTING'],
        to: 'RUNNING',
        event: { type: 'AttemptStarted' },
      });
    });
    const [childId] = await withTransaction(db.pool, (tx) =>
      spawnChildren(tx, {
        parentRunId: parent.id,
        attemptId: 'att_partial_child',
        children: [
          {
            agentVersionId: scoped.version.id,
            goal: 'partially consumed child',
            tokenBudget: 80,
          },
        ],
      }),
    );
    await withTransaction(db.pool, async (tx) => {
      await appendEvent(
        tx,
        childId!,
        {
          type: 'ModelInvocationCompleted',
          payload: { usage: { inputTokens: 30, outputTokens: 0 } },
        },
        { patch: { tokens_used: '30' } },
      );
      await transitionRun(tx, childId!, {
        expectFrom: ['QUEUED'],
        to: 'FAILED',
        event: { type: 'RunFailed' },
      });
    });

    const result = await wakeReadyParents(db.pool, 1);
    expect(result.replaced).toHaveLength(1);
    const { rows } = await db.pool.query<{
      token_budget: string;
      reserved_tokens: string;
    }>(
      `SELECT r.token_budget, a.reserved_tokens
       FROM runs r JOIN run_admissions a ON a.run_id = r.id
       WHERE r.id = $1`,
      [result.replaced[0]],
    );
    expect(rows[0]).toEqual({ token_budget: '50', reserved_tokens: '50' });
  });

  it('reconciles a stale active reservation whose run is already terminal', async () => {
    const { tenant, version } = await fixture('Admission reconciliation', {
      maxConcurrentRuns: 1,
    });
    const stale = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenant.id,
        agentVersionId: version.id,
        goal: 'stale reservation',
      }),
    );
    // Simulate operational drift from an older writer. Normal terminal changes
    // use transitionRun and release atomically.
    await db.pool.query(`UPDATE runs SET status = 'FAILED' WHERE id = $1`, [stale.id]);
    await expect(
      withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: tenant.id,
          agentVersionId: version.id,
          goal: 'admitted after reconciliation',
        }),
      ),
    ).resolves.toBeTruthy();
    const staleAdmission = (await admissionRows(tenant.id)).find(
      (row) => row.run_id === stale.id,
    );
    expect(staleAdmission?.status).toBe('released');
  });

  it('rotates more than one candidate window of rejected parents so a healthy tenant wakes', async () => {
    const blocked = await fixture('Blocked replacement window', {});
    const healthy = await fixture('Healthy after blocked window', {});
    const blockedParents = Array.from({ length: 33 }, () => newId('run'));
    const blockedChildren = Array.from({ length: 33 }, () => newId('run'));
    const healthyParent = newId('run');
    const healthyChild = newId('run');

    await withTransaction(db.pool, async (tx) => {
      await tx.query(
        `INSERT INTO runs
           (id, tenant_id, agent_version_id, goal, status, updated_at)
         SELECT p.id, $2, $3, 'blocked parent', 'WAITING_CHILDREN',
                '2020-01-01T00:00:00Z'::timestamptz
         FROM unnest($1::text[]) WITH ORDINALITY AS p(id, n)`,
        [blockedParents, blocked.tenant.id, blocked.version.id],
      );
      await tx.query(
        `INSERT INTO run_admissions (run_id, tenant_id, kind, reserved_tokens)
         SELECT u.id, $2, 'direct', 0 FROM unnest($1::text[]) AS u(id)`,
        [blockedParents, blocked.tenant.id],
      );
    });
    await db.pool.query(
      `INSERT INTO runs
         (id, tenant_id, agent_version_id, parent_run_id, goal, status, updated_at)
       SELECT c.id, $3, $4, p.id, 'failed child', 'FAILED',
              '2020-01-01T00:00:01Z'::timestamptz
       FROM unnest($1::text[]) WITH ORDINALITY AS c(id, n)
       JOIN unnest($2::text[]) WITH ORDINALITY AS p(id, n) USING (n)`,
      [blockedChildren, blockedParents, blocked.tenant.id, blocked.version.id],
    );
    await withTransaction(db.pool, async (tx) => {
      await tx.query(
        `INSERT INTO runs
           (id, tenant_id, agent_version_id, goal, status, updated_at)
         VALUES ($1, $2, $3, 'healthy parent', 'WAITING_CHILDREN',
                 '2021-01-01T00:00:00Z')`,
        [healthyParent, healthy.tenant.id, healthy.version.id],
      );
      await tx.query(
        `INSERT INTO run_admissions (run_id, tenant_id, kind, reserved_tokens)
         VALUES ($1, $2, 'direct', 0)`,
        [healthyParent, healthy.tenant.id],
      );
    });
    await db.pool.query(
      `INSERT INTO runs
         (id, tenant_id, agent_version_id, parent_run_id, goal, status, updated_at)
       VALUES ($1, $2, $3, $4, 'healthy child', 'COMPLETED',
               '2021-01-01T00:00:01Z')`,
      [healthyChild, healthy.tenant.id, healthy.version.id, healthyParent],
    );
    await db.pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [
      blocked.tenant.id,
    ]);

    expect(await wakeReadyParents(db.pool, 1)).toEqual({ woken: [], replaced: [] });
    const second = await wakeReadyParents(db.pool, 1);
    expect(second.woken).toEqual([healthyParent]);
    expect(await wakeReadyParents(db.pool, 1)).toEqual({ woken: [], replaced: [] });
    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM run_events e
       JOIN runs r ON r.id = e.run_id
       WHERE r.tenant_id = $1 AND e.type = 'ChildReplacementDeferred'`,
      [blocked.tenant.id],
    );
    expect(rows[0]?.count).toBe('33');
    const { rows: outboxRows } = await db.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM outbox o
       JOIN runs r ON r.id = o.key
       WHERE r.tenant_id = $1
         AND o.topic = 'run_events'
         AND o.payload->>'type' = 'ChildReplacementDeferred'`,
      [blocked.tenant.id],
    );
    expect(outboxRows[0]?.count).toBe('33');
  });

  it('lets concurrent wake workers resolve different tenant parents without deadlock', async () => {
    await db.pool.query(
      `UPDATE runs SET status = 'CANCELLED' WHERE status = 'WAITING_CHILDREN'`,
    );
    const tenantA = await fixture('Concurrent wake A', {});
    const tenantB = await fixture('Concurrent wake B', {});
    const parentA = newId('run');
    const parentB = newId('run');
    const childA = newId('run');
    const childB = newId('run');
    await withTransaction(db.pool, async (tx) => {
      await tx.query(
        `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
         VALUES ($1, $2, $3, 'parent-a', 'WAITING_CHILDREN'),
                ($4, $5, $6, 'parent-b', 'WAITING_CHILDREN')`,
        [
          parentA,
          tenantA.tenant.id,
          tenantA.version.id,
          parentB,
          tenantB.tenant.id,
          tenantB.version.id,
        ],
      );
      await tx.query(
        `INSERT INTO run_admissions (run_id, tenant_id, kind, reserved_tokens)
         VALUES ($1, $2, 'direct', 0), ($3, $4, 'direct', 0)`,
        [parentA, tenantA.tenant.id, parentB, tenantB.tenant.id],
      );
    });
    await db.pool.query(
      `INSERT INTO runs
         (id, tenant_id, agent_version_id, parent_run_id, goal, status)
       VALUES ($1, $2, $3, $4, 'child-a', 'COMPLETED'),
              ($5, $6, $7, $8, 'child-b', 'COMPLETED')`,
      [
        childA,
        tenantA.tenant.id,
        tenantA.version.id,
        parentA,
        childB,
        tenantB.tenant.id,
        tenantB.version.id,
        parentB,
      ],
    );

    const outcomes = await Promise.all([
      wakeReadyParents(db.pool, 0),
      wakeReadyParents(db.pool, 0),
    ]);
    expect(outcomes.flatMap((outcome) => outcome.woken).sort()).toEqual(
      [parentA, parentB].sort(),
    );
  });
});
