import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from './helpers/db.js';
import { spawnWorker, waitFor, type SpawnedWorker } from './helpers/worker.js';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { countActiveAttempts } from '../src/store/attempts.js';
import type { ScriptOp } from '../src/harness/scriptedEpoch.js';

let db: TestDb;
let app: FastifyInstance;
const workers: SpawnedWorker[] = [];
const AUTH = { authorization: 'Bearer test-token' };

beforeAll(async () => {
  db = await createTestDb();
  const cfg = loadConfig({
    ...process.env,
    DATABASE_URL: db.url,
    API_AUTH_TOKEN: 'test-token',
  });
  app = buildServer({ pool: db.pool, cfg });
});

afterAll(async () => {
  while (workers.length > 0) await workers.pop()!.stop();
  await app.close();
  await db.drop();
});

async function createAgentVersionViaApi(): Promise<string> {
  const agentRes = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: AUTH,
    payload: { name: `api-agent-${Math.random().toString(36).slice(2)}` },
  });
  expect(agentRes.statusCode).toBe(201);
  const agent = agentRes.json();

  const verRes = await app.inject({
    method: 'POST',
    url: `/v1/agents/${agent.id}/versions`,
    headers: AUTH,
    payload: { instructions: 'scripted', modelPolicy: { model: 'none' } },
  });
  expect(verRes.statusCode).toBe(201);
  return verRes.json().id;
}

async function createRunViaApi(
  agentVersionId: string,
  script: ScriptOp[],
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/runs',
    headers: AUTH,
    payload: { agentVersionId, goal: 'api test run', input: { script } },
  });
  expect(res.statusCode).toBe(201);
  const run = res.json();
  expect(run.status).toBe('QUEUED');
  return run.id;
}

async function getRunViaApi(runId: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers: AUTH });
  return res.json();
}

describe('API', () => {
  it('rejects requests without the bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/runs/run_x' });
    expect(res.statusCode).toBe(401);
  });

  it('creates agents, versions, runs; serves ordered events', async () => {
    const versionId = await createAgentVersionViaApi();
    const runId = await createRunViaApi(versionId, [{ op: 'complete' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/events`,
      headers: AUTH,
    });
    const { events } = res.json();
    expect(events.map((e: { type: string }) => e.type)).toEqual([
      'RunCreated',
      'RunQueued',
    ]);
    expect(events.map((e: { seq: string }) => Number(e.seq))).toEqual([1, 2]);
  });

  it('rejects fault injection unless HARNESS_ENABLE_FAULTS=1', async () => {
    const versionId = await createAgentVersionViaApi();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: AUTH,
      payload: {
        agentVersionId: versionId,
        goal: 'x',
        debugFaultPoints: ['after_external_commit'],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('appends user messages as events', async () => {
    const versionId = await createAgentVersionViaApi();
    const runId = await createRunViaApi(versionId, [{ op: 'complete' }]);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/messages`,
      headers: AUTH,
      payload: { message: 'please hurry' },
    });
    expect(res.statusCode).toBe(202);
    const events = (
      await app.inject({
        method: 'GET',
        url: `/v1/runs/${runId}/events`,
        headers: AUTH,
      })
    ).json().events;
    expect(events.at(-1).type).toBe('UserMessageReceived');
  });

  it('delivers a signal and reports whether it woke the run', async () => {
    const versionId = await createAgentVersionViaApi();
    const runId = await createRunViaApi(versionId, [{ op: 'complete' }]);
    // Run is QUEUED (not waiting) — signal is recorded but wakes nothing.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/signals`,
      headers: AUTH,
      payload: { name: 'webhook.received', payload: { id: 42 } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ delivered: true, woke: false });

    const events = (
      await app.inject({ method: 'GET', url: `/v1/runs/${runId}/events`, headers: AUTH })
    ).json().events;
    const sig = events.find((e: { type: string }) => e.type === 'SignalReceived');
    expect(sig.payload).toMatchObject({ name: 'webhook.received', payload: { id: 42 } });
  });

  it('accepts a scheduledFor future run and leaves it QUEUED (not started)', async () => {
    const versionId = await createAgentVersionViaApi();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: AUTH,
      payload: {
        agentVersionId: versionId,
        goal: 'scheduled',
        input: { script: [{ op: 'complete' }] },
        scheduledFor: future,
      },
    });
    expect(res.statusCode).toBe(201);
    const run = res.json();
    expect(run.status).toBe('QUEUED');
    expect(run.scheduled_for).toBeTruthy();
  });

  it('cancels a queued run and conflicts on double-cancel', async () => {
    const versionId = await createAgentVersionViaApi();
    const runId = await createRunViaApi(versionId, [{ op: 'complete' }]);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/cancel`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');

    const again = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/cancel`,
      headers: AUTH,
    });
    expect(again.statusCode).toBe(409);
  });

  it('suspends on approval with zero active attempts, resumes on approve (benchmark steps 8-10)', async () => {
    const versionId = await createAgentVersionViaApi();
    const runId = await createRunViaApi(versionId, [
      { op: 'progress', note: 'before approval' },
      {
        op: 'requestApproval',
        action: {
          action: 'external.http.post',
          resource: 'https://example.com/deploy',
          arguments: {},
          risk: 'external_write',
        },
      },
      { op: 'progress', note: 'after approval' },
      { op: 'complete' },
    ]);

    workers.push(spawnWorker(db.url));

    // Run suspends...
    await waitFor(
      async () => ((await getRunViaApi(runId)).status === 'WAITING_APPROVAL' ? true : null),
      { label: 'WAITING_APPROVAL' },
    );
    // ...with NO active attempt holding compute (memo §12).
    await waitFor(
      async () => ((await countActiveAttempts(db.pool, runId)) === 0 ? true : null),
      { label: 'zero active attempts' },
    );

    const approvals = (
      await app.inject({
        method: 'GET',
        url: `/v1/runs/${runId}/approvals`,
        headers: AUTH,
      })
    ).json().approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe('PENDING');

    const decide = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/approvals/${approvals[0].id}`,
      headers: AUTH,
      payload: { decision: 'approve', decidedBy: 'tester' },
    });
    expect(decide.statusCode).toBe(200);
    expect(decide.json().status).toBe('APPROVED');

    // Deciding twice conflicts.
    const twice = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/approvals/${approvals[0].id}`,
      headers: AUTH,
      payload: { decision: 'deny' },
    });
    expect(twice.statusCode).toBe(409);

    // The run reaches COMPLETED inside the epoch's transaction; the final
    // attempt's EXITED/completed bookkeeping lands a moment later in
    // settleAttempt. Wait for both to settle before asserting on the attempt.
    const done = await waitFor(
      async () => {
        const r = await getRunViaApi(runId);
        return r.status === 'COMPLETED' && r.attempts[1]?.exit_reason === 'completed' ? r : null;
      },
      { timeoutMs: 30_000, label: 'resumed run COMPLETED' },
    );

    // Two attempts: one suspended for approval, one resumed to completion.
    expect(done.attempts.length).toBe(2);
    expect(done.attempts[0].exit_reason).toBe('suspended_for_approval');
    expect(done.attempts[1].exit_reason).toBe('completed');

    const events = (
      await app.inject({
        method: 'GET',
        url: `/v1/runs/${runId}/events`,
        headers: AUTH,
      })
    ).json().events;
    const types = events.map((e: { type: string }) => e.type);
    expect(types).toContain('ApprovalRequested');
    expect(types).toContain('ApprovalReceived');
    expect(types.filter((t: string) => t === 'ProgressUpdated')).toHaveLength(2);
  }, 60_000);

  it('long-polls events', async () => {
    const versionId = await createAgentVersionViaApi();
    const runId = await createRunViaApi(versionId, [{ op: 'complete' }]);

    const start = Date.now();
    const pollPromise = app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/events?afterSeq=2&wait=10000`,
      headers: AUTH,
    });
    // Worker produces events while the poll is parked.
    setTimeout(() => workers.push(spawnWorker(db.url)), 300);

    const res = await pollPromise;
    const { events } = res.json();
    expect(events.length).toBeGreaterThan(0);
    expect(Number(events[0].seq)).toBe(3);
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 30_000);

  it('forks a run and resumes it from the source checkpoint step', async () => {
    const versionId = await createAgentVersionViaApi();
    const sourceId = await createRunViaApi(versionId, [
      { op: 'progress', note: 's0' }, // step 0 — before the checkpoint
      { op: 'checkpoint' }, // step 1 — checkpoint captures step=2
      { op: 'progress', note: 's1' }, // step 2 — after the checkpoint
      { op: 'complete' },
    ]);
    workers.push(spawnWorker(db.url));
    await waitFor(
      async () => ((await getRunViaApi(sourceId)).status === 'COMPLETED' ? true : null),
      { label: 'source COMPLETED' },
    );

    const forkRes = await app.inject({
      method: 'POST',
      url: `/v1/runs/${sourceId}/fork`,
      headers: AUTH,
      payload: {},
    });
    expect(forkRes.statusCode).toBe(201);
    const fork = forkRes.json();
    expect(fork.forked_from_run_id).toBe(sourceId);
    expect(fork.status).toBe('QUEUED');
    expect(fork.input.parentWorkspaceId).toBeTruthy(); // copy-on-write seed
    expect(fork.input.forkFrom.step).toBe(2);

    await waitFor(
      async () => ((await getRunViaApi(fork.id)).status === 'COMPLETED' ? true : null),
      { label: 'fork COMPLETED', timeoutMs: 30_000 },
    );
    const events = (
      await app.inject({ method: 'GET', url: `/v1/runs/${fork.id}/events`, headers: AUTH })
    ).json().events;
    const notes = events
      .filter((e: { type: string }) => e.type === 'ProgressUpdated')
      .map((e: { payload: { note: string } }) => e.payload.note);
    // Resumed from step 2: ran 's1' but NOT the pre-checkpoint 's0'.
    expect(notes).toContain('s1');
    expect(notes).not.toContain('s0');
  }, 60_000);
});
