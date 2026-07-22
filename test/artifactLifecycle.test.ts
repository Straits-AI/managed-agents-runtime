import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb } from './helpers/db.js';
import { waitFor } from './helpers/worker.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { withTransaction } from '../src/db/tx.js';
import { loadConfig } from '../src/config.js';
import { startWorker } from '../src/harness/worker.js';
import { createRealEpoch } from '../src/harness/epoch.js';
import { FsObjectStore } from '../src/providers/local/fsObjectStore.js';
import { LocalSandboxProvider } from '../src/providers/local/localSandbox.js';
import type { ModelProvider } from '../src/providers/types.js';
import { listArtifactsForRun } from '../src/store/artifacts.js';
import { listEvents } from '../src/store/events.js';

let db: TestDb;
let store: FsObjectStore;
let storeDir: string;

beforeAll(async () => {
  db = await createTestDb();
  storeDir = mkdtempSync(join(tmpdir(), 'ma-artifact-lifecycle-'));
  store = new FsObjectStore(storeDir);
  await store.start();
});

afterAll(async () => {
  await store.close();
  rmSync(storeDir, { recursive: true, force: true });
  await db.drop();
});

function artifactModel(): ModelProvider {
  let turn = 0;
  return {
    async chat() {
      turn += 1;
      const toolCalls = turn === 1
        ? [{ id: 'write', name: 'file_write', arguments: { path: 'final.md', content: '# done\n' } }]
        : [{ id: 'complete', name: 'run_complete', arguments: { summary: 'done', artifacts: ['final.md'] } }];
      return {
        message: { role: 'assistant', content: null, toolCalls },
        usage: { inputTokens: 5, outputTokens: 5 },
      };
    },
  };
}

describe('artifact completion lifecycle', () => {
  it('commits artifact rows and returns artifact IDs in RunCompleted', async () => {
    const definition = await createAgentDefinition(db.pool, { name: 'artifact-lifecycle' });
    const version = await withTransaction(db.pool, (tx) => createAgentVersion(tx, {
      agentId: definition.id,
      instructions: 'write the requested artifact',
      modelPolicy: { model: 'fixture' },
      verifierPolicy: { requiredArtifacts: ['final.md'] },
    }));
    const run = await withTransaction(db.pool, (tx) => createRun(tx, {
      tenantId: 'default', agentVersionId: version.id, goal: 'create final.md',
    }));
    const cfg = loadConfig({
      ...process.env,
      DATABASE_URL: db.url,
      LEASE_TTL_MS: '30000',
      HEARTBEAT_MS: '10000',
      POLL_MS: '50',
      SUPERVISOR_LOOP_THRESHOLD: '100',
      SUPERVISOR_STAGNATION_STEPS: '100',
    });
    const worker = startWorker(
      db.pool,
      cfg,
      createRealEpoch({
        model: artifactModel(),
        sandbox: new LocalSandboxProvider(),
        objectStore: store,
      }),
    );
    try {
      await waitFor(async () => (await getRun(db.pool, run.id))?.status === 'COMPLETED', {
        timeoutMs: 10_000,
        label: 'artifact run completed',
      });
    } finally {
      await worker.stop();
    }

    const artifacts = await listArtifactsForRun(db.pool, run.id, 'default');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      source_path: 'final.md',
      mime_type: 'text/markdown',
      logical_role: 'deliverable',
    });
    expect(await store.get(artifacts[0]!.object_key)).toEqual(Buffer.from('# done\n'));

    const completed = (await listEvents(db.pool, run.id)).find((event) => event.type === 'RunCompleted');
    const passed = (await listEvents(db.pool, run.id)).find((event) => event.type === 'VerificationPassed');
    expect(passed).toBeTruthy();
    expect(artifacts[0]!.verification_refs).toEqual([
      expect.objectContaining({ eventSeq: passed!.seq, status: 'passed' }),
    ]);
    expect(completed?.payload).toMatchObject({
      summary: 'done',
      artifacts: [artifacts[0]!.id],
    });
    expect(JSON.stringify(completed?.payload)).not.toContain(artifacts[0]!.object_key);
    expect(JSON.stringify(completed?.payload)).not.toContain('final.md');
  }, 20_000);
});
