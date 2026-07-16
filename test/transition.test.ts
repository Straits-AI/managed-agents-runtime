import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { listEvents } from '../src/store/events.js';
import { transitionRun, appendEvent, UnexpectedStatusError } from '../src/core/transition.js';
import { InvalidTransitionError } from '../src/core/stateMachine.js';
import { drainOutbox } from '../src/store/outbox.js';

let db: TestDb;
let agentVersionId: string;

beforeAll(async () => {
  db = await createTestDb();
  const def = await createAgentDefinition(db.pool, { name: 'test-agent' });
  const ver = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, {
      agentId: def.id,
      instructions: 'test',
      modelPolicy: { model: 'test-model' },
    }),
  );
  agentVersionId = ver.id;
});

afterAll(async () => {
  await db.drop();
});

async function newRun() {
  return withTransaction(db.pool, (tx) =>
    createRun(tx, { agentVersionId, goal: 'test goal' }),
  );
}

describe('createRun', () => {
  it('drives CREATED→RESOLVING→QUEUED with events 1..2', async () => {
    const run = await newRun();
    expect(run.status).toBe('QUEUED');
    expect(run.last_event_seq).toBe('2');
    const events = await listEvents(db.pool, run.id);
    expect(events.map((e) => e.type)).toEqual(['RunCreated', 'RunQueued']);
    expect(events.map((e) => Number(e.seq))).toEqual([1, 2]);
    expect(run.workspace_id).toBeTruthy();
  });
});

describe('transitionRun', () => {
  it('rejects a transition from an unexpected status', async () => {
    const run = await newRun();
    await expect(
      withTransaction(db.pool, (tx) =>
        transitionRun(tx, run.id, {
          expectFrom: ['RUNNING'],
          to: 'VERIFYING',
          event: { type: 'VerificationStarted' },
        }),
      ),
    ).rejects.toThrow(UnexpectedStatusError);
  });

  it('rejects an illegal edge even when expectFrom matches', async () => {
    const run = await newRun();
    await expect(
      withTransaction(db.pool, (tx) =>
        transitionRun(tx, run.id, {
          expectFrom: ['QUEUED'],
          to: 'COMPLETED',
          event: { type: 'RunCompleted' },
        }),
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rolls back the event when the transaction fails after transition', async () => {
    const run = await newRun();
    await expect(
      withTransaction(db.pool, async (tx) => {
        await transitionRun(tx, run.id, {
          expectFrom: ['QUEUED'],
          to: 'STARTING',
          event: { type: 'AttemptStarted' },
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = await getRun(db.pool, run.id);
    expect(after!.status).toBe('QUEUED');
    expect(after!.last_event_seq).toBe('2');
  });

  it('writes an outbox row for every event', async () => {
    const run = await newRun();
    const seen: string[] = [];
    await drainOutbox(db.pool, (row) => {
      if (row.key === run.id) seen.push(row.payload.type as string);
    }, 10_000);
    expect(seen).toContain('RunCreated');
    expect(seen).toContain('RunQueued');
  });
});

describe('appendEvent concurrency', () => {
  it('keeps the per-run sequence gapless under parallel writers', async () => {
    const run = await newRun();
    const WRITERS = 20;
    await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        withTransaction(db.pool, (tx) =>
          appendEvent(tx, run.id, {
            type: 'ProgressUpdated',
            payload: { writer: i },
          }),
        ),
      ),
    );
    const events = await listEvents(db.pool, run.id);
    const seqs = events.map((e) => Number(e.seq));
    expect(seqs).toEqual(Array.from({ length: 2 + WRITERS }, (_, i) => i + 1));
  });
});
