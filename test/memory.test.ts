import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { dispatchTool, type ToolContext } from '../src/harness/toolRouter.js';
import { compileContext } from '../src/harness/contextCompiler.js';
import { PgMemoryProvider } from '../src/providers/pgMemory.js';
import { getAgentVersion } from '../src/store/agents.js';
import { loadConfig } from '../src/config.js';
import { newId } from '../src/ids.js';
import type { RunAttemptRow, RunRow } from '../src/core/types.js';

let db: TestDb;
let agentId: string;
let agentVersionId: string;
const cfg = loadConfig();
const scope = () => ({ tenantId: 'default', agentId });

beforeAll(async () => {
  db = await createTestDb();
  const def = await createAgentDefinition(db.pool, { name: 'memory-agent' });
  agentId = def.id;
  const ver = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, { agentId: def.id, instructions: 'x', modelPolicy: { model: 'none' } }),
  );
  agentVersionId = ver.id;
});

afterAll(async () => {
  await db.drop();
});

async function runWithAttempt(): Promise<{ run: RunRow; attempt: RunAttemptRow }> {
  const run = await withTransaction(db.pool, (tx) =>
    createRun(tx, { tenantId: 'default', agentVersionId, goal: 'do the deploy for project atlas' }),
  );
  const attemptId = newId('att');
  const { rows } = await db.pool.query<RunAttemptRow>(
    `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
     VALUES ($1, $2, 1, 'w', 'ACTIVE', now() + interval '60 seconds') RETURNING *`,
    [attemptId, run.id],
  );
  return { run, attempt: rows[0]! };
}

describe('long-term memory', () => {
  it('the remember tool persists a memory scoped to the agent', async () => {
    const memory = new PgMemoryProvider(db.pool);
    const { run, attempt } = await runWithAttempt();
    const ctx: ToolContext = {
      pool: db.pool,
      cfg,
      run,
      attempt,
      sandbox: {} as ToolContext['sandbox'],
      sandboxProvider: {} as ToolContext['sandboxProvider'],
      objectStore: {} as ToolContext['objectStore'],
      step: 1,
      memory,
      memoryScope: scope(),
    };
    const outcome = await dispatchTool(ctx, 'remember', {
      content: 'Project Atlas deploys go through the staging gate first.',
      kind: 'decision',
    });
    expect((outcome as { content: string }).content).toContain('saved');

    const recalled = await memory.search(scope(), 'atlas deploy', 5);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.content).toContain('staging gate');
    expect(recalled[0]!.kind).toBe('decision');
  });

  it('recalls a memory written by an EARLIER run into a later run’s context', async () => {
    const memory = new PgMemoryProvider(db.pool);
    // Run 1 remembers a preference.
    await memory.write(scope(), [
      { content: 'The user prefers TypeScript over JavaScript for new services.', kind: 'preference' },
    ]);

    // Run 2 (a fresh run) compiles context; the memory should appear.
    const { run } = await runWithAttempt();
    const version = (await getAgentVersion(db.pool, agentVersionId))!;
    const memories = await memory.search(scope(), run.goal, 8);
    const messages = compileContext({
      version,
      run,
      grants: [],
      transcript: [],
      userMessages: [],
      approvalOutcomes: [],
      memories,
      toolDocs: '',
    });
    const userMsg = messages.find((m) => m.role === 'user')!.content as string;
    expect(userMsg).toContain('long-term memory');
    expect(userMsg).toContain('prefers TypeScript');
  });

  it('scopes memory per agent (no cross-agent leakage)', async () => {
    const memory = new PgMemoryProvider(db.pool);
    const otherDef = await createAgentDefinition(db.pool, { name: 'other-agent' });
    await memory.write({ tenantId: 'default', agentId: otherDef.id }, [
      { content: 'secret belonging to the other agent' },
    ]);
    const mine = await memory.search(scope(), 'secret', 10);
    expect(mine.every((m) => !m.content.includes('other agent'))).toBe(true);
  });
});
