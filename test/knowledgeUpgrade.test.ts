import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { createTenant } from '../src/store/tenants.js';
import {
  createAgentDefinition,
  createAgentVersion,
  knowledgeReferenceFromConfig,
} from '../src/store/agents.js';
import { createKnowledgeBinding } from '../src/store/knowledgeBindings.js';
import { createRun } from '../src/store/runs.js';
import { withTransaction } from '../src/db/tx.js';
import { newId } from '../src/ids.js';
import { loadConfig } from '../src/config.js';
import { dispatchTool, type ToolContext } from '../src/harness/toolRouter.js';
import { AgentKitKnowledgeProvider } from '../src/providers/agentkitKnowledge.js';
import type { SignV4Input } from '../src/providers/byteplus/signerV4.js';
import type { RunAttemptRow } from '../src/core/types.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

describe('knowledge binding rollout compatibility', () => {
  it('executes an immutable legacy agent version through a tenant binding', async () => {
    const tenant = await createTenant(db.pool, { name: 'Legacy knowledge tenant' });
    const definition = await createAgentDefinition(db.pool, {
      tenantId: tenant.id,
      name: 'legacy-agent',
    });
    const version = await withTransaction(db.pool, (tx) =>
      createAgentVersion(tx, {
        agentId: definition.id,
        instructions: 'legacy',
        modelPolicy: { model: 'none' },
        // This is the exact pre-0012 stored shape. It is now interpreted only
        // as a tenant logical binding, never as provider coordinates.
        knowledgeConfig: { knowledgeBaseId: 'legacy-handbook' },
      }),
    );
    await createKnowledgeBinding(db.pool, {
      tenantId: tenant.id,
      name: 'legacy-handbook',
      provider: 'agentkit',
      providerProject: 'server-project',
      providerCollection: 'server-collection',
      liveVerifiedAt: new Date('2026-07-19T00:00:00Z'),
    });
    const run = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: tenant.id,
        agentVersionId: version.id,
        goal: 'use legacy knowledge',
      }),
    );
    const { rows } = await db.pool.query<RunAttemptRow>(
      `INSERT INTO run_attempts
         (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'upgrade-test', 'ACTIVE', now() + interval '60 seconds')
       RETURNING *`,
      [newId('att'), run.id],
    );
    const calls: Record<string, unknown>[] = [];
    const provider = new AgentKitKnowledgeProvider(
      db.pool,
      { accessKeyId: 'ak', secretAccessKey: 'sk', requireLiveVerified: true },
      async <T>(input: SignV4Input) => {
        calls.push(JSON.parse(input.body!));
        return { result_list: [{ content: 'legacy evidence' }] } as T;
      },
    );
    const outcome = await dispatchTool(
      {
        pool: db.pool,
        cfg: loadConfig(),
        run,
        attempt: rows[0]!,
        sandbox: {} as ToolContext['sandbox'],
        sandboxProvider: {} as ToolContext['sandboxProvider'],
        objectStore: {} as ToolContext['objectStore'],
        step: 1,
        knowledge: provider,
        knowledgeReference: knowledgeReferenceFromConfig(version.knowledge_config),
      },
      'knowledge_search',
      { query: 'policy' },
    );

    expect((outcome as { content: string }).content).toContain('legacy evidence');
    expect(calls).toEqual([
      {
        collection_name: 'server-collection',
        project: 'server-project',
        query: 'policy',
        limit: 5,
      },
    ]);
  });
});
