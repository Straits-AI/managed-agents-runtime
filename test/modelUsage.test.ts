import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { withTransaction } from '../src/db/tx.js';
import { completeModelInvocation } from '../src/store/modelUsage.js';
import { newId } from '../src/ids.js';
import { listEvents } from '../src/store/events.js';
import { transitionRun } from '../src/core/transition.js';
import { MODEL_INVOCATION_LOCK_SEED } from '../src/core/locks.js';
import { waitFor } from './helpers/worker.js';
import { reapExpiredLeases } from '../src/scheduler/reaper.js';
import { settleAttempt } from '../src/harness/worker.js';
import { loadConfig } from '../src/config.js';
import type { RunAttemptRow } from '../src/core/types.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

describe('model usage fencing', () => {
  it('atomically accumulates stale and replacement-attempt completions', async () => {
    const agent = await createAgentDefinition(db.pool, { name: 'usage-fence' });
    const version = await withTransaction(db.pool, (tx) =>
      createAgentVersion(tx, {
        agentId: agent.id,
        instructions: 'test usage',
        modelPolicy: { model: 'test' },
      }),
    );
    const run = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: 'default',
        agentVersionId: version.id,
        goal: 'account for overlapping completions',
        tokenBudget: 1_000,
      }),
    );
    const staleAttempt = newId('att');
    const replacementAttempt = newId('att');
    await db.pool.query(
      `INSERT INTO run_attempts
         (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $3, 1, 'old', 'ORPHANED', now()),
              ($2, $3, 2, 'new', 'ACTIVE', now() + interval '1 minute')`,
      [staleAttempt, replacementAttempt, run.id],
    );
    await db.pool.query(
      `UPDATE runs SET status = 'RUNNING', current_attempt_id = $2 WHERE id = $1`,
      [run.id, replacementAttempt],
    );

    const [oldResult, newResult] = await Promise.all([
      withTransaction(db.pool, (tx) =>
        completeModelInvocation(tx, {
          runId: run.id,
          attemptId: staleAttempt,
          step: 1,
          usage: { inputTokens: 40, outputTokens: 10 },
        }),
      ),
      withTransaction(db.pool, (tx) =>
        completeModelInvocation(tx, {
          runId: run.id,
          attemptId: replacementAttempt,
          step: 1,
          usage: { inputTokens: 30, outputTokens: 20 },
        }),
      ),
    ]);

    expect([oldResult.stillOwned, newResult.stillOwned].sort()).toEqual([false, true]);
    expect((await getRun(db.pool, run.id))?.tokens_used).toBe('100');
    expect(
      (await listEvents(db.pool, run.id)).filter(
        (event) => event.type === 'ModelInvocationCompleted',
      ),
    ).toHaveLength(2);
  });

  it('does not release admission while a provider invocation lock is held', async () => {
    const agent = await createAgentDefinition(db.pool, { name: 'usage-release-fence' });
    const version = await withTransaction(db.pool, (tx) =>
      createAgentVersion(tx, {
        agentId: agent.id,
        instructions: 'test release fencing',
        modelPolicy: { model: 'test' },
      }),
    );
    const run = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: 'default',
        agentVersionId: version.id,
        goal: 'wait for metering before release',
        tokenBudget: 100,
      }),
    );
    const invocationClient = await db.pool.connect();
    await invocationClient.query(
      'SELECT pg_advisory_lock(hashtextextended($1, $2))',
      [run.id, MODEL_INVOCATION_LOCK_SEED],
    );
    try {
      const terminal = withTransaction(db.pool, (tx) =>
        transitionRun(tx, run.id, {
          expectFrom: ['QUEUED'],
          to: 'FAILED',
          event: { type: 'RunFailed', payload: { reason: 'test' } },
          reason: 'test',
        }),
      );
      await waitFor(
        async () => {
          const { rows } = await db.pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database()
                 AND wait_event_type = 'Lock'
                 AND lower(wait_event) = 'advisory'
             ) AS waiting`,
          );
          return rows[0]?.waiting ? true : null;
        },
        { label: 'terminal transition waiting on invocation lock' },
      );
      const { rows: held } = await db.pool.query<{ status: string }>(
        'SELECT status FROM run_admissions WHERE run_id = $1',
        [run.id],
      );
      expect(held[0]?.status).toBe('active');

      await invocationClient.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, $2))',
        [run.id, MODEL_INVOCATION_LOCK_SEED],
      );
      await terminal;
      const { rows: released } = await db.pool.query<{ status: string }>(
        'SELECT status FROM run_admissions WHERE run_id = $1',
        [run.id],
      );
      expect(released[0]?.status).toBe('released');
    } finally {
      await invocationClient
        .query('SELECT pg_advisory_unlock_all()')
        .catch(() => {});
      invocationClient.release();
    }
  });

  it('reaps a later expired run while the oldest invocation is still locked', async () => {
    const agent = await createAgentDefinition(db.pool, { name: 'usage-reaper-fence' });
    const version = await withTransaction(db.pool, (tx) =>
      createAgentVersion(tx, {
        agentId: agent.id,
        instructions: 'test reaper fencing',
        modelPolicy: { model: 'test' },
      }),
    );
    const [oldest, later] = await Promise.all([
      withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: 'default',
          agentVersionId: version.id,
          goal: 'oldest locked',
          tokenBudget: 100,
        }),
      ),
      withTransaction(db.pool, (tx) =>
        createRun(tx, {
          tenantId: 'default',
          agentVersionId: version.id,
          goal: 'later reapable',
          tokenBudget: 100,
        }),
      ),
    ]);
    const oldestAttempt = newId('att');
    const laterAttempt = newId('att');
    await db.pool.query(
      `INSERT INTO run_attempts
         (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'oldest', 'ACTIVE', now() - interval '2 minutes'),
              ($3, $4, 1, 'later', 'ACTIVE', now() - interval '1 minute')`,
      [oldestAttempt, oldest.id, laterAttempt, later.id],
    );
    await db.pool.query(
      `UPDATE runs SET status = 'RUNNING', current_attempt_id = CASE id
         WHEN $1 THEN $2 WHEN $3 THEN $4 END
       WHERE id IN ($1, $3)`,
      [oldest.id, oldestAttempt, later.id, laterAttempt],
    );

    const invocationClient = await db.pool.connect();
    await invocationClient.query(
      'SELECT pg_advisory_lock(hashtextextended($1, $2))',
      [oldest.id, MODEL_INVOCATION_LOCK_SEED],
    );
    try {
      const reaped = await reapExpiredLeases(db.pool, 5);
      expect(reaped.map((entry) => entry.attempt.id)).toEqual([laterAttempt]);
      expect((await getRun(db.pool, oldest.id))?.status).toBe('RUNNING');
      expect((await getRun(db.pool, later.id))?.status).toBe('QUEUED');
    } finally {
      await invocationClient.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, $2))',
        [oldest.id, MODEL_INVOCATION_LOCK_SEED],
      );
      invocationClient.release();
    }
  });

  it('settlement waits on the invocation fence before locking the attempt', async () => {
    const agent = await createAgentDefinition(db.pool, { name: 'usage-settlement-order' });
    const version = await withTransaction(db.pool, (tx) =>
      createAgentVersion(tx, {
        agentId: agent.id,
        instructions: 'test settlement ordering',
        modelPolicy: { model: 'test' },
      }),
    );
    const run = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: 'default',
        agentVersionId: version.id,
        goal: 'settle without inversion',
        tokenBudget: 100,
      }),
    );
    const attemptId = newId('att');
    const { rows } = await db.pool.query<RunAttemptRow>(
      `INSERT INTO run_attempts
         (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'settler', 'ACTIVE', now() - interval '1 minute')
       RETURNING *`,
      [attemptId, run.id],
    );
    await db.pool.query(
      `UPDATE runs SET status = 'RUNNING', current_attempt_id = $2 WHERE id = $1`,
      [run.id, attemptId],
    );
    const lockOwner = await db.pool.connect();
    const attemptLocker = await db.pool.connect();
    await lockOwner.query(
      'SELECT pg_advisory_lock(hashtextextended($1, $2))',
      [run.id, MODEL_INVOCATION_LOCK_SEED],
    );
    try {
      const settling = settleAttempt(
        db.pool,
        loadConfig({ ...process.env, DATABASE_URL: db.url }),
        run.id,
        rows[0]!,
        'budget_exhausted',
      );
      await waitFor(
        async () => {
          const { rows: activity } = await db.pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database()
                 AND wait_event_type = 'Lock'
                 AND lower(wait_event) = 'advisory'
             ) AS waiting`,
          );
          return activity[0]?.waiting ? true : null;
        },
        { label: 'settlement waiting before attempt lock' },
      );
      await attemptLocker.query('BEGIN');
      await expect(
        attemptLocker.query('SELECT id FROM run_attempts WHERE id = $1 FOR UPDATE NOWAIT', [
          attemptId,
        ]),
      ).resolves.toBeDefined();

      await lockOwner.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, $2))',
        [run.id, MODEL_INVOCATION_LOCK_SEED],
      );
      await attemptLocker.query('COMMIT');
      await settling;
      expect((await getRun(db.pool, run.id))?.status).toBe('FAILED');
    } finally {
      await attemptLocker.query('ROLLBACK').catch(() => {});
      attemptLocker.release();
      await lockOwner.query('SELECT pg_advisory_unlock_all()').catch(() => {});
      lockOwner.release();
    }
  });
});
