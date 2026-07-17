import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { dispatchTool, type ToolContext } from '../src/harness/toolRouter.js';
import { PgKnowledgeProvider } from '../src/providers/pgKnowledge.js';
import { loadConfig } from '../src/config.js';
import { newId } from '../src/ids.js';
import type { RunAttemptRow, RunRow } from '../src/core/types.js';

let db: TestDb;
let agentVersionId: string;
const cfg = loadConfig();
const KB = 'company-handbook';

beforeAll(async () => {
  db = await createTestDb();
  const def = await createAgentDefinition(db.pool, { name: 'kb-agent' });
  const ver = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, { agentId: def.id, instructions: 'x', modelPolicy: { model: 'none' } }),
  );
  agentVersionId = ver.id;
});
afterAll(async () => {
  await db.drop();
});

async function runWithAttempt() {
  const run = await withTransaction(db.pool, (tx) =>
    createRun(tx, { agentVersionId, goal: 'answer a policy question' }),
  );
  const attemptId = newId('att');
  const { rows } = await db.pool.query<RunAttemptRow>(
    `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
     VALUES ($1, $2, 1, 'w', 'ACTIVE', now() + interval '60 seconds') RETURNING *`,
    [attemptId, run.id],
  );
  return { run, attempt: rows[0]! };
}

describe('knowledge retrieval', () => {
  it('retrieves ingested passages via the knowledge_search tool', async () => {
    const kb = new PgKnowledgeProvider(db.pool);
    await kb.ingest(KB, [
      { title: 'Refund policy', content: 'Refunds are allowed within 30 days of delivery for unused items.' },
      { title: 'Shipping', content: 'Standard shipping takes 3-5 business days.' },
    ]);

    const { run, attempt } = await runWithAttempt();
    const ctx: ToolContext = {
      pool: db.pool, cfg, run, attempt,
      sandbox: {} as ToolContext['sandbox'],
      sandboxProvider: {} as ToolContext['sandboxProvider'],
      objectStore: {} as ToolContext['objectStore'],
      step: 1,
      knowledge: kb,
      knowledgeBaseId: KB,
    };
    const outcome = await dispatchTool(ctx, 'knowledge_search', { query: 'refund window', limit: 3 });
    const parsed = JSON.parse((outcome as { content: string }).content);
    expect(parsed.passages.length).toBeGreaterThan(0);
    expect(parsed.passages[0].content).toContain('30 days');
    // Most-relevant passage is the refund one, not shipping.
    expect(parsed.passages[0].title).toBe('Refund policy');
  });

  it('errors when no knowledge base is configured', async () => {
    const { run, attempt } = await runWithAttempt();
    const ctx: ToolContext = {
      pool: db.pool, cfg, run, attempt,
      sandbox: {} as ToolContext['sandbox'],
      sandboxProvider: {} as ToolContext['sandboxProvider'],
      objectStore: {} as ToolContext['objectStore'],
      step: 1,
    };
    const outcome = await dispatchTool(ctx, 'knowledge_search', { query: 'anything' });
    expect((outcome as { content: string }).content).toMatch(/no knowledge base is configured/);
  });

  it('scopes retrieval to the given knowledge base', async () => {
    const kb = new PgKnowledgeProvider(db.pool);
    await kb.ingest('other-kb', [{ content: 'secret from another knowledge base about refunds' }]);
    const hits = await kb.retrieve(KB, 'refund', 10);
    expect(hits.every((h) => !h.content.includes('another knowledge base'))).toBe(true);
  });
});
