import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb } from './helpers/db.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { withTransaction } from '../src/db/tx.js';
import { newId } from '../src/ids.js';
import {
  createArtifact,
  getArtifactForTenant,
  listArtifactsForRun,
} from '../src/store/artifacts.js';
import { FsObjectStore } from '../src/providers/local/fsObjectStore.js';
import { LocalSandboxProvider } from '../src/providers/local/localSandbox.js';
import { stageArtifactOutputs } from '../src/harness/artifacts.js';
import { WORKSPACE_DIR } from '../src/harness/workspace.js';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';

let db: TestDb;
let agentVersionId: string;
let store: FsObjectStore;
let storeDir: string;

beforeAll(async () => {
  db = await createTestDb();
  storeDir = mkdtempSync(join(tmpdir(), 'ma-artifacts-'));
  store = new FsObjectStore(storeDir);
  await store.start();
  const definition = await createAgentDefinition(db.pool, {
    tenantId: 'default',
    name: 'artifact-test-agent',
  });
  const version = await withTransaction(db.pool, (tx) => createAgentVersion(tx, {
    agentId: definition.id,
    instructions: 'produce evidence',
    modelPolicy: { model: 'none' },
  }));
  agentVersionId = version.id;
});

afterAll(async () => {
  await store.close();
  rmSync(storeDir, { recursive: true, force: true });
  await db.drop();
});

describe('runtime artifacts', () => {
  it('persists content identity, producer lineage, source, verification, and evidence', async () => {
    const run = await withTransaction(db.pool, (tx) => createRun(tx, {
      tenantId: 'default',
      agentVersionId,
      goal: 'produce an artifact',
    }));
    const attemptId = newId('att');
    await db.pool.query(
      `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'artifact-worker', 'ACTIVE', now() + interval '1 minute')`,
      [attemptId, run.id],
    );
    const bytes = Buffer.from('verified report');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

    const artifact = await withTransaction(db.pool, (tx) => createArtifact(tx, {
      producerRunId: run.id,
      producerAttemptId: attemptId,
      producerStep: 7,
      digest,
      mimeType: 'text/markdown',
      sizeBytes: bytes.byteLength,
      logicalRole: 'deliverable',
      sourcePath: 'reports/final.md',
      sourceRefs: [{ kind: 'workspace_path', path: 'reports/final.md' }],
      verificationRefs: [{ kind: 'runtime_verifier', status: 'passed' }],
      evidenceRefs: [{ kind: 'run_event', type: 'VerificationStarted' }],
      objectKey: `runs/${run.id}/artifacts/final`,
    }));

    expect(artifact.id).toMatch(/^art_/);
    expect(artifact).toMatchObject({
      schema_version: 1,
      producer_run_id: run.id,
      producer_attempt_id: attemptId,
      producer_step: 7,
      digest,
      mime_type: 'text/markdown',
      size_bytes: String(bytes.byteLength),
      logical_role: 'deliverable',
      source_path: 'reports/final.md',
    });
    expect(artifact.source_refs).toEqual([{ kind: 'workspace_path', path: 'reports/final.md' }]);
    expect(artifact.verification_refs).toEqual([{ kind: 'runtime_verifier', status: 'passed' }]);
    expect(artifact.evidence_refs).toEqual([{ kind: 'run_event', type: 'VerificationStarted' }]);

    await expect(db.pool.query(
      `UPDATE artifacts SET logical_role = 'changed' WHERE id = $1`,
      [artifact.id],
    )).rejects.toThrow(/immutable/);

    expect(await listArtifactsForRun(db.pool, run.id, 'default')).toHaveLength(1);
    expect(await listArtifactsForRun(db.pool, run.id, 'other-tenant')).toEqual([]);
    expect(await getArtifactForTenant(db.pool, artifact.id, 'default')).toMatchObject({ id: artifact.id });
    expect(await getArtifactForTenant(db.pool, artifact.id, 'other-tenant')).toBeNull();
  });

  it('rejects producer attempts belonging to a different run', async () => {
    const first = await withTransaction(db.pool, (tx) => createRun(tx, {
      tenantId: 'default', agentVersionId, goal: 'first',
    }));
    const second = await withTransaction(db.pool, (tx) => createRun(tx, {
      tenantId: 'default', agentVersionId, goal: 'second',
    }));
    const attemptId = newId('att');
    await db.pool.query(
      `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'artifact-worker', 'ACTIVE', now() + interval '1 minute')`,
      [attemptId, first.id],
    );

    await expect(withTransaction(db.pool, (tx) => createArtifact(tx, {
      producerRunId: second.id,
      producerAttemptId: attemptId,
      producerStep: 0,
      digest: `sha256:${'a'.repeat(64)}`,
      mimeType: 'application/octet-stream',
      sizeBytes: 1,
      logicalRole: 'deliverable',
      sourcePath: 'wrong.bin',
      sourceRefs: [],
      verificationRefs: [],
      evidenceRefs: [],
      objectKey: 'internal/wrong',
    }))).rejects.toThrow();
  });

  it('stages normalized outputs with deterministic private locators', async () => {
    const sandboxProvider = new LocalSandboxProvider();
    const sandbox = await sandboxProvider.create({ runId: 'artifact-stage', timeoutMinutes: 5 });
    try {
      await sandboxProvider.writeFile(
        sandbox,
        `${WORKSPACE_DIR}/reports/final.md`,
        '# verified\n',
      );
      const context = {
        runId: 'run_artifact_stage',
        attemptId: 'att_artifact_stage',
        producerStep: 4,
        verificationPassedEventSeq: '12',
        sandbox,
        sandboxProvider,
        objectStore: store,
      };
      const first = await stageArtifactOutputs(context, [
        'reports/final.md',
        `${WORKSPACE_DIR}/reports/final.md`,
      ]);
      const second = await stageArtifactOutputs(context, ['reports/final.md']);

      expect(first).toHaveLength(1);
      expect(second[0]!.id).toBe(first[0]!.id);
      expect(second[0]!.objectKey).toBe(first[0]!.objectKey);
      expect(first[0]).toMatchObject({
        mimeType: 'text/markdown',
        sourcePath: 'reports/final.md',
        logicalRole: 'deliverable',
        producerStep: 4,
      });
      expect(first[0]!.verificationRefs).toEqual([expect.objectContaining({ eventSeq: '12' })]);
      expect(first[0]!.evidenceRefs).toEqual([expect.objectContaining({ seq: '12' })]);
      expect(await store.get(first[0]!.objectKey)).toEqual(Buffer.from('# verified\n'));
      await expect(stageArtifactOutputs(context, ['../escape.txt'])).rejects.toThrow(
        /workspace-relative/,
      );
    } finally {
      await sandboxProvider.terminate(sandbox);
    }
  });

  it('serves tenant-authorized metadata and content without exposing object locators', async () => {
    const run = await withTransaction(db.pool, (tx) => createRun(tx, {
      tenantId: 'default', agentVersionId, goal: 'retrieve an artifact',
    }));
    const attemptId = newId('att');
    await db.pool.query(
      `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'artifact-worker', 'ACTIVE', now() + interval '1 minute')`,
      [attemptId, run.id],
    );
    const bytes = Buffer.from('private artifact bytes');
    const objectKey = `private/${run.id}/secret-locator`;
    await store.put(objectKey, bytes);
    const artifact = await withTransaction(db.pool, (tx) => createArtifact(tx, {
      producerRunId: run.id,
      producerAttemptId: attemptId,
      producerStep: 2,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      mimeType: 'text/plain',
      sizeBytes: bytes.byteLength,
      logicalRole: 'deliverable',
      sourcePath: 'final.txt',
      sourceRefs: [{ kind: 'workspace_path', path: 'final.txt' }],
      verificationRefs: [{ kind: 'runtime_verifier', status: 'passed' }],
      evidenceRefs: [],
      objectKey,
    }));
    const app = buildServer({
      pool: db.pool,
      cfg: loadConfig({
        ...process.env,
        DATABASE_URL: db.url,
        API_AUTH_TOKEN: 'artifact-test-token',
        RATE_LIMIT_PER_SEC: '0',
      }),
      objectStore: store,
    });
    try {
      const headers = { authorization: 'Bearer artifact-test-token' };
      const listed = await app.inject({
        method: 'GET', url: `/v1/runs/${run.id}/artifacts`, headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().artifacts).toEqual([expect.objectContaining({
        id: artifact.id,
        schemaVersion: 1,
        sourcePath: 'final.txt',
        contentUrl: `/v1/runs/${run.id}/artifacts/${artifact.id}/content`,
      })]);
      expect(listed.body).not.toContain(objectKey);

      const content = await app.inject({
        method: 'GET',
        url: `/v1/runs/${run.id}/artifacts/${artifact.id}/content`,
        headers,
      });
      expect(content.statusCode).toBe(200);
      expect(content.headers['content-type']).toContain('text/plain');
      expect(content.rawPayload).toEqual(bytes);
      expect((await app.inject({
        method: 'GET',
        url: `/v1/runs/run_wrong/artifacts/${artifact.id}/content`,
        headers,
      })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
