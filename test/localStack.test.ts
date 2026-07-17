import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { FsObjectStore } from '../src/providers/local/fsObjectStore.js';
import { LocalSandboxProvider } from '../src/providers/local/localSandbox.js';
import { WorkspaceManager, WORKSPACE_DIR } from '../src/harness/workspace.js';
import { newId } from '../src/ids.js';
import type { RunRow } from '../src/core/types.js';

let db: TestDb;
let store: FsObjectStore;
let storeDir: string;
let agentVersionId: string;

beforeAll(async () => {
  db = await createTestDb();
  storeDir = mkdtempSync(join(tmpdir(), 'ma-fsstore-'));
  store = new FsObjectStore(storeDir);
  await store.start();
  const def = await createAgentDefinition(db.pool, { name: 'local-agent' });
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

async function newRun(): Promise<RunRow> {
  return withTransaction(db.pool, (tx) =>
    createRun(tx, { agentVersionId, goal: 'local stack', input: { files: { 'input.txt': 'seed data\n' } } }),
  );
}
async function attemptFor(runId: string): Promise<string> {
  const id = newId('att');
  await db.pool.query(
    `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
     VALUES ($1, $2, 1, 'w', 'ACTIVE', now() + interval '60 seconds')`,
    [id, runId],
  );
  return id;
}

describe('local execution stack (no BytePlus)', () => {
  it('FsObjectStore round-trips objects and presigned URLs', async () => {
    await store.put('k/a.txt', Buffer.from('hello'));
    expect((await store.get('k/a.txt')).toString()).toBe('hello');
    expect(await store.exists('k/a.txt')).toBe(true);

    // Presigned PUT then GET, exercised with real HTTP (as the sandbox does).
    const putUrl = await store.presignPut('k/b.txt', 60);
    const put = await fetch(putUrl, { method: 'PUT', body: 'via-presign' });
    expect(put.ok).toBe(true);
    const getUrl = await store.presignGet('k/b.txt', 60);
    expect(await (await fetch(getUrl)).text()).toBe('via-presign');
  });

  it('LocalSandbox execs commands and maps the workspace dir', async () => {
    const sandbox = new LocalSandboxProvider();
    const h = await sandbox.create({ runId: 'r', timeoutMinutes: 5 });
    try {
      await sandbox.writeFile(h, `${WORKSPACE_DIR}/hi.txt`, 'content');
      expect(await sandbox.readFile(h, `${WORKSPACE_DIR}/hi.txt`)).toBe('content');
      const res = await sandbox.exec(h, 'echo out && cat hi.txt');
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('out');
      expect(res.stdout).toContain('content');
      const fail = await sandbox.exec(h, 'exit 7');
      expect(fail.exitCode).toBe(7);
    } finally {
      await sandbox.terminate(h);
    }
  });

  it('runs the durable workspace cycle: seed → checkpoint → restore into a fresh sandbox', async () => {
    const sandbox = new LocalSandboxProvider();
    const workspaces = new WorkspaceManager(db.pool, sandbox, store);
    const run = await newRun();
    const attemptId = await attemptFor(run.id);

    // Sandbox #1: restore (seeds input.txt), mutate, checkpoint to the FS store.
    const s1 = await sandbox.create({ runId: run.id, timeoutMinutes: 5 });
    await workspaces.restore(s1, { runId: run.id, attemptId, workspaceId: run.workspace_id!, seedFiles: { 'input.txt': 'seed data\n' } });
    expect(await sandbox.readFile(s1, `${WORKSPACE_DIR}/input.txt`)).toContain('seed data');
    await sandbox.writeFile(s1, `${WORKSPACE_DIR}/result.txt`, 'computed-42');
    await workspaces.checkpoint(s1, { runId: run.id, attemptId, workspaceId: run.workspace_id! });
    await sandbox.terminate(s1); // lose the sandbox

    // Sandbox #2: a brand-new sandbox restores from the durable TOS-equivalent.
    const s2 = await sandbox.create({ runId: run.id, timeoutMinutes: 5 });
    const { restoredRevisionId } = await workspaces.restore(s2, {
      runId: run.id, attemptId, workspaceId: run.workspace_id!,
    });
    expect(restoredRevisionId).toBeTruthy();
    expect(await sandbox.readFile(s2, `${WORKSPACE_DIR}/result.txt`)).toBe('computed-42');
    expect(await sandbox.readFile(s2, `${WORKSPACE_DIR}/input.txt`)).toContain('seed data');
    await sandbox.terminate(s2);
  });
});
