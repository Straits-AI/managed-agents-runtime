import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { drainOutbox } from '../src/store/outbox.js';
import { InProcessPublisher } from '../src/providers/local/inProcessPublisher.js';
import type { EventPublisher, PublishableEvent } from '../src/providers/types.js';

let db: TestDb;
let agentVersionId: string;

beforeAll(async () => {
  db = await createTestDb();
  const def = await createAgentDefinition(db.pool, { name: 'outbox-agent' });
  const ver = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, { agentId: def.id, instructions: 'x', modelPolicy: { model: 'none' } }),
  );
  agentVersionId = ver.id;
});

afterAll(async () => {
  await db.drop();
});

/** A publisher that records every event it receives. */
function recorder(): { pub: EventPublisher; seen: PublishableEvent[] } {
  const seen: PublishableEvent[] = [];
  return { pub: { publish: async (rows) => void seen.push(...rows) }, seen };
}

async function unpublishedCount(): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL`,
  );
  return Number(rows[0]!.n);
}

describe('outbox relay', () => {
  it('drains unpublished rows to the publisher and marks them published', async () => {
    await withTransaction(db.pool, (tx) => createRun(tx, { agentVersionId, goal: 'g' }));
    expect(await unpublishedCount()).toBeGreaterThan(0);

    const { pub, seen } = recorder();
    let total = 0;
    for (;;) {
      const n = await drainOutbox(db.pool, pub, 100);
      total += n;
      if (n === 0) break;
    }
    expect(total).toBeGreaterThan(0);
    expect(seen.map((e) => e.topic)).toContain('run_events');
    expect(await unpublishedCount()).toBe(0);

    // A second drain finds nothing (idempotent).
    expect(await drainOutbox(db.pool, new InProcessPublisher(), 100)).toBe(0);
  });

  it('never double-publishes across two concurrent relays (FOR UPDATE SKIP LOCKED)', async () => {
    // Generate a batch of fresh outbox rows.
    for (let i = 0; i < 5; i++) {
      await withTransaction(db.pool, (tx) => createRun(tx, { agentVersionId, goal: `g${i}` }));
    }
    const before = await unpublishedCount();
    expect(before).toBeGreaterThan(0);

    const a = recorder();
    const b = recorder();
    // Two relays drain in parallel repeatedly until the outbox is empty.
    async function drainAll(pub: EventPublisher): Promise<void> {
      for (;;) {
        const n = await drainOutbox(db.pool, pub, 3);
        if (n === 0) break;
      }
    }
    await Promise.all([drainAll(a.pub), drainAll(b.pub)]);

    const ids = [...a.seen, ...b.seen].map((e) => e.id);
    expect(ids.length).toBe(before); // every row published exactly once...
    expect(new Set(ids).size).toBe(before); // ...and none twice
    expect(await unpublishedCount()).toBe(0);
  });
});
