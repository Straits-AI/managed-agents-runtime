import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { spawnWorker, waitFor, type SpawnedWorker } from './helpers/worker.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { listEvents } from '../src/store/events.js';
import { listAttempts } from '../src/store/attempts.js';
import { latestCheckpoint } from '../src/store/checkpoints.js';
import type { ScriptOp } from '../src/harness/scriptedEpoch.js';

let db: TestDb;
let agentVersionId: string;
const workers: SpawnedWorker[] = [];

beforeAll(async () => {
  db = await createTestDb();
  const def = await createAgentDefinition(db.pool, { name: 'sched-agent' });
  const ver = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, {
      agentId: def.id,
      instructions: 'scripted',
      modelPolicy: { model: 'none' },
    }),
  );
  agentVersionId = ver.id;
}, 60_000);

afterEach(async () => {
  while (workers.length > 0) await workers.pop()!.stop();
});

afterAll(async () => {
  await db.drop();
});

function newWorker(env: Record<string, string> = {}): SpawnedWorker {
  const w = spawnWorker(db.url, env);
  workers.push(w);
  return w;
}

async function newRun(script: ScriptOp[]) {
  return withTransaction(db.pool, (tx) =>
    createRun(tx, { agentVersionId, goal: 'scripted run', input: { script } }),
  );
}

describe('scheduler + worker', () => {
  it('claims a queued run and completes a scripted epoch', async () => {
    const run = await newRun([
      { op: 'progress', note: 'did the thing' },
      { op: 'checkpoint' },
      { op: 'complete' },
    ]);
    newWorker();

    const done = await waitFor(
      async () => {
        const r = await getRun(db.pool, run.id);
        return r?.status === 'COMPLETED' ? r : null;
      },
      { label: 'run COMPLETED' },
    );
    expect(done.status).toBe('COMPLETED');

    const types = (await listEvents(db.pool, run.id)).map((e) => e.type);
    expect(types).toContain('AttemptStarted');
    expect(types).toContain('ProgressUpdated');
    expect(types).toContain('WorkspaceCheckpointed');
    expect(types).toContain('VerificationStarted');
    expect(types[types.length - 1]).toBe('RunCompleted');

    const attempts = await listAttempts(db.pool, run.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe('EXITED');
    expect(attempts[0]!.exit_reason).toBe('completed');
  });

  it('recovers when the worker is SIGKILLed mid-run (benchmark steps 4-5)', async () => {
    const run = await newRun([
      { op: 'progress', note: 'phase 1 work' },
      { op: 'checkpoint' },
      { op: 'sleep', ms: 5_000 }, // killed during this step
      { op: 'complete' },
    ]);

    const w1 = newWorker();
    // Wait until attempt 1 has checkpointed, then crash the worker.
    await waitFor(
      async () => {
        const c = await latestCheckpoint(db.pool, run.id);
        return c && c.agent_state.step === 2 ? c : null;
      },
      { label: 'first checkpoint' },
    );
    w1.kill();

    // A second worker reaps the orphaned lease and resumes from checkpoint.
    newWorker({ LEASE_TTL_MS: '1200' });

    const done = await waitFor(
      async () => {
        const r = await getRun(db.pool, run.id);
        if (r?.status === 'FAILED') throw new Error(`run failed: ${r.status_reason}`);
        return r?.status === 'COMPLETED' ? r : null;
      },
      { timeoutMs: 45_000, label: 'recovered run COMPLETED' },
    );
    expect(done.status).toBe('COMPLETED');

    const attempts = await listAttempts(db.pool, run.id);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0]!.state).toBe('ORPHANED');
    expect(attempts[0]!.exit_reason).toBe('lease_expired');
    expect(attempts.at(-1)!.state).toBe('EXITED');
    expect(attempts.at(-1)!.exit_reason).toBe('completed');

    const events = await listEvents(db.pool, run.id);
    const types = events.map((e) => e.type);
    expect(types).toContain('AttemptOrphaned');
    // 'phase 1 work' progress ran once: resume started past the checkpoint.
    expect(types.filter((t) => t === 'ProgressUpdated')).toHaveLength(1);
    // Event sequence stays gapless across the crash.
    expect(events.map((e) => Number(e.seq))).toEqual(
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
  }, 120_000);

  it('retries an erroring epoch and fails after MAX_ATTEMPTS', async () => {
    const run = await newRun([{ op: 'fail' }]);
    newWorker({ MAX_ATTEMPTS: '2' });

    const done = await waitFor(
      async () => {
        const r = await getRun(db.pool, run.id);
        return r?.status === 'FAILED' ? r : null;
      },
      { timeoutMs: 30_000, label: 'run FAILED after retries' },
    );
    expect(done.status_reason).toBe('max_attempts_exhausted');
    const attempts = await listAttempts(db.pool, run.id);
    expect(attempts).toHaveLength(2);
  }, 60_000);

  it('recovers from a transient error via RetryScheduled (fail once)', async () => {
    const run = await newRun([
      { op: 'fail', once: true },
      { op: 'complete' },
    ]);
    newWorker();

    const done = await waitFor(
      async () => {
        const r = await getRun(db.pool, run.id);
        return r?.status === 'COMPLETED' ? r : null;
      },
      { timeoutMs: 30_000, label: 'run COMPLETED after one retry' },
    );
    expect(done.status).toBe('COMPLETED');
    const types = (await listEvents(db.pool, run.id)).map((e) => e.type);
    expect(types).toContain('RetryScheduled');
  }, 60_000);
});
