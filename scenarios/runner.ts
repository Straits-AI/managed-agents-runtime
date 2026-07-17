/**
 * Real-world scenario runner for the Managed Agents runtime.
 *
 * Drives one agent run end-to-end against the live BytePlus stack (API +
 * worker, real epoch) and captures a structured result for tutorial/course
 * material: the full event timeline, artifacts, tool receipts, timings, and
 * token usage.
 *
 *   node --env-file=.env --import tsx scenarios/run.ts <scenario-id>
 *
 * Results are written to scenarios/results/<id>.{json,md}.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig, requireConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { TosObjectStore } from '../src/providers/tosObjectStore.js';
import { startExternalSystem, type ExternalSystem } from '../bench/externalSystem.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(ROOT, 'scenarios', 'results');

export interface Grant {
  action: string;
  resource?: string;
  requiresApproval?: boolean;
  maxCalls?: number;
}

export interface Scenario {
  id: string;
  title: string;
  /** The platform capability this scenario demonstrates, for course material. */
  teaches: string;
  instructions: string;
  goal: string;
  seedFiles?: Record<string, string>;
  grants?: Grant[];
  maxSteps?: number;
  verifierPolicy?: Record<string, unknown>;
  /** Auto-approve the first pending approval (demonstrates the approval loop). */
  autoApprove?: boolean;
  /** Start a local external HTTP endpoint and expose its URL as {{EXTERNAL}}. */
  externalSystem?: boolean;
  /** Wall-clock ceiling before the scenario is declared timed out. */
  timeoutMs?: number;
}

interface EventRow {
  seq: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const cfg = loadConfig();
requireConfig(cfg, [
  'ARK_API_KEY',
  'ARK_MODEL',
  'TOS_BUCKET',
  'VEFAAS_SANDBOX_FUNCTION_ID',
  'SANDBOX_GATEWAY_API_KEY',
]);

const API = `http://127.0.0.1:${cfg.API_PORT}`;
const AUTH = { authorization: `Bearer ${cfg.API_AUTH_TOKEN}` };
const pool = createPool(cfg.DATABASE_URL);
const objectStore = new TosObjectStore(cfg);

const children: ChildProcess[] = [];
function spawnProc(script: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const proc = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKER_EPOCH: 'real',
      LEASE_TTL_MS: '15000',
      HEARTBEAT_MS: '5000',
      POLL_MS: '1000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => process.env.SCENARIO_DEBUG && process.stdout.write(String(d)));
  proc.stderr!.on('data', (d) => process.env.SCENARIO_DEBUG && process.stderr.write(String(d)));
  children.push(proc);
  return proc;
}

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function getEvents(runId: string): Promise<EventRow[]> {
  const { events } = await api<{ events: EventRow[] }>(
    'GET',
    `/v1/runs/${runId}/events?afterSeq=0`,
  );
  return events;
}

async function waitFor<T>(
  fn: () => Promise<T | null | false | undefined>,
  timeoutMs: number,
  intervalMs = 1500,
): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function runScenario(scenario: Scenario): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const startedAt = Date.now();
  const timeoutMs = scenario.timeoutMs ?? 600_000;
  console.log(`\n▶ ${scenario.id}: ${scenario.title}`);

  let external: ExternalSystem | undefined;
  if (scenario.externalSystem) {
    external = await startExternalSystem();
    console.log(`  external system: ${external.url}`);
  }
  const subst = (s: string) => (external ? s.replaceAll('{{EXTERNAL}}', external.url) : s);

  const apiProc = spawnProc('src/bin/api.ts');
  const apiUp = await waitFor(async () => {
    try {
      return (await fetch(`${API}/v1/runs/none`, { headers: AUTH })).status === 404;
    } catch {
      return false;
    }
  }, 30_000);
  if (!apiUp) throw new Error('API did not come up');

  // Create agent + version + run.
  const agent = await api<{ id: string }>('POST', '/v1/agents', {
    name: `${scenario.id}-${Date.now()}`,
  });
  const version = await api<{ id: string }>('POST', `/v1/agents/${agent.id}/versions`, {
    instructions: subst(scenario.instructions),
    modelPolicy: { model: cfg.ARK_MODEL, maxTokens: 4096 },
    ...(scenario.verifierPolicy ? { verifierPolicy: scenario.verifierPolicy } : {}),
  });
  const run = await api<{ id: string }>('POST', '/v1/runs', {
    agentVersionId: version.id,
    goal: subst(scenario.goal),
    input: scenario.seedFiles ? { files: scenario.seedFiles } : undefined,
    maxSteps: scenario.maxSteps ?? 30,
    grants: scenario.grants?.map((g) => ({ ...g, resource: g.resource && subst(g.resource) })),
  });
  console.log(`  run ${run.id} created; starting worker`);

  spawnProc('src/bin/worker.ts', { WORKER_ID: `${scenario.id}-worker` });

  // Drive to terminal, auto-approving if the scenario opts in.
  let approvedAt: number | null = null;
  const terminal = await waitFor(async () => {
    const r = await api<{ status: string }>('GET', `/v1/runs/${run.id}`);
    if (scenario.autoApprove && r.status === 'WAITING_APPROVAL' && !approvedAt) {
      const { approvals } = await api<{ approvals: { id: string; status: string }[] }>(
        'GET',
        `/v1/runs/${run.id}/approvals`,
      );
      const pending = approvals.find((a) => a.status === 'PENDING');
      if (pending) {
        await api('POST', `/v1/runs/${run.id}/approvals/${pending.id}`, {
          decision: 'approve',
          decidedBy: 'scenario-runner',
        });
        approvedAt = Date.now();
        console.log(`  approved ${pending.id}; run resuming`);
      }
    }
    return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(r.status) ? r.status : null;
  }, timeoutMs);

  const finalRun = await api<{
    status: string;
    attempts: { state: string; sandbox_id: string | null; exit_reason: string | null }[];
  }>('GET', `/v1/runs/${run.id}`);
  const events = await getEvents(run.id);

  // Artifacts from the run-complete event, fetched out of TOS.
  const completed = events.find((e) => e.type === 'RunCompleted');
  const artifactKeys = (completed?.payload.artifacts ?? {}) as Record<string, string>;
  const artifacts: Record<string, string> = {};
  for (const [name, key] of Object.entries(artifactKeys)) {
    try {
      artifacts[name] = (await objectStore.get(key)).toString('utf8');
    } catch (err) {
      artifacts[name] = `<<could not fetch: ${(err as Error).message}>>`;
    }
  }

  // Tool receipts + token usage.
  const { rows: receipts } = await pool.query(
    `SELECT semantic_action, status, reversibility FROM tool_receipts WHERE run_id = $1 ORDER BY started_at`,
    [run.id],
  );
  const usage = events
    .filter((e) => e.type === 'ModelInvocationCompleted')
    .reduce(
      (acc, e) => {
        const u = (e.payload.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
        acc.inputTokens += u.inputTokens ?? 0;
        acc.outputTokens += u.outputTokens ?? 0;
        acc.calls += 1;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, calls: 0 },
    );

  const durationMs = Date.now() - startedAt;
  const result = {
    id: scenario.id,
    title: scenario.title,
    teaches: scenario.teaches,
    status: terminal ?? `TIMED_OUT (${finalRun.status})`,
    durationMs,
    goal: subst(scenario.goal),
    seedFiles: scenario.seedFiles ?? {},
    grants: scenario.grants ?? [],
    eventTimeline: events.map((e) => ({ seq: Number(e.seq), type: e.type, at: e.created_at })),
    eventCounts: events.reduce<Record<string, number>>((a, e) => {
      a[e.type] = (a[e.type] ?? 0) + 1;
      return a;
    }, {}),
    attempts: finalRun.attempts,
    approvals: scenario.autoApprove
      ? (await api<{ approvals: unknown[] }>('GET', `/v1/runs/${run.id}/approvals`)).approvals
      : [],
    externalActions: external ? external.actions() : [],
    toolReceipts: receipts,
    tokenUsage: usage,
    artifacts,
  };

  writeFileSync(join(RESULTS_DIR, `${scenario.id}.json`), JSON.stringify(result, null, 2));
  writeFileSync(join(RESULTS_DIR, `${scenario.id}.md`), renderMarkdown(result));

  console.log(
    `  ${result.status} in ${(durationMs / 1000).toFixed(0)}s — ` +
      `${events.length} events, ${Object.keys(artifacts).length} artifacts, ` +
      `${usage.calls} model calls (${usage.inputTokens}/${usage.outputTokens} tok)`,
  );

  children.forEach((c) => c.kill('SIGTERM'));
  if (external) await external.close();
  await pool.end();
  process.exit(terminal === 'COMPLETED' ? 0 : 1);
}

function renderMarkdown(r: {
  id: string;
  title: string;
  teaches: string;
  status: string;
  durationMs: number;
  goal: string;
  seedFiles: Record<string, string>;
  grants: Grant[];
  eventTimeline: { seq: number; type: string; at: string }[];
  eventCounts: Record<string, number>;
  attempts: { state: string; sandbox_id: string | null; exit_reason: string | null }[];
  externalActions: unknown[];
  toolReceipts: { semantic_action: string; status: string; reversibility: string }[];
  tokenUsage: { inputTokens: number; outputTokens: number; calls: number };
  artifacts: Record<string, string>;
}): string {
  const lines: string[] = [];
  lines.push(`# ${r.title}`, '');
  lines.push(`**Scenario id:** \`${r.id}\`  `);
  lines.push(`**Teaches:** ${r.teaches}  `);
  lines.push(`**Result:** ${r.status} in ${(r.durationMs / 1000).toFixed(0)}s  `);
  lines.push(
    `**Model usage:** ${r.tokenUsage.calls} calls, ${r.tokenUsage.inputTokens} in / ${r.tokenUsage.outputTokens} out tokens`,
    '',
  );

  lines.push('## Goal given to the agent', '', '```', r.goal, '```', '');

  if (Object.keys(r.seedFiles).length) {
    lines.push('## Seed files', '');
    for (const [name, content] of Object.entries(r.seedFiles)) {
      lines.push(`\`${name}\`:`, '```', content.slice(0, 800), '```', '');
    }
  }

  if (r.grants.length) {
    lines.push('## Capability grants', '');
    for (const g of r.grants) {
      lines.push(
        `- \`${g.action}\`${g.resource ? ` on \`${g.resource}\`` : ''}` +
          `${g.requiresApproval ? ' — **requires human approval**' : ''}`,
      );
    }
    lines.push('');
  }

  lines.push('## Event timeline', '', '| seq | event |', '| --- | --- |');
  for (const e of r.eventTimeline) lines.push(`| ${e.seq} | ${e.type} |`);
  lines.push('');

  lines.push('## Event summary', '', '| event | count |', '| --- | --- |');
  for (const [t, n] of Object.entries(r.eventCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${t} | ${n} |`);
  }
  lines.push('');

  if (r.toolReceipts.length) {
    lines.push('## Side-effect receipts (exactly-once ledger)', '');
    lines.push('| action | status | reversibility |', '| --- | --- | --- |');
    for (const t of r.toolReceipts) {
      lines.push(`| ${t.semantic_action} | ${t.status} | ${t.reversibility} |`);
    }
    lines.push('');
  }

  if (r.externalActions.length) {
    lines.push('## External side effects recorded', '');
    lines.push('```json', JSON.stringify(r.externalActions, null, 2), '```', '');
  }

  lines.push('## Attempts (execution epochs)', '');
  lines.push('| state | sandbox | exit reason |', '| --- | --- | --- |');
  for (const a of r.attempts) {
    lines.push(`| ${a.state} | ${a.sandbox_id ?? '-'} | ${a.exit_reason ?? '-'} |`);
  }
  lines.push('');

  if (Object.keys(r.artifacts).length) {
    lines.push('## Artifacts produced', '');
    for (const [name, content] of Object.entries(r.artifacts)) {
      lines.push(`### \`${name}\``, '```', content.slice(0, 2000), '```', '');
    }
  }

  return lines.join('\n');
}

process.on('exit', () => children.forEach((c) => c.kill('SIGKILL')));
