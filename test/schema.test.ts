import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { newId } from '../src/ids.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

describe('schema', () => {
  it('applies all migrations idempotently', async () => {
    const { rows } = await db.pool.query('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toContain('0001_init.sql');
  });

  it('rejects UPDATE and DELETE on agent_versions', async () => {
    const adId = newId('ad');
    const avId = newId('av');
    await db.pool.query(
      `INSERT INTO agent_definitions (id, name) VALUES ($1, $2)`,
      [adId, `agent-${adId}`],
    );
    await db.pool.query(
      `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
       VALUES ($1, $2, 1, 'do things', '{"model":"test"}')`,
      [avId, adId],
    );

    await expect(
      db.pool.query(`UPDATE agent_versions SET instructions = 'changed' WHERE id = $1`, [avId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query(`DELETE FROM agent_versions WHERE id = $1`, [avId]),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects UPDATE and DELETE on run_events', async () => {
    const adId = newId('ad');
    const avId = newId('av');
    const runId = newId('run');
    await db.pool.query(`INSERT INTO agent_definitions (id, name) VALUES ($1, $2)`, [
      adId,
      `agent-${adId}`,
    ]);
    await db.pool.query(
      `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
       VALUES ($1, $2, 1, 'x', '{}')`,
      [avId, adId],
    );
    await db.pool.query(
      `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
       VALUES ($1, 'default', $2, 'g', 'CREATED')`,
      [runId, avId],
    );
    await db.pool.query(
      `INSERT INTO run_events (run_id, seq, type) VALUES ($1, 1, 'RunCreated')`,
      [runId],
    );

    await expect(
      db.pool.query(`UPDATE run_events SET type = 'Altered' WHERE run_id = $1`, [runId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query(`DELETE FROM run_events WHERE run_id = $1`, [runId]),
    ).rejects.toThrow(/immutable/);
  });

  it('enforces unique idempotency keys per run', async () => {
    const adId = newId('ad');
    const avId = newId('av');
    const runId = newId('run');
    const attId = newId('att');
    await db.pool.query(`INSERT INTO agent_definitions (id, name) VALUES ($1, $2)`, [
      adId,
      `agent-${adId}`,
    ]);
    await db.pool.query(
      `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
       VALUES ($1, $2, 1, 'x', '{}')`,
      [avId, adId],
    );
    await db.pool.query(
      `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
       VALUES ($1, 'default', $2, 'g', 'CREATED')`,
      [runId, avId],
    );
    await db.pool.query(
      `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'w1', 'ACTIVE', now() + interval '30 seconds')`,
      [attId, runId],
    );

    const insertReceipt = (id: string) =>
      db.pool.query(
        `INSERT INTO tool_receipts (id, run_id, attempt_id, step, semantic_action,
           request_digest, idempotency_key, status)
         VALUES ($1, $2, $3, 1, 'external.http.post', 'digest', 'key-1', 'PENDING')`,
        [id, runId, attId],
      );

    await insertReceipt(newId('rcpt'));
    await expect(insertReceipt(newId('rcpt'))).rejects.toThrow(/duplicate key/);
  });
});
