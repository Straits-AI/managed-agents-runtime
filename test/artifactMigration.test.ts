import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
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
    const definition = await createAgentDefinition(db.pool, { name: 'pre-artifact-agent' });
    const version = await withTransaction(db.pool, (tx) => createAgentVersion(tx, {
      agentId: definition.id,
      instructions: 'legacy run',
      modelPolicy: { model: 'none' },
    }));
    const run = await withTransaction(db.pool, (tx) => createRun(tx, {
      tenantId: 'default', agentVersionId: version.id, goal: 'survive migration',
    }));
    const attemptId = newId('att');
    await db.pool.query(
      `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'migration-worker', 'ACTIVE', now() + interval '1 minute')`,
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
