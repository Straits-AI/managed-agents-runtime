import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { newId } from '../src/ids.js';
import { createArtifact } from '../src/store/artifacts.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb({ through: '0015_credential_reauthorization_receipts.sql' });
});

afterAll(async () => db.drop());

describe('artifact schema migration', () => {
  it('upgrades an existing run without rewriting historical state', async () => {
    const run = { id: 'run_pre_artifact_migration' };
    await db.pool.query(
      `INSERT INTO agent_definitions (id, tenant_id, name)
       VALUES ('agt_pre_artifact', 'default', 'pre-artifact-agent')`,
    );
    await db.pool.query(
      `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
       VALUES ('av_pre_artifact', 'agt_pre_artifact', 1, 'legacy run', '{"model":"none"}')`,
    );
    await db.pool.query(
      `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
       VALUES ($1, 'default', 'av_pre_artifact', 'survive migration', 'COMPLETED')`,
      [run.id],
    );
    const attemptId = newId('att');
    await db.pool.query(
      `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'migration-worker', 'EXITED', now() + interval '1 minute')`,
      [attemptId, run.id],
    );
    const before = await db.pool.query('SELECT status, last_event_seq FROM runs WHERE id = $1', [run.id]);

    expect(await db.applyRemainingMigrations()).toContain('0016_artifacts.sql');
    expect(await db.pool.query('SELECT status, last_event_seq FROM runs WHERE id = $1', [run.id]))
      .toEqual(expect.objectContaining({ rows: before.rows }));
    await expect(withTransaction(db.pool, (tx) => createArtifact(tx, {
      producerRunId: run.id,
      producerAttemptId: attemptId,
      producerStep: 0,
      digest: `sha256:${'a'.repeat(64)}`,
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
      logicalRole: 'compatibility-fixture',
      sourcePath: 'legacy.bin',
      sourceRefs: [],
      verificationRefs: [],
      evidenceRefs: [],
      objectKey: `runs/${run.id}/artifacts/legacy`,
    }))).resolves.toMatchObject({ producer_run_id: run.id });
  });
});
