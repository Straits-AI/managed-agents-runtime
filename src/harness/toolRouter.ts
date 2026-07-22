import type { Pool } from 'pg';
import { parseHttpEgressAllowlist, type Config } from '../config.js';
import { isIP } from 'node:net';
import type { RunAttemptRow, RunRow, ProgressLedger } from '../core/types.js';
import type {
  CredentialProvider,
  KnowledgeProvider,
  McpToolProvider,
  McpReconciliationResult,
  McpToolResult,
  MemoryProvider,
  MemoryScope,
  KnowledgeReference,
  ObjectStore,
  SandboxHandle,
  SandboxProvider,
  ToolDef,
} from '../providers/types.js';
import type { McpRouteEntry } from './mcp.js';
import { withTransaction } from '../db/tx.js';
import { appendEvent, transitionRun } from '../core/transition.js';
import { listEvents } from '../store/events.js';
import { spawnChildren } from '../scheduler/children.js';
import {
  buildBoundedRunResult,
  MAX_DELEGATED_ARTIFACT_REFS,
  MAX_DELEGATED_CHILDREN,
  MAX_DELEGATED_GOAL_BYTES,
  type BoundedRunResult,
} from '../core/delegatedResults.js';
import { WORKSPACE_DIR } from './workspace.js';
import { maybeCrash, type FaultPoint } from './faults.js';
import { executeGovernedAction } from './governedAction.js';
import { SafeHttpClient, assertPublicAddress } from '../net/safeHttp.js';

export type ToolOutcome =
  | { kind: 'result'; content: string }
  | { kind: 'suspend_approval'; approvalId: string }
  | { kind: 'suspend_signal'; signalName: string }
  | { kind: 'suspend_children'; childRunIds: string[] }
  | { kind: 'complete'; summary: string; artifacts: string[]; result: BoundedRunResult };

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
  /** Knowledge retrieval + provider-neutral logical reference (optional). */
  knowledge?: KnowledgeProvider;
  knowledgeReference?: KnowledgeReference;
  /** MCP toolsets: provider + name→toolset route for resolved MCP tools. */
  mcp?: McpToolProvider;
  mcpRoute?: Map<string, McpRouteEntry>;
  /** Credential broker: injects scoped secrets into outbound calls (memo §9.5). */
  credentials?: CredentialProvider;
  /** Bounded outbound transport; injectable for connector conformance tests. */
  http?: Pick<SafeHttpClient, 'request'>;
  /** Test seam for crash boundaries; production uses hard-kill fault injection. */
  injectFault?: (point: FaultPoint) => void;
  /** Worker lease/cancellation signal propagated into governed provider calls. */
  signal?: AbortSignal;
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
          maxItems: MAX_DELEGATED_CHILDREN,
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
      'Call an external HTTP API. Non-GET requests are policy-checked, may require human approval, and use a durable idempotency receipt. Exactly-once execution requires the remote API to honor the supplied idempotency key.',
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
        artifacts: {
          type: 'array',
          maxItems: MAX_DELEGATED_ARTIFACT_REFS,
          items: { type: 'string' },
        },
        result: {
          type: 'object',
          description: 'bounded structured completion data for callers and parent agents',
          additionalProperties: true,
        },
      },
      required: ['summary'],
    },
  },
];

export const TOOL_DOCS = TOOL_DEFS.map(
  (t) => `- ${t.name}: ${t.description}`,
).join('\n');

const ACTION_NAME = 'external.http.request';

class McpValidationError extends Error {}

function injectFault(ctx: ToolContext, point: FaultPoint): void {
  if (ctx.injectFault) ctx.injectFault(point);
  else maybeCrash(ctx.cfg, ctx.run, point);
}

async function boundedMcpOperation<T>(
  ctx: ToolContext,
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', abortFromParent, { once: true });
  if (parentSignal.aborted) abortFromParent();
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectOnAbort = () => reject(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('MCP call aborted'),
      );
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      timer = setTimeout(() => {
        controller.abort(
          new Error(`MCP call deadline exceeded (${ctx.cfg.MCP_CALL_TIMEOUT_MS}ms)`),
        );
      }, ctx.cfg.MCP_CALL_TIMEOUT_MS);
      if (controller.signal.aborted) rejectOnAbort();
    });
    if (controller.signal.aborted) return await aborted;
    const value = await Promise.race([
      operation(controller.signal),
      aborted,
    ]);
    return value;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', abortFromParent);
  }
}

async function validateMcpResult(
  value: unknown,
  ctx: ToolContext,
  credential: { headerName: string; headerValue: string } | null,
): Promise<{ content: string; externalTxnId?: string }> {
  if (!value || typeof value !== 'object') {
    throw new McpValidationError('MCP provider returned a malformed result');
  }
  const candidate = value as Record<string, unknown>;
  const stream = candidate.content as AsyncIterable<unknown> | undefined;
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new McpValidationError('MCP provider result content must be an async byte stream');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
      throw new McpValidationError('MCP provider response stream yielded an invalid chunk');
    }
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > ctx.cfg.MCP_MAX_RESPONSE_BYTES) {
      throw new McpValidationError(
        `MCP response byte limit exceeded (${ctx.cfg.MCP_MAX_RESPONSE_BYTES})`,
      );
    }
    chunks.push(buffer);
  }
  const content = Buffer.concat(chunks, bytes).toString('utf8');
  if (
    candidate.externalTxnId !== undefined &&
    typeof candidate.externalTxnId !== 'string'
  ) {
    throw new McpValidationError('MCP provider external transaction ID must be a string');
  }
  const externalTxnId = candidate.externalTxnId as string | undefined;
  if (
    externalTxnId !== undefined &&
    Buffer.byteLength(externalTxnId) > ctx.cfg.MCP_MAX_EXTERNAL_TXN_ID_BYTES
  ) {
    throw new McpValidationError(
      `MCP external transaction ID byte limit exceeded (${ctx.cfg.MCP_MAX_EXTERNAL_TXN_ID_BYTES})`,
    );
  }
  const secret = credential?.headerValue;
  if (
    secret &&
    (content.includes(secret) || externalTxnId?.includes(secret))
  ) {
    throw new McpValidationError(
      'MCP provider response contained scoped credential material',
    );
  }
  return { content, ...(externalTxnId ? { externalTxnId } : {}) };
}

async function validateMcpReconciliation(
  value: unknown,
  ctx: ToolContext,
): Promise<
  | { status: 'committed'; content: string; externalTxnId?: string }
  | { status: 'not_found'; terminal: true }
  | { status: 'unknown' }
> {
  if (!value || typeof value !== 'object') {
    throw new McpValidationError('MCP provider returned a malformed reconciliation result');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.status === 'committed') {
    return { status: 'committed', ...await validateMcpResult(candidate, ctx, null) };
  }
  if (candidate.status === 'not_found' && candidate.terminal === true) {
    return { status: 'not_found', terminal: true };
  }
  if (candidate.status === 'unknown') return { status: 'unknown' };
  throw new McpValidationError('MCP provider returned an invalid reconciliation status');
}

function mcpProviderContext(
  ctx: ToolContext,
  idempotencyKey: string,
  credential: { headerName: string; headerValue: string } | null,
  signal: AbortSignal,
) {
  return {
    idempotencyKey,
    credential,
    signal,
    maxResponseBytes: ctx.cfg.MCP_MAX_RESPONSE_BYTES,
    maxExternalTxnIdBytes: ctx.cfg.MCP_MAX_EXTERNAL_TXN_ID_BYTES,
  };
}

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
      if (!ctx.knowledge || !ctx.knowledgeReference) {
        return { kind: 'result', content: 'error: no knowledge base is configured for this run' };
      }
      const limit = args.limit ? Math.min(20, Number(args.limit)) : 5;
      const evidence = await ctx.knowledge.retrieve({
        tenantId: ctx.run.tenant_id,
        reference: ctx.knowledgeReference,
        query: String(args.query ?? ''),
        limit,
      });
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
      if (artifacts.length > MAX_DELEGATED_ARTIFACT_REFS) {
        return {
          kind: 'result',
          content: `error: run completion supports at most ${MAX_DELEGATED_ARTIFACT_REFS} artifacts`,
        };
      }
      let result: BoundedRunResult;
      try {
        result = buildBoundedRunResult(String(args.summary ?? ''), args.result);
      } catch (err) {
        return { kind: 'result', content: `error: ${(err as Error).message}` };
      }
      return {
        kind: 'complete',
        summary: String(args.summary ?? ''),
        artifacts,
        result,
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
  const outcome = await executeGovernedAction(
    {
      pool: ctx.pool,
      run: ctx.run,
      attempt: ctx.attempt,
      step: ctx.step,
      credentials: ctx.credentials,
      signal: ctx.signal,
    },
    {
      connector: 'mcp',
      purpose: 'mcp.tool_call',
      action,
      resource,
      args,
      classification: entry.classification,
      requireGrant: true,
      recovery:
        entry.classification === 'read' || entry.recovery === 'idempotent'
          ? 'retry_with_idempotency'
          : 'reconcile',
      audit: { mcpRecovery: entry.recovery },
      beforeDispatch: () => injectFault(ctx, 'before_mcp_dispatch'),
      afterDispatch: () => injectFault(ctx, 'after_mcp_remote_commit'),
      afterCommit: () => injectFault(ctx, 'after_mcp_receipt_commit'),
      reconcile: entry.recovery === 'reconcile'
        ? async ({ idempotencyKey, credential, signal: actionSignal }) => {
            const validated = await boundedMcpOperation(ctx, actionSignal, async (signal) => {
              let reconciled: McpReconciliationResult;
              try {
                reconciled = await ctx.mcp!.reconcileTool(
                  entry.toolsetRef,
                  entry.originalName,
                  args,
                  mcpProviderContext(ctx, idempotencyKey, credential, signal),
                );
                return await validateMcpReconciliation(reconciled, ctx);
              } catch (error) {
                if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
                if (error instanceof McpValidationError) throw error;
                throw new Error('MCP provider reconciliation failed');
              }
            });
            if (validated.status !== 'committed') return validated;
            return {
          status: 'committed' as const,
          value: { content: validated.content },
              externalTxnId: validated.externalTxnId,
              audit: { reconciled: true },
            };
          }
        : undefined,
      dispatch: async ({ idempotencyKey, credential, signal: actionSignal }) => {
        const validated = await boundedMcpOperation(ctx, actionSignal, async (signal) => {
          let result: McpToolResult;
          try {
            result = await ctx.mcp!.callTool(
              entry.toolsetRef,
              entry.originalName,
              args,
              mcpProviderContext(ctx, idempotencyKey, credential, signal),
            );
            return await validateMcpResult(result, ctx, credential);
          } catch (error) {
            if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
            if (error instanceof McpValidationError) throw error;
            throw new Error('MCP provider call failed');
          }
        });
        return {
          value: { content: validated.content },
          externalTxnId: validated.externalTxnId,
        };
      },
    },
  );
  if (outcome.kind === 'suspend_approval') return outcome;
  if (outcome.kind === 'denied' || outcome.kind === 'reconciliation_required') {
    return { kind: 'result', content: `error: ${outcome.reason}` };
  }
  return { kind: 'result', content: outcome.value.content };
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
  if (goals.length > MAX_DELEGATED_CHILDREN) {
    return {
      kind: 'result',
      content: `error: delegate supports at most ${MAX_DELEGATED_CHILDREN} subtasks`,
    };
  }
  if (goals.some((goal) => Buffer.byteLength(goal) > MAX_DELEGATED_GOAL_BYTES)) {
    return {
      kind: 'result',
      content: `error: delegated goals must not exceed ${MAX_DELEGATED_GOAL_BYTES} encoded bytes`,
    };
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
        // No parentWorkspaceId in input: the epoch derives the copy-on-write seed
        // from the child's server-set parent_run_id (tenant-checked), so client
        // input can't point a run at another tenant's workspace.
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
      patch: {
        awaited_signal: name,
        awaited_signal_correlation_id: null,
        awaited_signal_schema: { type: 'any' },
      },
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
  const classification = method === 'GET' ? 'read' : 'mutation';
  const http = ctx.http ?? new SafeHttpClient({
    allowedOrigins:
      ctx.cfg.HTTP_EGRESS_MODE === 'allowlist' || ctx.cfg.HTTP_EGRESS_MODE === 'proxy'
        ? parseHttpEgressAllowlist(ctx.cfg.HTTP_EGRESS_ALLOWLIST)
        : [],
    proxyUrl: ctx.cfg.HTTP_EGRESS_MODE === 'proxy'
      ? ctx.cfg.HTTP_EGRESS_PROXY_URL ?? null
      : null,
    connectTimeoutMs: ctx.cfg.HTTP_CONNECT_TIMEOUT_MS,
    totalTimeoutMs: ctx.cfg.HTTP_TOTAL_TIMEOUT_MS,
    maxRedirects: ctx.cfg.HTTP_MAX_REDIRECTS,
    maxResponseBytes: ctx.cfg.HTTP_MAX_RESPONSE_BYTES,
  });
  let privateOrigins: string[] = [];
  const outcome = await executeGovernedAction(
    {
      pool: ctx.pool,
      run: ctx.run,
      attempt: ctx.attempt,
      step: ctx.step,
      credentials: ctx.credentials,
      signal: ctx.signal,
    },
    {
      connector: 'http',
      purpose: 'http.request',
      action: ACTION_NAME,
      resource,
      args,
      classification,
      requireGrant: classification === 'mutation',
      preferExactResourceGrant: true,
      recovery: 'retry_with_idempotency',
      audit: { method },
      validate: ({ usableGrantResourcePatterns }) => {
        privateOrigins = usableGrantResourcePatterns.filter(
          (pattern) => pattern === resource,
        );
        return checkUrlPolicy(url, privateOrigins.length > 0);
      },
      beforeDispatch: () => injectFault(ctx, 'before_external_commit'),
      afterCommit: () => injectFault(ctx, 'after_external_commit'),
      dispatch: async ({ idempotencyKey, credential, signal }) => {
        // Model headers may add metadata, but reserved transport headers and
        // credentials always win and never enter the model-visible args.
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(
          (args.headers as Record<string, string> | undefined) ?? {},
        )) {
          if (![
            'host',
            'content-length',
            'transfer-encoding',
            'authorization',
            'proxy-authorization',
            'cookie',
            'idempotency-key',
            'x-managed-agents-target-url',
            'x-managed-agents-target-address',
            'x-managed-agents-target-family',
          ].includes(name.toLowerCase())) {
            headers[name] = String(value);
          }
        }
        const setHeader = (name: string, value: string) => {
          for (const existing of Object.keys(headers)) {
            if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
          }
          headers[name] = value;
        };
        if (credential) setHeader(credential.headerName, credential.headerValue);
        setHeader('content-type', 'application/json');
        setHeader('idempotency-key', idempotencyKey);

        const response = await http.request({
          url,
          method,
          headers,
          body:
            classification === 'mutation' && args.body !== undefined
              ? JSON.stringify(args.body)
              : undefined,
          privateOrigins,
          signal,
        });
        const externalTxnId = response.headers['x-transaction-id'];
        if (
          externalTxnId !== undefined &&
          Buffer.byteLength(externalTxnId) > ctx.cfg.HTTP_MAX_EXTERNAL_TXN_ID_BYTES
        ) {
          throw new Error(
            `HTTP external transaction ID byte limit exceeded (${ctx.cfg.HTTP_MAX_EXTERNAL_TXN_ID_BYTES})`,
          );
        }
        if (
          credential?.headerValue &&
          (response.body.includes(credential.headerValue) ||
            externalTxnId?.includes(credential.headerValue))
        ) {
          throw new Error('HTTP response contained scoped credential material');
        }
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(response.body);
        } catch {
          parsedBody = response.body.slice(0, 5_000);
        }
        const result = { status: response.status, body: parsedBody };
        return {
          value: result,
          externalTxnId,
          audit: { status: response.status },
        };
      },
    },
  );
  if (outcome.kind === 'suspend_approval') return outcome;
  if (outcome.kind === 'denied' || outcome.kind === 'reconciliation_required') {
    return { kind: 'result', content: `error: ${outcome.reason}` };
  }
  if (outcome.deduplicated) {
    return {
      kind: 'result',
      content: JSON.stringify({
        deduplicated: true,
        note: 'this action was already executed before a recovery; returning the recorded result',
        result: outcome.value,
      }),
    };
  }
  return { kind: 'result', content: JSON.stringify(outcome.value) };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Synchronous validation rejects malformed URLs and obvious private literals
 * before a receipt exists. SafeHttpClient performs authoritative all-answer
 * DNS validation and pins the selected address at dispatch time.
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
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URL userinfo is not allowed' };
  }
  const hostname = parsed.hostname.startsWith('[')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  let privateHost = hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local');
  if (isIP(hostname)) {
    try {
      assertPublicAddress(hostname);
    } catch {
      privateHost = true;
    }
  }
  if (privateHost && !originGranted) {
    return {
      ok: false,
      reason: `requests to private host ${parsed.hostname} require an exact-origin capability grant for ${parsed.origin}`,
    };
  }
  return { ok: true };
}
