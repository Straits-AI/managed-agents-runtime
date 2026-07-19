import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { listApprovals, decideApproval } from '../src/store/approvals.js';
import { transitionRun } from '../src/core/transition.js';
import { dispatchTool, type ToolContext } from '../src/harness/toolRouter.js';
import {
  RegistryMcpProvider,
  type McpCallContext,
} from '../src/providers/registryMcp.js';
import { resolveMcpTools, type McpRouteEntry } from '../src/harness/mcp.js';
import { loadConfig } from '../src/config.js';
import { newId } from '../src/ids.js';
import type { RunAttemptRow, RunRow } from '../src/core/types.js';
import type { CredentialProvider } from '../src/providers/types.js';

let db: TestDb;
let agentVersionId: string;
let observedCallContext: McpCallContext | null = null;
const cfg = loadConfig();

const mcp = new RegistryMcpProvider().registerToolset('crm', [
  {
    def: { name: 'lookup_customer', description: 'find a customer', parameters: { type: 'object', properties: { id: { type: 'string' } } } },
    handler: (args, context) => {
      observedCallContext = context;
      return JSON.stringify({ id: args.id, name: 'Acme Corp' });
    },
  },
  {
    def: {
      name: 'get_customer',
      description: 'read a customer',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    },
    handler: (args) => JSON.stringify({ id: args.id, name: 'Read Only Corp' }),
  },
]);

beforeAll(async () => {
  db = await createTestDb();
  const def = await createAgentDefinition(db.pool, { name: 'mcp-agent' });
  const ver = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, {
      agentId: def.id, instructions: 'x', modelPolicy: { model: 'none' },
      mcpToolsetRefs: ['crm'],
    }),
  );
  agentVersionId = ver.id;
});
afterAll(async () => {
  await db.drop();
});

async function runningRun(
  grants: { action: string; resource?: string; requiresApproval?: boolean; maxCalls?: number }[],
) {
  const run = await withTransaction(db.pool, (tx) => createRun(tx, { tenantId: 'default', agentVersionId, goal: 'g', grants }));
  const attemptId = newId('att');
  const { rows } = await db.pool.query<RunAttemptRow>(
    `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
     VALUES ($1, $2, 1, 'w', 'ACTIVE', now() + interval '60 seconds') RETURNING *`,
    [attemptId, run.id],
  );
  const running = await withTransaction(db.pool, async (tx) => {
    await transitionRun(tx, run.id, { expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' }, attemptId });
    return transitionRun(tx, run.id, { expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' }, attemptId });
  });
  return { run: running, attempt: rows[0]! };
}

function ctx(
  run: RunRow,
  attempt: RunAttemptRow,
  route: Map<string, McpRouteEntry>,
  credentials?: CredentialProvider,
): ToolContext {
  return {
    pool: db.pool, cfg, run, attempt,
    sandbox: {} as ToolContext['sandbox'],
    sandboxProvider: {} as ToolContext['sandboxProvider'],
    objectStore: {} as ToolContext['objectStore'],
    step: 1, mcp, mcpRoute: route, credentials,
  };
}

describe('MCP toolsets', () => {
  it('namespaces toolset tools into the model tool list', async () => {
    const { defs, route } = await resolveMcpTools(mcp, ['crm']);
    expect(defs.map((d) => d.name)).toEqual([
      'mcp__crm__lookup_customer',
      'mcp__crm__get_customer',
    ]);
    expect(route.get('mcp__crm__lookup_customer')).toEqual({
      toolsetRef: 'crm',
      originalName: 'lookup_customer',
      classification: 'mutation',
    });
    expect(route.get('mcp__crm__get_customer')?.classification).toBe('read');
  });

  it('routes a granted MCP call through the provider', async () => {
    const { route } = await resolveMcpTools(mcp, ['crm']);
    const { run, attempt } = await runningRun([{ action: 'mcp.crm.*' }]);
    const outcome = await dispatchTool(ctx(run, attempt, route), 'mcp__crm__lookup_customer', { id: 'C-1' });
    expect((outcome as { content: string }).content).toContain('Acme Corp');
    const { rows } = await db.pool.query(
      `SELECT 1 FROM run_events
       WHERE run_id = $1 AND type = 'ToolInvocationCommitted'
         AND payload->>'connector' = 'mcp'`,
      [run.id],
    );
    expect(rows).toHaveLength(1);
    const { rows: receipts } = await db.pool.query<{ status: string; reversibility: string }>(
      'SELECT status, reversibility FROM tool_receipts WHERE run_id = $1',
      [run.id],
    );
    expect(receipts).toEqual([{ status: 'COMMITTED', reversibility: 'irreversible' }]);
  });

  it('passes stable idempotency and scoped credentials only to the MCP transport', async () => {
    observedCallContext = null;
    const { route } = await resolveMcpTools(mcp, ['crm']);
    const { run, attempt } = await runningRun([{ action: 'mcp.crm.*' }]);
    const credentials: CredentialProvider = {
      resolve: async (input) => {
        expect(input).toMatchObject({
          tenantId: 'default',
          runId: run.id,
          action: 'mcp.crm.lookup_customer',
          resource: 'crm',
        });
        return { headerName: 'authorization', headerValue: 'transport-secret' };
      },
    };

    await dispatchTool(
      ctx(run, attempt, route, credentials),
      'mcp__crm__lookup_customer',
      { id: 'C-secret' },
    );

    const callContext = observedCallContext as McpCallContext | null;
    expect(callContext).toMatchObject({
      credential: { headerName: 'authorization', headerValue: 'transport-secret' },
    });
    expect(callContext?.idempotencyKey).toHaveLength(64);
    const { rows } = await db.pool.query(
      `SELECT semantic_action AS label, result AS data
       FROM tool_receipts WHERE run_id = $1
       UNION ALL
       SELECT type AS label, payload AS data
       FROM run_events WHERE run_id = $1`,
      [run.id],
    );
    expect(JSON.stringify(rows)).not.toContain('transport-secret');
  });

  it('denies an ungranted MCP call and records ActionDenied', async () => {
    const { route } = await resolveMcpTools(mcp, ['crm']);
    const { run, attempt } = await runningRun([]); // no mcp grant
    const outcome = await dispatchTool(ctx(run, attempt, route), 'mcp__crm__lookup_customer', { id: 'C-2' });
    expect((outcome as { content: string }).content).toMatch(/no capability grant allows mcp.crm.lookup_customer/);
    const { rows } = await db.pool.query(
      `SELECT 1 FROM run_events WHERE run_id = $1 AND type = 'ActionDenied'`,
      [run.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('enforces max_calls by consuming the grant', async () => {
    const { route } = await resolveMcpTools(mcp, ['crm']);
    const { run, attempt } = await runningRun([{ action: 'mcp.crm.*', maxCalls: 1 }]);
    const first = await dispatchTool(ctx(run, attempt, route), 'mcp__crm__lookup_customer', { id: 'A' });
    expect((first as { content: string }).content).toContain('Acme Corp');
    // Second call exhausts the grant → denied (grant was consumed).
    const second = await dispatchTool(ctx(run, attempt, route), 'mcp__crm__lookup_customer', { id: 'B' });
    expect((second as { content: string }).content).toMatch(/no capability grant|reason/i);
  });

  it('suspends for approval on an approval-gated MCP grant, then runs once approved', async () => {
    const { route } = await resolveMcpTools(mcp, ['crm']);
    const { run, attempt } = await runningRun([{ action: 'mcp.crm.*', requiresApproval: true }]);
    const args = { id: 'C-approve' };

    const suspended = await dispatchTool(ctx(run, attempt, route), 'mcp__crm__lookup_customer', args);
    expect(suspended.kind).toBe('suspend_approval');
    expect((await getRun(db.pool, run.id))!.status).toBe('WAITING_APPROVAL');

    // Approve + requeue → back to RUNNING (as the API does).
    const [pending] = await listApprovals(db.pool, run.id, 'PENDING');
    await withTransaction(db.pool, async (tx) => {
      await decideApproval(tx, pending!.id, 'APPROVED', 'tester');
      await transitionRun(tx, run.id, { expectFrom: ['WAITING_APPROVAL'], to: 'QUEUED', event: { type: 'ApprovalReceived' } });
      await transitionRun(tx, run.id, { expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' } });
      await transitionRun(tx, run.id, { expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' } });
    });

    const resumed = (await getRun(db.pool, run.id))!;
    const outcome = await dispatchTool(ctx(resumed, attempt, route), 'mcp__crm__lookup_customer', args);
    expect((outcome as { content: string }).content).toContain('Acme Corp');
  });
});
