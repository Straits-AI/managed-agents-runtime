import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { transitionRun, appendEvent } from '../src/core/transition.js';
import { FsObjectStore } from '../src/providers/local/fsObjectStore.js';
import {
  exportRunBundle,
  validateRunBundleForImport,
} from '../src/export/runBundle.js';
import { createArtifact } from '../src/store/artifacts.js';
import { insertRevision } from '../src/store/workspaces.js';
import { newId } from '../src/ids.js';

let db: TestDb;
let store: FsObjectStore;
let storeDir: string;
let agentVersionId: string;

beforeAll(async () => {
  db = await createTestDb();
  storeDir = mkdtempSync(join(tmpdir(), 'ma-export-'));
  store = new FsObjectStore(storeDir);
  await store.start();
  const def = await createAgentDefinition(db.pool, { name: 'export-agent' });
  const ver = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, { agentId: def.id, instructions: 'x', modelPolicy: { model: 'none' } }),
  );
  agentVersionId = ver.id;
});
afterAll(async () => {
  await store.close();
  rmSync(storeDir, { recursive: true, force: true });
  await db.drop();
});

describe('run bundle export', () => {
  it('exports a portable bundle: gapless events, receipts, grants, workspace snapshot', async () => {
    const run = await withTransaction(db.pool, (tx) =>
      createRun(tx, { tenantId: 'default', agentVersionId, goal: 'exportable', grants: [{ action: 'external.http.*', resource: '*' }] }),
    );
    const attemptId = newId('att');
    await db.pool.query(
      `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'w', 'ACTIVE', now() + interval '60 seconds')`,
      [attemptId, run.id],
    );
    // A workspace snapshot in the object store + revision row.
    const key = `runs/${run.id}/workspace/snap.tgz`;
    await store.put(key, Buffer.from('SNAPSHOT-BYTES'));
    await withTransaction(db.pool, (tx) =>
      insertRevision(tx, { workspaceId: run.workspace_id!, tosKey: key, digest: 'abc', sizeBytes: 14, attemptId }),
    );
    // Drive it to a terminal state so there's a real event history.
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, run.id, { expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' }, attemptId });
      await transitionRun(tx, run.id, { expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' }, attemptId });
      await transitionRun(tx, run.id, { expectFrom: ['RUNNING'], to: 'VERIFYING', event: { type: 'VerificationStarted' }, attemptId });
      await transitionRun(tx, run.id, { expectFrom: ['VERIFYING'], to: 'COMPLETED', event: { type: 'RunCompleted' }, attemptId });
    });

    const artifactBytes = Buffer.from('FINAL-REPORT');
    const artifactDigest = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`;
    const artifactKey = `runs/${run.id}/artifacts/final-report`;
    await store.put(artifactKey, artifactBytes);
    const artifact = await withTransaction(db.pool, (tx) => createArtifact(tx, {
      producerRunId: run.id,
      producerAttemptId: attemptId,
      producerStep: 3,
      digest: artifactDigest,
      mimeType: 'text/plain',
      sizeBytes: artifactBytes.byteLength,
      logicalRole: 'deliverable',
      sourcePath: 'final.txt',
      sourceRefs: [{ kind: 'workspace_path', path: 'final.txt' }],
      verificationRefs: [{ kind: 'runtime_verifier', status: 'passed' }],
      evidenceRefs: [],
      objectKey: artifactKey,
    }));

    const bundle = await exportRunBundle(db.pool, store, run.id);
    expect(bundle.bundleVersion).toBe(2);
    expect((bundle.run as { id: string }).id).toBe(run.id);
    expect(bundle.grants).toHaveLength(1);
    expect(bundle.attempts).toHaveLength(1);
    // Gapless history 1..N.
    expect(bundle.events.map((e) => Number(e.seq))).toEqual(
      Array.from({ length: bundle.events.length }, (_, i) => i + 1),
    );
    expect(bundle.events.at(-1)!.type).toBe('RunCompleted');
    // Workspace snapshot inlined so the bundle is self-contained + portable.
    expect(bundle.workspace.latestSnapshotKey).toBe(key);
    expect(Buffer.from(bundle.workspace.latestSnapshotBase64!, 'base64').toString()).toBe('SNAPSHOT-BYTES');
    expect(bundle.artifacts).toEqual([expect.objectContaining({
      id: artifact.id,
      schemaVersion: 1,
      digest: artifactDigest,
      producer: { runId: run.id, attemptId, step: 3 },
      contentBase64: artifactBytes.toString('base64'),
    })]);
    expect(JSON.stringify(bundle.artifacts)).not.toContain(artifactKey);
    expect(() => validateRunBundleForImport(bundle)).not.toThrow();

    const tampered = structuredClone(bundle);
    tampered.artifacts[0]!.contentBase64 = Buffer.from('TAMPERED').toString('base64');
    expect(() => validateRunBundleForImport(tampered)).toThrow(/artifact digest mismatch/);

    const wrongLineage = structuredClone(bundle);
    wrongLineage.artifacts[0]!.producer.attemptId = 'att_not_in_bundle';
    expect(() => validateRunBundleForImport(wrongLineage)).toThrow(/artifact attempt lineage/);
  });

  it('the event history is append-only, so an exported bundle cannot be gapped', async () => {
    const run = await withTransaction(db.pool, (tx) => createRun(tx, { tenantId: 'default', agentVersionId, goal: 'immutable' }));
    // The append-only trigger makes events un-deletable — a gap is impossible.
    await expect(
      db.pool.query(`DELETE FROM run_events WHERE run_id = $1 AND seq = 1`, [run.id]),
    ).rejects.toThrow(/immutable/);
    // Export succeeds with an intact, gapless history.
    const bundle = await exportRunBundle(db.pool, store, run.id);
    expect(bundle.events.map((e) => Number(e.seq))).toEqual(
      Array.from({ length: bundle.events.length }, (_, i) => i + 1),
    );
  });

  it('404s a missing run', async () => {
    await expect(exportRunBundle(db.pool, store, 'run_nope')).rejects.toThrow(/not found/);
  });

  it('reports a cross-tenant run as not-found (no existence leak)', async () => {
    const run = await withTransaction(db.pool, (tx) => createRun(tx, { tenantId: 'default', agentVersionId, goal: 'tenant a' }));
    // Correct tenant exports fine; a different tenant sees "not found".
    await expect(exportRunBundle(db.pool, store, run.id, 'default')).resolves.toBeTruthy();
    await expect(exportRunBundle(db.pool, store, run.id, 'other-tenant')).rejects.toThrow(/not found/);
  });
});
