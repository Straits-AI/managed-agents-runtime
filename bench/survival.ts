/**
 * The memo §24 survival benchmark: one run must survive worker death,
 * sandbox loss, a long approval wait, and a crash immediately after an
 * irreversible external action — without losing progress or duplicating
 * the action.
 *
 * Requires real BytePlus credentials (ModelArk + veFaaS sandbox + TOS).
 * Run: npm run bench:survival [-- --full-hour]
 *
 * Steps (numbers from the memo):
 *   1  start a repository task
 *   2  execute several model and tool steps
 *   3  commit a workspace checkpoint
 *   4  kill the harness worker (SIGKILL)
 *   5  recover on a new worker
 *   6  kill the sandbox (directly via the provider)
 *   7  reconstruct it from durable workspace state
 *   8  request approval for an external write
 *   9  suspend the run (default 90s; --full-hour for the literal hour)
 *  10  resume after approval
 *  11  perform the action once
 *  12  kill the worker immediately after the external action (fault point)
 *  13  recover without duplicating the action
 *  14  verify the output
 *  15  complete with a full event and artifact history
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, requireConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { VefaasSandboxProvider } from '../src/providers/vefaasSandbox.js';
import { TosObjectStore } from '../src/providers/tosObjectStore.js';
import { startExternalSystem } from './externalSystem.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FULL_HOUR = process.argv.includes('--full-hour');
const APPROVAL_WAIT_MS = FULL_HOUR ? 3_600_000 : 90_000;

const cfg = loadConfig();
requireConfig(cfg, [
  'ARK_API_KEY',
  'ARK_MODEL',
  'BYTEPLUS_ACCESS_KEY_ID',
  'BYTEPLUS_SECRET_ACCESS_KEY',
  'VEFAAS_SANDBOX_FUNCTION_ID',
  'TOS_BUCKET',
]);

const pool = createPool(cfg.DATABASE_URL);
const sandboxProvider = new VefaasSandboxProvider(cfg);
const objectStore = new TosObjectStore(cfg);

let stepNo = 0;
function step(desc: string): void {
  stepNo += 1;
  console.log(`\n[${String(stepNo).padStart(2)}] ${desc}`);
}
function ok(msg: string): void {
  console.log(`     ✓ ${msg}`);
}
function fail(msg: string): never {
  console.error(`     ✗ FAILED: ${msg}`);
  process.exit(1);
}

// --- process helpers -------------------------------------------------------

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
      HARNESS_ENABLE_FAULTS: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(proc);
  return proc;
}
process.on('exit', () => children.forEach((c) => c.kill('SIGKILL')));

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | false | undefined>,
  timeoutMs = 180_000,
  intervalMs = 1000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start > timeoutMs) fail(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// --- API helpers ------------------------------------------------------------

const API = `http://127.0.0.1:${cfg.API_PORT}`;
const AUTH = { authorization: `Bearer ${cfg.API_AUTH_TOKEN}` };

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
  if (!res.ok) fail(`${method} ${path} → HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

interface RunView {
  id: string;
  status: string;
  progress: Record<string, unknown>;
  attempts: { id: string; state: string; sandbox_id: string | null; exit_reason: string | null }[];
}
const getRun = (id: string) => api<RunView>('GET', `/v1/runs/${id}`);
const getEvents = async (id: string) =>
  (await api<{ events: { seq: string; type: string; payload: Record<string, unknown> }[] }>(
    'GET',
    `/v1/runs/${id}/events?afterSeq=0`,
  )).events;

// --- benchmark --------------------------------------------------------------

console.log(`Survival benchmark (approval wait: ${APPROVAL_WAIT_MS / 1000}s)`);

const external = await startExternalSystem();
ok(`external system at ${external.url}`);

const apiProc = spawnProc('src/bin/api.ts');
await waitFor('API server up', async () => {
  try {
    const res = await fetch(`${API}/v1/runs/none`, { headers: AUTH });
    return res.status === 404;
  } catch {
    return false;
  }
}, 30_000);
ok('API server up');

step('start a repository task');
const agent = await api<{ id: string }>('POST', '/v1/agents', {
  name: `bench-agent-${Date.now()}`,
});
const version = await api<{ id: string }>('POST', `/v1/agents/${agent.id}/versions`, {
  instructions:
    'You are a careful software engineer working in a repository at /workspace.',
  modelPolicy: { model: cfg.ARK_MODEL, maxTokens: 4096 },
  verifierPolicy: {
    requiredArtifacts: ['RESULT.md'],
    command: 'node compute.js',
  },
});
const run = await api<{ id: string }>('POST', '/v1/runs', {
  agentVersionId: version.id,
  goal:
    'This repository contains numbers.txt (one integer per line). ' +
    '1) Write compute.js that reads numbers.txt, prints the sum, and exits 0. ' +
    '2) Write RESULT.md containing the sum. ' +
    `3) Register the result by POSTing {"sum": <the sum>} to ${external.url}/results ` +
    'using external_http_request (this needs human approval — request it and wait). ' +
    '4) Then call run_complete with artifacts ["RESULT.md", "compute.js"]. ' +
    'Keep the progress ledger updated as you work.',
  input: {
    files: { 'numbers.txt': '17\n25\n58\n' }, // sum = 100
  },
  maxSteps: 40,
  grants: [
    {
      action: 'external.http.*',
      resource: new URL(external.url).origin,
      requiresApproval: true,
    },
  ],
  debugFaultPoints: ['after_external_commit'],
});
ok(`run ${run.id} created`);

step('execute several model and tool steps (worker 1)');
const worker1 = spawnProc('src/bin/worker.ts', { WORKER_ID: 'bench-worker-1' });
await waitFor('first tool activity', async () =>
  (await getEvents(run.id)).some((e) => e.type === 'ToolInvocationStarted' || e.type === 'ProgressUpdated'),
);
ok('model and tool steps running');

step('commit a workspace checkpoint');
await waitFor('WorkspaceCheckpointed event', async () =>
  (await getEvents(run.id)).some((e) => e.type === 'WorkspaceCheckpointed'),
  300_000,
);
ok('workspace checkpoint committed to TOS');

step('kill the harness worker (SIGKILL)');
worker1.kill('SIGKILL');
ok('worker 1 killed');

step('recover on a new worker');
const worker2 = spawnProc('src/bin/worker.ts', { WORKER_ID: 'bench-worker-2' });
await waitFor('AttemptOrphaned + new attempt', async () => {
  const events = await getEvents(run.id);
  return (
    events.some((e) => e.type === 'AttemptOrphaned') &&
    events.filter((e) => e.type === 'AttemptStarted').length >= 2
  );
}, 120_000);
ok('orphan detected, new attempt started');

step('kill the sandbox directly');
const withSandbox = await waitFor('an active attempt with a sandbox', async () => {
  const r = await getRun(run.id);
  const active = r.attempts.find((a) => a.state === 'ACTIVE' && a.sandbox_id);
  return active ?? null;
}, 120_000);
await sandboxProvider.terminateById(withSandbox.sandbox_id!);
ok(`sandbox ${withSandbox.sandbox_id} killed`);

step('reconstruct the workspace from durable state');
const restoresBefore = (await getEvents(run.id)).filter(
  (e) => e.type === 'WorkspaceRestored',
).length;
await waitFor('WorkspaceRestored on a fresh sandbox', async () => {
  const events = await getEvents(run.id);
  return events.filter((e) => e.type === 'WorkspaceRestored').length > restoresBefore;
}, 300_000);
ok('workspace restored from TOS into a new sandbox');

step('request approval for the external write');
await waitFor('WAITING_APPROVAL', async () => (await getRun(run.id)).status === 'WAITING_APPROVAL', 600_000);
ok('run suspended awaiting approval');

step(`suspend with zero active compute (${APPROVAL_WAIT_MS / 1000}s)`);
{
  const r = await getRun(run.id);
  const active = r.attempts.filter((a) => a.state === 'ACTIVE');
  if (active.length !== 0) fail(`expected 0 ACTIVE attempts, found ${active.length}`);
}
console.log(`     waiting ${APPROVAL_WAIT_MS / 1000}s to prove the suspension is durable...`);
await new Promise((r) => setTimeout(r, APPROVAL_WAIT_MS));
{
  const r = await getRun(run.id);
  if (r.status !== 'WAITING_APPROVAL') fail(`status drifted to ${r.status} during suspension`);
}
ok('suspension held with no active worker');

step('resume after approval');
const approvals = await api<{ approvals: { id: string; status: string }[] }>(
  'GET',
  `/v1/runs/${run.id}/approvals`,
);
const pending = approvals.approvals.find((a) => a.status === 'PENDING');
if (!pending) fail('no pending approval found');
await api('POST', `/v1/runs/${run.id}/approvals/${pending.id}`, {
  decision: 'approve',
  decidedBy: 'benchmark',
});
ok('approved; run requeued');

step('perform the action once (fault point will kill the worker after commit)');
await waitFor('external action received', async () =>
  external.actions().some((a) => a.path === '/results'),
  300_000,
);
ok('external system received the registration');

step('worker killed by fault injection after the external commit');
// The fault point SIGKILLs worker 2 itself — bring up worker 3 to recover.
await waitFor('worker 2 dead from fault injection', async () => worker2.exitCode !== null || worker2.signalCode !== null, 120_000);
spawnProc('src/bin/worker.ts', { WORKER_ID: 'bench-worker-3' });
await waitFor('post-commit crash recovery (new attempt)', async () => {
  const events = await getEvents(run.id);
  const commits = events.filter((e) => e.type === 'ToolInvocationCommitted').length;
  const orphans = events.filter((e) => e.type === 'AttemptOrphaned').length;
  return commits >= 1 && orphans >= 2; // first kill + fault-point kill
}, 300_000);
ok('fault-point crash detected and recovered');

step('recover without duplicating the action');
await waitFor('run progressing after recovery', async () => {
  const r = await getRun(run.id);
  return ['RUNNING', 'VERIFYING', 'COMPLETED'].includes(r.status);
}, 300_000);
{
  const results = external.actions().filter((a) => a.path === '/results');
  if (results.length !== 1) fail(`expected exactly 1 external action, found ${results.length}`);
}
ok('exactly one external action recorded');

step('verify the output');
await waitFor('VerificationPassed or RunCompleted', async () => {
  const events = await getEvents(run.id);
  return events.some((e) => e.type === 'RunCompleted');
}, 600_000);
ok('verification passed');

step('complete with a full event and artifact history');
{
  const r = await getRun(run.id);
  if (r.status !== 'COMPLETED') fail(`final status ${r.status}`);

  const events = await getEvents(run.id);
  const seqs = events.map((e) => Number(e.seq));
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i + 1) fail(`event sequence has a gap at position ${i}: ${seqs[i]}`);
  }

  const completed = events.find((e) => e.type === 'RunCompleted');
  const artifacts = (completed!.payload.artifacts ?? {}) as Record<string, string>;
  const resultKey = artifacts['RESULT.md'];
  if (!resultKey) fail('RESULT.md missing from artifact keys');
  const content = (await objectStore.get(resultKey)).toString('utf8');
  if (!content.includes('100')) fail(`RESULT.md does not contain the sum: ${content.slice(0, 200)}`);

  const { rows } = await pool.query(
    `SELECT status, count(*) AS n FROM tool_receipts WHERE run_id = $1 GROUP BY status`,
    [run.id],
  );
  const unsettled = rows.filter((r2) => !['COMMITTED', 'FAILED'].includes(r2.status as string));
  if (unsettled.length > 0) fail(`unsettled receipts: ${JSON.stringify(rows)}`);

  ok(`gapless ${events.length}-event history, artifact verified in TOS, receipts settled`);
}

console.log('\n══════════════════════════════════════════');
console.log(' SURVIVAL BENCHMARK PASSED (memo §24)');
console.log('══════════════════════════════════════════');

children.forEach((c) => c.kill('SIGTERM'));
await external.close();
await pool.end();
process.exit(0);
