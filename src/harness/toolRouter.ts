import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { RunAttemptRow, RunRow, ProgressLedger } from '../core/types.js';
import type {
  KnowledgeProvider,
  McpToolProvider,
  MemoryProvider,
  MemoryScope,
  ObjectStore,
  SandboxHandle,
  SandboxProvider,
  ToolDef,
} from '../providers/types.js';
import type { McpRouteEntry } from './mcp.js';
import { withTransaction } from '../db/tx.js';
import { appendEvent, transitionRun } from '../core/transition.js';
import {
  commitReceipt,
  findReceiptByKey,
  idempotencyKey,
  insertPendingReceipt,
} from '../store/receipts.js';
import { authorizeAndConsume, listGrants, patternMatches } from '../store/grants.js';
import { insertApproval, listApprovals } from '../store/approvals.js';
import { listEvents } from '../store/events.js';
import { spawnChildren } from '../scheduler/children.js';
import { WORKSPACE_DIR } from './workspace.js';
import { maybeCrash } from './faults.js';

export type ToolOutcome =
  | { kind: 'result'; content: string }
  | { kind: 'suspend_approval'; approvalId: string }
  | { kind: 'suspend_signal'; signalName: string }
  | { kind: 'suspend_children'; childRunIds: string[] }
  | { kind: 'complete'; summary: string; artifacts: string[] };

export interface ToolContext {
  pool: Pool;
  cfg: Config;
  run: RunRow;
  attempt: RunAttemptRow;
  sandbox: SandboxHandle;
  sandboxProvider: SandboxProvider;
  objectStore: ObjectStore;
  step: number;
  /** Long-term memory + the scope to write it under (optional). */
  memory?: MemoryProvider;
  memoryScope?: MemoryScope;
  /** Knowledge retrieval + the knowledge base to search (optional). */
  knowledge?: KnowledgeProvider;
  knowledgeBaseId?: string;
  /** MCP toolsets: provider + name→toolset route for resolved MCP tools. */
  mcp?: McpToolProvider;
  mcpRoute?: Map<string, McpRouteEntry>;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'bash_exec',
    description: `Run a bash command in the sandbox. The working directory defaults to ${WORKSPACE_DIR}.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'working directory' },
        timeout_sec: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'file_write',
    description: `Write a file in the sandbox (path relative to ${WORKSPACE_DIR}).`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_read',
    description: `Read a file from the sandbox (path relative to ${WORKSPACE_DIR}).`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'progress_update',
    description:
      'Update your durable progress ledger. Call after completing each meaningful unit of work — this state survives crashes and restarts.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        completed: { type: 'array', items: { type: 'string' } },
        active: { type: 'array', items: { type: 'string' } },
        blocked: {
          type: 'array',
          items: {
            type: 'object',
            properties: { item: { type: 'string' }, reason: { type: 'string' } },
          },
        },
        remaining: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'delegate',
    description:
      'Delegate independent subtasks to child agents that run in PARALLEL. Your run suspends (zero compute) until every child finishes, then resumes with their outcomes so you can merge them. Use for work that splits cleanly; each child gets its own isolated workspace and a share of your remaining token budget.',
    parameters: {
      type: 'object',
      properties: {
        subtasks: {
          type: 'array',
          description: 'the child goals to run in parallel',
          items: {
            type: 'object',
            properties: { goal: { type: 'string' } },
            required: ['goal'],
          },
        },
      },
      required: ['subtasks'],
    },
  },
  {
    name: 'knowledge_search',
    description:
      'Search the agent’s configured knowledge base (enterprise docs, policies, manuals) and get back the most relevant passages with citations. Use to ground your work in authoritative sources rather than guessing.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: 'max passages (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description:
      'Save a durable memory that persists across future runs of this agent — a user preference, a decision and its rationale, a convention, or a reusable fact. Use for things worth recalling next time, NOT for step-by-step progress (use progress_update for that).',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'the fact to remember, self-contained' },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'episodic'],
          description: 'category of memory',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'wait_for_signal',
    description:
      'Pause the run until a named external signal arrives (e.g. a webhook, an upstream job finishing). The run suspends with zero active compute and resumes when POST /v1/runs/{id}/signals delivers a matching signal; the signal payload is returned to you on resume.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'the signal name to wait for' } },
      required: ['name'],
    },
  },
  {
    name: 'external_http_request',
    description:
      'Call an external HTTP API. Non-GET requests are external side effects: they are policy-checked, may require human approval (the run suspends until decided), and are executed exactly once per unique request.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        url: { type: 'string' },
        body: { type: 'object' },
        headers: { type: 'object' },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'run_complete',
    description: `Declare the goal achieved. List the artifact file paths (relative to ${WORKSPACE_DIR}) that constitute your deliverables. Verification runs before completion is accepted.`,
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary'],
    },
  },
];

export const TOOL_DOCS = TOOL_DEFS.map(
  (t) => `- ${t.name}: ${t.description}`,
).join('\n');

const ACTION_NAME = 'external.http.request';

function resolvePath(path: string): string {
  return path.startsWith('/') ? path : `${WORKSPACE_DIR}/${path}`;
}

/**
 * Record a workspace-tool invocation in the run ledger so every step is
 * auditable. External writes keep their richer receipt events
 * (ToolInvocationStarted/Committed); this covers the sandbox-mutating tools
 * that otherwise leave no trace. Payloads carry a bounded, non-secret summary.
 */
async function emitToolInvoked(
  ctx: ToolContext,
  tool: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await withTransaction(ctx.pool, (tx) =>
    appendEvent(
      tx,
      ctx.run.id,
      { type: 'ToolInvoked', payload: { tool, step: ctx.step, ...detail } },
      { attemptId: ctx.attempt.id },
    ),
  );
}

export async function dispatchTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  switch (name) {
    case 'bash_exec': {
      const command = String(args.command ?? '');
      const res = await ctx.sandboxProvider.exec(ctx.sandbox, command, {
        cwd: args.cwd ? String(args.cwd) : WORKSPACE_DIR,
        timeoutSec: args.timeout_sec ? Number(args.timeout_sec) : 300,
      });
      await emitToolInvoked(ctx, 'bash_exec', {
        command: command.slice(0, 500),
        exitCode: res.exitCode,
      });
      return {
        kind: 'result',
        content: JSON.stringify({
          exit_code: res.exitCode,
          stdout: res.stdout.slice(0, 20_000),
          stderr: res.stderr.slice(0, 10_000),
        }),
      };
    }

    case 'file_write': {
      const path = String(args.path ?? '');
      const content = String(args.content ?? '');
      await ctx.sandboxProvider.writeFile(ctx.sandbox, resolvePath(path), content);
      await emitToolInvoked(ctx, 'file_write', { path, bytes: content.length });
      return { kind: 'result', content: `wrote ${path}` };
    }

    case 'file_read': {
      const path = String(args.path ?? '');
      const content = await ctx.sandboxProvider.readFile(ctx.sandbox, resolvePath(path));
      await emitToolInvoked(ctx, 'file_read', { path, bytes: content.length });
      return { kind: 'result', content: content.slice(0, 50_000) };
    }

    case 'progress_update': {
      const ledger = args as ProgressLedger;
      await withTransaction(ctx.pool, (tx) =>
        appendEvent(
          tx,
          ctx.run.id,
          { type: 'ProgressUpdated', payload: { progress: ledger } },
          { attemptId: ctx.attempt.id, patch: { progress: ledger } },
        ),
      );
      return { kind: 'result', content: 'progress ledger updated' };
    }

    case 'remember': {
      const content = String(args.content ?? '').trim();
      if (!content) return { kind: 'result', content: 'error: remember requires content' };
      if (!ctx.memory || !ctx.memoryScope) {
        return { kind: 'result', content: 'error: memory is not configured for this run' };
      }
      await ctx.memory.write(ctx.memoryScope, [
        { content, kind: args.kind ? String(args.kind) : 'fact', runId: ctx.run.id },
      ]);
      await emitToolInvoked(ctx, 'remember', { kind: args.kind ?? 'fact' });
      return { kind: 'result', content: 'saved to long-term memory' };
    }

    case 'knowledge_search': {
      if (!ctx.knowledge || !ctx.knowledgeBaseId) {
        return { kind: 'result', content: 'error: no knowledge base is configured for this run' };
      }
      const limit = args.limit ? Math.min(20, Number(args.limit)) : 5;
      const evidence = await ctx.knowledge.retrieve(
        ctx.knowledgeBaseId,
        String(args.query ?? ''),
        limit,
        ctx.run.tenant_id,
      );
      await emitToolInvoked(ctx, 'knowledge_search', { query: String(args.query ?? '').slice(0, 200), hits: evidence.length });
      return {
        kind: 'result',
        content: JSON.stringify({
          passages: evidence.map((e) => ({ title: e.title, content: e.content, score: e.score })),
        }),
      };
    }

    case 'delegate':
      return delegate(ctx, args);

    case 'wait_for_signal':
      return waitForSignal(ctx, String(args.name ?? ''));

    case 'external_http_request':
      return externalHttpRequest(ctx, args);

    case 'run_complete': {
      const artifacts = Array.isArray(args.artifacts) ? args.artifacts.map(String) : [];
      return {
        kind: 'complete',
        summary: String(args.summary ?? ''),
        artifacts,
      };
    }

    default: {
      const mcpEntry = ctx.mcpRoute?.get(name);
      if (mcpEntry && ctx.mcp) return dispatchMcp(ctx, name, mcpEntry, args);
      return { kind: 'result', content: `error: unknown tool ${name}` };
    }
  }
}

/**
 * Route an MCP tool call through the capability/audit layer (memo §9.2), with
 * the SAME governance as external writes: the call needs a grant matching BOTH
 * `mcp.<toolset>.<tool>` (action) and the toolset (resource); an approval-gated
 * grant suspends the run until a human decides; the grant is consumed
 * (enforcing `max_calls` and expiry); every call is recorded. The model never
 * reaches an MCP tool unpoliced.
 */
async function dispatchMcp(
  ctx: ToolContext,
  _toolName: string,
  entry: McpRouteEntry,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const action = `mcp.${entry.toolsetRef}.${entry.originalName}`;
  const resource = entry.toolsetRef;
  const key = idempotencyKey({ runId: ctx.run.id, action, args });

  // Grant match (no consumption yet — consumption happens at execution).
  const grants = await listGrants(ctx.pool, ctx.run.id);
  const grant = grants.find(
    (g) =>
      patternMatches(g.action_pattern, action) &&
      patternMatches(g.resource_pattern, resource) &&
      (g.max_calls === null || g.calls_used < g.max_calls),
  );
  if (!grant) {
    await withTransaction(ctx.pool, (tx) =>
      appendEvent(tx, ctx.run.id, { type: 'ActionDenied', payload: { action, resource } }, {
        attemptId: ctx.attempt.id,
      }),
    );
    return { kind: 'result', content: `error: no capability grant allows ${action} on ${resource}` };
  }

  // Approval gate: suspend until a human decides, then replay on resume.
  if (grant.requires_approval) {
    const approvals = await listApprovals(ctx.pool, ctx.run.id);
    const match = approvals.find(
      (a) => (a.action.arguments as { __idemKey?: string }).__idemKey === key,
    );
    if (!match) {
      const approvalId = await withTransaction(ctx.pool, async (tx) => {
        const approval = await insertApproval(tx, {
          runId: ctx.run.id,
          attemptId: ctx.attempt.id,
          action: { action, resource, arguments: { ...args, __idemKey: key }, risk: 'external_write' },
        });
        await transitionRun(tx, ctx.run.id, {
          expectFrom: ['RUNNING'],
          to: 'WAITING_APPROVAL',
          event: { type: 'ApprovalRequested', payload: { approvalId: approval.id, action, resource } },
          attemptId: ctx.attempt.id,
        });
        return approval.id;
      });
      return { kind: 'suspend_approval', approvalId };
    }
    if (match.status === 'DENIED') {
      return {
        kind: 'result',
        content: `error: ${action} was denied by ${match.decision_by ?? 'a human'} — do not retry it`,
      };
    }
    if (match.status !== 'APPROVED') {
      return { kind: 'result', content: 'error: approval still pending' };
    }
  }

  // Consume the grant (enforces resource, expiry, max_calls) then execute.
  const auth = await withTransaction(ctx.pool, (tx) =>
    authorizeAndConsume(tx, ctx.run.id, action, resource),
  );
  if (!auth.allowed) {
    return { kind: 'result', content: `error: ${(auth as { reason: string }).reason}` };
  }
  const res = await ctx.mcp!.callTool(entry.toolsetRef, entry.originalName, args);
  await emitToolInvoked(ctx, 'mcp', { action, resource });
  return { kind: 'result', content: res.content };
}

/**
 * Delegate subtasks to parallel child agents (memo §15, §19). First call spawns
 * children (each with an isolated workspace and a share of the parent's
 * remaining token budget) and suspends the parent. On resume — after all
 * children are terminal — returns their outcomes for the parent to merge.
 * Subruns receive no more authority than the parent (grants are NOT inherited
 * by default; a subrun must be granted explicitly).
 */
async function delegate(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  // Resume path: children already spawned → return their resolved outcomes.
  const resolved = (await listEvents(ctx.pool, ctx.run.id)).find(
    (e) => e.type === 'ChildrenResolved',
  );
  if (resolved) {
    const children = (resolved.payload as { children?: unknown[] }).children ?? [];
    return { kind: 'result', content: JSON.stringify({ delegated_results: children }) };
  }

  const subtasks = Array.isArray(args.subtasks) ? args.subtasks : [];
  const goals = subtasks
    .map((s) => (s as { goal?: unknown }).goal)
    .filter((g): g is string => typeof g === 'string' && g.trim().length > 0);
  if (goals.length === 0) {
    return { kind: 'result', content: 'error: delegate requires at least one subtask with a goal' };
  }

  // Carve budget: split the parent's remaining tokens across children.
  let childBudget: number | undefined;
  if (ctx.run.token_budget !== null) {
    const remaining = Math.max(0, Number(ctx.run.token_budget) - Number(ctx.run.tokens_used));
    childBudget = Math.max(1, Math.floor(remaining / goals.length));
  }

  const childRunIds = await withTransaction(ctx.pool, (tx) =>
    spawnChildren(tx, {
      parentRunId: ctx.run.id,
      attemptId: ctx.attempt.id,
      children: goals.map((goal) => ({
        agentVersionId: ctx.run.agent_version_id, // same agent, focused subgoal
        goal,
        tokenBudget: childBudget,
        input: { parentWorkspaceId: ctx.run.workspace_id },
      })),
    }),
  );
  return { kind: 'suspend_children', childRunIds };
}

/**
 * Suspend the run until a named external signal arrives. Idempotent across
 * recovery/resume: if the signal was already delivered (a SignalReceived event
 * exists for this name), return its payload; otherwise record that the run is
 * waiting and transition RUNNING → WAITING_SIGNAL, releasing compute.
 */
async function waitForSignal(ctx: ToolContext, name: string): Promise<ToolOutcome> {
  if (!name) return { kind: 'result', content: 'error: wait_for_signal requires a signal name' };

  const { rows } = await ctx.pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM run_events
     WHERE run_id = $1 AND type = 'SignalReceived' AND payload->>'name' = $2
     ORDER BY seq DESC LIMIT 1`,
    [ctx.run.id, name],
  );
  if (rows[0]) {
    return {
      kind: 'result',
      content: JSON.stringify({ signal: name, payload: rows[0].payload.payload ?? null }),
    };
  }

  await withTransaction(ctx.pool, (tx) =>
    transitionRun(tx, ctx.run.id, {
      expectFrom: ['RUNNING'],
      to: 'WAITING_SIGNAL',
      event: { type: 'SignalReceived', payload: { waiting_for: name } },
      attemptId: ctx.attempt.id,
      patch: { awaited_signal: name },
    }),
  );
  return { kind: 'suspend_signal', signalName: name };
}

/**
 * External side effect with the full memo §18 protocol:
 * capability check → approval gate → PENDING receipt → execute with
 * idempotency key → COMMITTED receipt. Recovery never re-executes a
 * COMMITTED action; a PENDING action is retried with the SAME key so the
 * receiver can dedupe.
 */
async function externalHttpRequest(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const method = String(args.method ?? 'GET').toUpperCase();
  const url = String(args.url ?? '');
  const resource = safeOrigin(url);
  const isWrite = method !== 'GET';
  const idemKey = idempotencyKey({ runId: ctx.run.id, action: ACTION_NAME, args });

  // SSRF guard: only http(s), and private/loopback/link-local hosts are
  // reachable only when a capability grant explicitly covers the origin —
  // GETs must not become an ungated probe into the worker's network.
  const grants0 = await listGrants(ctx.pool, ctx.run.id);
  const originGranted = grants0.some(
    (g) =>
      patternMatches(g.action_pattern, ACTION_NAME) &&
      patternMatches(g.resource_pattern, resource),
  );
  const urlPolicy = checkUrlPolicy(url, originGranted);
  if (!urlPolicy.ok) {
    return { kind: 'result', content: `error: ${urlPolicy.reason}` };
  }

  // Recovery dedupe: an already-committed identical action returns its
  // recorded result — the external effect happened exactly once.
  const existing = await findReceiptByKey(ctx.pool, ctx.run.id, idemKey);
  if (existing?.status === 'COMMITTED') {
    return {
      kind: 'result',
      content: JSON.stringify({
        deduplicated: true,
        note: 'this action was already executed before a recovery; returning the recorded result',
        result: existing.result,
      }),
    };
  }

  if (isWrite) {
    // Grant match (no consumption yet — consumption happens at execution).
    const grants = await listGrants(ctx.pool, ctx.run.id);
    const grant = grants.find(
      (g) =>
        patternMatches(g.action_pattern, ACTION_NAME) &&
        patternMatches(g.resource_pattern, resource) &&
        (g.max_calls === null || g.calls_used < g.max_calls),
    );
    if (!grant) {
      await withTransaction(ctx.pool, (tx) =>
        appendEvent(
          tx,
          ctx.run.id,
          { type: 'ActionDenied', payload: { action: ACTION_NAME, resource } },
          { attemptId: ctx.attempt.id },
        ),
      );
      return {
        kind: 'result',
        content: `error: no capability grant allows ${ACTION_NAME} on ${resource}`,
      };
    }

    if (grant.requires_approval) {
      const approvals = await listApprovals(ctx.pool, ctx.run.id);
      const match = approvals.find(
        (a) => (a.action.arguments as { __idemKey?: string }).__idemKey === idemKey,
      );
      if (!match) {
        // Suspend: approval row + WAITING_APPROVAL, sandbox released by
        // the epoch. Checkpointing happens in the epoch before returning.
        const approvalId = await withTransaction(ctx.pool, async (tx) => {
          const approval = await insertApproval(tx, {
            runId: ctx.run.id,
            attemptId: ctx.attempt.id,
            action: {
              action: ACTION_NAME,
              resource,
              arguments: { ...args, __idemKey: idemKey },
              risk: 'external_write',
            },
          });
          await transitionRun(tx, ctx.run.id, {
            expectFrom: ['RUNNING'],
            to: 'WAITING_APPROVAL',
            event: {
              type: 'ApprovalRequested',
              payload: { approvalId: approval.id, action: ACTION_NAME, resource },
            },
            attemptId: ctx.attempt.id,
          });
          return approval.id;
        });
        return { kind: 'suspend_approval', approvalId };
      }
      if (match.status === 'DENIED') {
        return {
          kind: 'result',
          content: `error: this action was denied by ${match.decision_by ?? 'a human'} — do not retry it; adapt your plan`,
        };
      }
      if (match.status !== 'APPROVED') {
        return { kind: 'result', content: 'error: approval still pending' };
      }
    }
  }

  // Execute with the durable receipt protocol.
  const receipt =
    existing ??
    (await withTransaction(ctx.pool, async (tx) => {
      const auth = await authorizeAndConsume(tx, ctx.run.id, ACTION_NAME, resource);
      if (isWrite && !auth.allowed) {
        throw new Error(`capability disappeared: ${(auth as { reason: string }).reason}`);
      }
      const r = await insertPendingReceipt(tx, {
        runId: ctx.run.id,
        attemptId: ctx.attempt.id,
        step: ctx.step,
        action: ACTION_NAME,
        args,
        idempotencyKey: idemKey,
        reversibility: isWrite ? 'irreversible' : 'reversible',
      });
      await appendEvent(
        tx,
        ctx.run.id,
        {
          type: 'ToolInvocationStarted',
          payload: { receiptId: r.id, action: ACTION_NAME, resource, method },
        },
        { attemptId: ctx.attempt.id },
      );
      return r;
    }));

  maybeCrash(ctx.cfg, ctx.run, 'before_external_commit');

  // Model-supplied headers may add auth etc., but must never override the
  // reserved headers — the idempotency key in particular is what makes the
  // action exactly-once, so ours are applied last.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(
    (args.headers as Record<string, string> | undefined) ?? {},
  )) {
    if (!['host', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) {
      headers[k] = String(v);
    }
  }
  headers['content-type'] = 'application/json';
  headers['idempotency-key'] = idemKey;

  const response = await fetch(url, {
    method,
    headers,
    body: isWrite && args.body !== undefined ? JSON.stringify(args.body) : undefined,
  });
  const text = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    parsedBody = text.slice(0, 5_000);
  }
  const result = { status: response.status, body: parsedBody };

  await withTransaction(ctx.pool, async (tx) => {
    await commitReceipt(tx, receipt.id, {
      externalTxnId: response.headers.get('x-transaction-id') ?? undefined,
      result,
    });
    await appendEvent(
      tx,
      ctx.run.id,
      {
        type: 'ToolInvocationCommitted',
        payload: { receiptId: receipt.id, status: response.status },
      },
      { attemptId: ctx.attempt.id },
    );
  });

  maybeCrash(ctx.cfg, ctx.run, 'after_external_commit');

  return { kind: 'result', content: JSON.stringify(result) };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const PRIVATE_HOST_RE =
  /^(localhost|.*\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?fe80:.*|\[?f[cd][0-9a-f]{2}:.*)$/i;

/**
 * Hostname-level SSRF policy (a pragmatic prototype guard — it does not
 * defend against DNS rebinding): http(s) only, and private/loopback/
 * link-local hosts require an explicit capability grant for the origin.
 */
function checkUrlPolicy(
  url: string,
  originGranted: boolean,
): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid URL: ${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${parsed.protocol} is not allowed` };
  }
  if (PRIVATE_HOST_RE.test(parsed.hostname) && !originGranted) {
    return {
      ok: false,
      reason: `requests to private host ${parsed.hostname} require an explicit capability grant for ${parsed.origin}`,
    };
  }
  return { ok: true };
}
