import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { listApprovals, decideApproval } from '../src/store/approvals.js';
import { transitionRun } from '../src/core/transition.js';
import { dispatchTool, type ToolContext } from '../src/harness/toolRouter.js';
import { RegistryMcpProvider } from '../src/providers/registryMcp.js';
import { resolveMcpTools } from '../src/harness/mcp.js';
import { loadConfig } from '../src/config.js';
import { newId } from '../src/ids.js';
import type { RunAttemptRow, RunRow } from '../src/core/types.js';

let db: TestDb;
let agentVersionId: string;
const cfg = loadConfig();

const mcp = new RegistryMcpProvider().registerToolset('crm', [
  {
    def: { name: 'lookup_customer', description: 'find a customer', parameters: { type: 'object', properties: { id: { type: 'string' } } } },
    handler: (args) => JSON.stringify({ id: args.id, name: 'Acme Corp' }),
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
  const run = await withTransaction(db.pool, (tx) => createRun(tx, { agentVersionId, goal: 'g', grants }));
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

function ctx(run: RunRow, attempt: RunAttemptRow, route: Map<string, { toolsetRef: string; originalName: string }>): ToolContext {
  return {
    pool: db.pool, cfg, run, attempt,
    sandbox: {} as ToolContext['sandbox'],
    sandboxProvider: {} as ToolContext['sandboxProvider'],
    objectStore: {} as ToolContext['objectStore'],
    step: 1, mcp, mcpRoute: route,
  };
}

describe('MCP toolsets', () => {
  it('namespaces toolset tools into the model tool list', async () => {
    const { defs, route } = await resolveMcpTools(mcp, ['crm']);
    expect(defs.map((d) => d.name)).toEqual(['mcp__crm__lookup_customer']);
    expect(route.get('mcp__crm__lookup_customer')).toEqual({ toolsetRef: 'crm', originalName: 'lookup_customer' });
  });

  it('routes a granted MCP call through the provider', async () => {
    const { route } = await resolveMcpTools(mcp, ['crm']);
    const { run, attempt } = await runningRun([{ action: 'mcp.crm.*' }]);
    const outcome = await dispatchTool(ctx(run, attempt, route), 'mcp__crm__lookup_customer', { id: 'C-1' });
    expect((outcome as { content: string }).content).toContain('Acme Corp');
    const { rows } = await db.pool.query(
      `SELECT 1 FROM run_events WHERE run_id = $1 AND type = 'ToolInvoked' AND payload->>'tool' = 'mcp'`,
      [run.id],
    );
    expect(rows).toHaveLength(1);
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
