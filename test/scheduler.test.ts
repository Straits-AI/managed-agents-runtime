import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { spawnWorker, waitFor, type SpawnedWorker } from './helpers/worker.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { appendEvent, transitionRun } from '../src/core/transition.js';
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

async function newRun(script: ScriptOp[], extra: { tokenBudget?: number; maxSteps?: number } = {}) {
  return withTransaction(db.pool, (tx) =>
    createRun(tx, { agentVersionId, goal: 'scripted run', input: { script }, ...extra }),
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

    // The run reaches COMPLETED inside the epoch's transaction; the attempt row
    // is marked EXITED a moment later in settleAttempt (a separate transaction).
    // Wait for that bookkeeping to settle before asserting on it.
    const attempts = await waitFor(
      async () => {
        const a = await listAttempts(db.pool, run.id);
        return a.length === 1 && a[0]!.state === 'EXITED' ? a : null;
      },
      { label: 'attempt EXITED (bookkeeping settled)' },
    );
    expect(attempts[0]!.exit_reason).toBe('completed');
  });

  it('fails gracefully with budget_exhausted instead of running when over token budget', async () => {
    // A script that WOULD complete, but the run is already over its token
    // budget — so the epoch must stop before doing any work.
    const run = await newRun(
      [
        { op: 'progress', note: 'should never run' },
        { op: 'complete' },
      ],
      { tokenBudget: 1000 },
    );
    await db.pool.query('UPDATE runs SET tokens_used = 5000 WHERE id = $1', [run.id]);
    newWorker();

    const failed = await waitFor(
      async () => {
        const r = await getRun(db.pool, run.id);
        return r?.status === 'FAILED' ? r : null;
      },
      { label: 'run FAILED (budget)' },
    );
    expect(failed.status).toBe('FAILED');
    expect(failed.status_reason).toBe('budget_exhausted');

    // It must have stopped before executing the script.
    const types = (await listEvents(db.pool, run.id)).map((e) => e.type);
    expect(types).not.toContain('ProgressUpdated');
    expect(types).not.toContain('RunCompleted');

    const attempts = await listAttempts(db.pool, run.id);
    expect(attempts[attempts.length - 1]!.exit_reason).toBe('budget_exhausted');
  });

  it('suspends on wait_for_signal and resumes when the signal is delivered', async () => {
    const run = await newRun([
      { op: 'progress', note: 'before wait' },
      { op: 'waitSignal', name: 'payment_settled' },
      { op: 'progress', note: 'after signal' },
      { op: 'complete' },
    ]);
    newWorker();

    // It parks in WAITING_SIGNAL and releases compute. The run transitions to
    // WAITING_SIGNAL inside the epoch, but the attempt row flips ACTIVE→EXITED a
    // moment later in settleAttempt — so poll until that bookkeeping settles
    // (zero ACTIVE attempts) rather than racing it.
    const waiting = await waitFor(
      async () => {
        const r = await getRun(db.pool, run.id);
        if (r?.status !== 'WAITING_SIGNAL') return null;
        const active = (await listAttempts(db.pool, run.id)).filter((a) => a.state === 'ACTIVE');
        return active.length === 0 ? r : null;
      },
      { label: 'WAITING_SIGNAL with zero compute' },
    );
    expect(waiting.awaited_signal).toBe('payment_settled');

    // Deliver the signal exactly as the API endpoint does: record + wake.
    await withTransaction(db.pool, async (tx) => {
      await appendEvent(tx, run.id, {
        type: 'SignalReceived',
        payload: { name: 'payment_settled', payload: { txn: 'T-9' } },
      });
      await transitionRun(tx, run.id, {
        expectFrom: ['WAITING_SIGNAL'],
        to: 'QUEUED',
        event: { type: 'SignalReceived', payload: { name: 'payment_settled', woke: true } },
        patch: { current_attempt_id: null, awaited_signal: null },
      });
    });

    const done = await waitFor(
      async () => {
        const r = await getRun(db.pool, run.id);
        return r?.status === 'COMPLETED' ? r : null;
      },
      { label: 'COMPLETED after signal' },
    );
    expect(done.status).toBe('COMPLETED');
    const types = (await listEvents(db.pool, run.id)).map((e) => e.type);
    expect(types).toContain('SignalReceived');
    expect(types[types.length - 1]).toBe('RunCompleted');
  });

  it('does not claim a scheduled run until its start time', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const run = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        agentVersionId,
        goal: 'scheduled',
        input: { script: [{ op: 'complete' }] as ScriptOp[] },
        scheduledFor: future,
      }),
    );
    newWorker();

    // Give the worker time to poll a few times; it must stay QUEUED.
    await new Promise((r) => setTimeout(r, 3000));
    const stillQueued = await getRun(db.pool, run.id);
    expect(stillQueued!.status).toBe('QUEUED');
    expect(await listAttempts(db.pool, run.id)).toHaveLength(0);

    // Move the schedule into the past; now it becomes claimable.
    await db.pool.query(`UPDATE runs SET scheduled_for = now() - interval '1 minute' WHERE id = $1`, [run.id]);
    const done = await waitFor(
      async () => {
        const r = await getRun(db.pool, run.id);
        return r?.status === 'COMPLETED' ? r : null;
      },
      { label: 'scheduled run COMPLETED' },
    );
    expect(done.status).toBe('COMPLETED');
  });

  it('delegates child runs, waits with zero compute, resumes when children finish', async () => {
    const parent = await newRun([
      { op: 'progress', note: 'planning' },
      { op: 'delegate', goals: ['subtask A', 'subtask B'] },
      { op: 'progress', note: 'merging child results' },
      { op: 'complete' },
    ]);
    // This is the happy-path delegation test — disable subagent replacement so a
    // child that transiently fails under CPU load can't add a replacement run
    // and perturb the exact child count. Replacement has its own tests below.
    newWorker({ MAX_CHILD_REPLACEMENTS: '0' });

    // The parent suspends to WAITING_CHILDREN, its children run, and it resumes
    // to COMPLETED. With scripted no-op children a single worker does the whole
    // dance (park → run 2 children → wake → finish) in well under one poll
    // interval, so WAITING_CHILDREN is a fleeting state a status poll routinely
    // misses. Assert the DURABLE record — event ledger + attempt exit reasons —
    // which permanently proves the suspend→resume cycle, instead of racing the
    // live status.
    const done = await waitFor(
      async () => {
        const r = await getRun(db.pool, parent.id);
        return r?.status === 'COMPLETED' ? r : null;
      },
      { label: 'parent COMPLETED after children', timeoutMs: 30_000 },
    );
    expect(done.status).toBe('COMPLETED');

    // Two children were spawned and each completed.
    const { rows: kids } = await db.pool.query<{ id: string; parent_run_id: string }>(
      `SELECT id, parent_run_id FROM runs WHERE parent_run_id = $1`,
      [parent.id],
    );
    expect(kids).toHaveLength(2);
    for (const k of kids) {
      const child = await getRun(db.pool, k.id);
      expect(child!.status).toBe('COMPLETED');
    }

    // Durable proof of "zero compute while children run": the parent's first
    // attempt EXITED with 'suspended_for_children' (it released its worker at the
    // suspend rather than holding a running attempt through the children), and a
    // distinct later attempt completed the resume.
    const attempts = await listAttempts(db.pool, parent.id);
    const suspended = attempts.find((a) => a.exit_reason === 'suspended_for_children');
    expect(suspended?.state).toBe('EXITED');
    expect(attempts.at(-1)!.exit_reason).toBe('completed');
    expect(attempts.at(-1)!.id).not.toBe(suspended!.id);
    const types = (await listEvents(db.pool, parent.id)).map((e) => e.type);
    expect(types).toContain('ChildRunSpawned');
    expect(types).toContain('ChildrenResolved');
    // Suspend precedes resume in the ledger — the parent waited, then woke.
    expect(types.indexOf('ChildRunSpawned')).toBeLessThan(types.indexOf('ChildrenResolved'));
    expect(types[types.length - 1]).toBe('RunCompleted');
  }, 60_000); // heaviest test: worker boot + 4 sequential claim/epoch cycles (parent, 2 children, resume)

  it('replaces a failed delegated child, then resumes the parent once replacements are exhausted', async () => {
    const parent = await newRun([
      { op: 'progress', note: 'planning' },
      { op: 'delegate', goals: ['flaky subtask'], childScript: [{ op: 'fail' }] },
      { op: 'progress', note: 'merging' },
      { op: 'complete' },
    ]);
    // The child always fails; allow one replacement. MAX_ATTEMPTS=1 fails each
    // child on its first attempt (no in-run retry), so the failure is the
    // subagent's, and replacement — not retry — is what gets exercised.
    newWorker({ MAX_CHILD_REPLACEMENTS: '1', MAX_ATTEMPTS: '1' });

    const done = await waitFor(
      async () => {
        const r = await getRun(db.pool, parent.id);
        return r?.status === 'COMPLETED' ? r : null;
      },
      { label: 'parent COMPLETED after replacement exhausted', timeoutMs: 30_000 },
    );
    expect(done.status).toBe('COMPLETED');

    // The original child was replaced once; both attempts of the subtask failed.
    const { rows: kids } = await db.pool.query<{
      id: string;
      status: string;
      replacement_generation: number;
      replaces_run_id: string | null;
    }>(
      `SELECT id, status, replacement_generation, replaces_run_id
       FROM runs WHERE parent_run_id = $1 ORDER BY created_at`,
      [parent.id],
    );
    expect(kids).toHaveLength(2);
    expect(kids[0]!.replacement_generation).toBe(0);
    expect(kids[1]!.replacement_generation).toBe(1);
    expect(kids[1]!.replaces_run_id).toBe(kids[0]!.id);
    expect(kids.every((k) => k.status === 'FAILED')).toBe(true);

    const types = (await listEvents(db.pool, parent.id)).map((e) => e.type);
    expect(types.filter((t) => t === 'ChildRunReplaced')).toHaveLength(1);
    // Replacement happened before the parent finally resolved.
    expect(types.indexOf('ChildRunReplaced')).toBeLessThan(types.indexOf('ChildrenResolved'));
    expect(types[types.length - 1]).toBe('RunCompleted');
  }, 60_000);

  it('with replacement disabled, a failed child resolves the parent immediately', async () => {
    const parent = await newRun([
      { op: 'delegate', goals: ['doomed subtask'], childScript: [{ op: 'fail' }] },
      { op: 'complete' },
    ]);
    newWorker({ MAX_CHILD_REPLACEMENTS: '0', MAX_ATTEMPTS: '1' });

    const done = await waitFor(
      async () => {
        const r = await getRun(db.pool, parent.id);
        return r?.status === 'COMPLETED' ? r : null;
      },
      { label: 'parent COMPLETED with failed child, no replacement', timeoutMs: 30_000 },
    );
    expect(done.status).toBe('COMPLETED');

    const { rows: kids } = await db.pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE parent_run_id = $1`,
      [parent.id],
    );
    expect(kids).toHaveLength(1); // no replacement spawned
    expect(kids[0]!.status).toBe('FAILED');

    const types = (await listEvents(db.pool, parent.id)).map((e) => e.type);
    expect(types).not.toContain('ChildRunReplaced');
    expect(types).toContain('ChildrenResolved');
  }, 60_000);

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

    // As above, the final attempt's EXITED bookkeeping lands just after the run
    // reaches COMPLETED — wait for it to settle before asserting on it.
    const attempts = await waitFor(
      async () => {
        const a = await listAttempts(db.pool, run.id);
        return a.length >= 2 && a.at(-1)!.state === 'EXITED' ? a : null;
      },
      { label: 'final attempt EXITED (bookkeeping settled)' },
    );
    expect(attempts[0]!.state).toBe('ORPHANED');
    expect(attempts[0]!.exit_reason).toBe('lease_expired');
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
