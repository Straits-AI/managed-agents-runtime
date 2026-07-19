import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb } from './helpers/db.js';
import { waitFor } from './helpers/worker.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { listEvents } from '../src/store/events.js';
import { listAttempts } from '../src/store/attempts.js';
import { loadConfig } from '../src/config.js';
import { startWorker } from '../src/harness/worker.js';
import { createRealEpoch } from '../src/harness/epoch.js';
import { FsObjectStore } from '../src/providers/local/fsObjectStore.js';
import { LocalSandboxProvider } from '../src/providers/local/localSandbox.js';
import type { ModelProvider } from '../src/providers/types.js';

// A model that never makes progress — it proposes the exact same tool call on
// every turn. This is precisely what the supervisor's loop detector exists to
// catch. It records the model string it was invoked with so we can verify
// adaptive routing kicks in on escalation.
function loopingModel(): { model: ModelProvider; seen: string[] } {
  const seen: string[] = [];
  const model: ModelProvider = {
    async chat(req) {
      seen.push(req.model);
      return {
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: `c${seen.length}`, name: 'bash_exec', arguments: { command: 'echo loop' } }],
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  return { model, seen };
}

let db: TestDb;
let store: FsObjectStore;
let storeDir: string;

beforeAll(async () => {
  db = await createTestDb();
  storeDir = mkdtempSync(join(tmpdir(), 'ma-sup-'));
  store = new FsObjectStore(storeDir);
  await store.start();
});

afterAll(async () => {
  await store.close();
  rmSync(storeDir, { recursive: true, force: true });
  await db.drop();
});

describe('semantic supervisor — live epoch (no BytePlus)', () => {
  it('detects a looping agent, escalates the model, then terminates the run', async () => {
    const def = await createAgentDefinition(db.pool, { name: 'looper' });
    const ver = await withTransaction(db.pool, (tx) =>
      createAgentVersion(tx, {
        agentId: def.id,
        instructions: 'do the task',
        modelPolicy: { model: 'base-model', escalationModel: 'strong-model' },
      }),
    );
    const run = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: 'default',
        agentVersionId: ver.id,
        goal: 'accomplish something',
        input: { files: { 'input.txt': 'seed\n' } },
      }),
    );

    const cfg = loadConfig({
      ...process.env,
      DATABASE_URL: db.url,
      SUPERVISOR_LOOP_THRESHOLD: '3',
      SUPERVISOR_MAX_ESCALATIONS: '1',
      SUPERVISOR_STAGNATION_STEPS: '100', // isolate loop detection from stagnation
      LEASE_TTL_MS: '30000',
      HEARTBEAT_MS: '10000',
      POLL_MS: '100',
    } as NodeJS.ProcessEnv);

    const { model, seen } = loopingModel();
    const sandbox = new LocalSandboxProvider();
    const worker = startWorker(db.pool, cfg, createRealEpoch({ model, sandbox, objectStore: store }));

    try {
      const failed = await waitFor(
        async () => {
          const r = await getRun(db.pool, run.id);
          return r?.status === 'FAILED' ? r : null;
        },
        { timeoutMs: 30_000, label: 'run FAILED (loop unrecovered)' },
      );
      expect(failed.status_reason).toBe('loop_unrecovered');
    } finally {
      await worker.stop();
    }

    // The ledger shows the full supervisory arc: detection → recovery →
    // escalation → definitive failure.
    const types = (await listEvents(db.pool, run.id)).map((e) => e.type);
    expect(types).toContain('LoopDetected');
    expect(types).toContain('SemanticRecoveryApplied');
    expect(types).toContain('ModelEscalated');
    expect(types).toContain('RunFailed');

    // Adaptive routing: the escalation bumped to the stronger model for the
    // final turn(s), never before.
    expect(seen).toContain('strong-model');
    expect(seen.indexOf('base-model')).toBeLessThan(seen.indexOf('strong-model'));
    expect(seen.at(-1)).toBe('strong-model');

    // Terminated definitively — a single attempt, no retry storm.
    const attempts = await listAttempts(db.pool, run.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe('EXITED');
  }, 60_000);
});
