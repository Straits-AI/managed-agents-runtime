const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:8080';
const token = process.env.API_AUTH_TOKEN;

if (!token) throw new Error('API_AUTH_TOKEN is required');

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...options.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned ${response.status}: ${text}`);
  }
  return body;
}

async function waitForReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
    } catch {
      // The API may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('runtime API did not become ready');
}

async function waitForTerminal(runId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const run = await request(`/v1/runs/${runId}`);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`run ${runId} did not reach a terminal state`);
}

function assertGapless(events) {
  const sequence = events.map((event) => Number(event.seq));
  const expected = sequence.map((_, index) => index + 1);
  if (JSON.stringify(sequence) !== JSON.stringify(expected)) {
    throw new Error(`event sequence is not gapless: ${JSON.stringify(sequence)}`);
  }
}

async function createAgentVersion(label) {
  const suffix = Date.now().toString(36);
  const agent = await request('/v1/agents', {
    method: 'POST',
    body: JSON.stringify({ name: `${label}-${suffix}` }),
  });
  return request(`/v1/agents/${agent.id}/versions`, {
    method: 'POST',
    body: JSON.stringify({
      instructions: 'Complete the deterministic quickstart script.',
      modelPolicy: { model: 'none' },
    }),
  });
}

async function createScriptedRun(versionId, goal, script) {
  return request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      agentVersionId: versionId,
      goal,
      maxSteps: 10,
      tokenBudget: 1_000,
      input: { script },
    }),
  });
}

async function firstRun() {
  await waitForReady();
  const version = await createAgentVersion('quickstart');
  const run = await createScriptedRun(
    version.id,
    'Prove a durable run can complete without cloud credentials.',
    [
      { op: 'progress', note: 'quickstart accepted' },
      { op: 'checkpoint' },
      { op: 'progress', note: 'quickstart resumed from durable state' },
      { op: 'complete' },
    ],
  );

  const terminal = await waitForTerminal(run.id);
  if (terminal.status !== 'COMPLETED') {
    throw new Error(`status !== 'COMPLETED': ${terminal.status}`);
  }
  const { events } = await request(`/v1/runs/${run.id}/events`);
  assertGapless(events);

  process.stdout.write(`${JSON.stringify({
    runId: run.id,
    status: terminal.status,
    eventCount: events.length,
    lastEvent: events.at(-1)?.type,
  }, null, 2)}\n`);
  process.stdout.write('PASS first durable run\n');
}

async function approvalCreate() {
  await waitForReady();
  const version = await createAgentVersion('approval-recovery');
  const run = await createScriptedRun(
    version.id,
    'Pause for human approval and resume after a worker restart.',
    [
      { op: 'progress', note: 'before approval' },
      {
        op: 'requestApproval',
        action: {
          action: 'external.http.post',
          resource: 'https://example.com/tutorial',
          arguments: {},
          risk: 'external_write',
        },
      },
      { op: 'progress', note: 'after approval' },
      { op: 'complete' },
    ],
  );

  let waiting;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    waiting = await request(`/v1/runs/${run.id}`);
    if (waiting.status === 'WAITING_APPROVAL') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (waiting?.status !== 'WAITING_APPROVAL') {
    throw new Error(`run ${run.id} did not suspend for approval`);
  }
  const { approvals } = await request(`/v1/runs/${run.id}/approvals`);
  if (approvals.length !== 1 || approvals[0].status !== 'PENDING') {
    throw new Error(`expected one pending approval: ${JSON.stringify(approvals)}`);
  }
  const state = { runId: run.id, approvalId: approvals[0].id };
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(`QUICKSTART_STATE=${Buffer.from(JSON.stringify(state)).toString('base64url')}\n`);
  process.stdout.write('PASS approval suspended\n');
}

async function approvalResume() {
  await waitForReady();
  const runId = process.env.RUN_ID;
  const approvalId = process.env.APPROVAL_ID;
  if (!runId || !approvalId) throw new Error('RUN_ID and APPROVAL_ID are required');

  await request(`/v1/runs/${runId}/approvals/${approvalId}`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approve', decidedBy: 'quickstart-user' }),
  });

  let terminal = await waitForTerminal(runId);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (terminal.attempts?.length === 2 && terminal.attempts[1]?.exit_reason === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
    terminal = await request(`/v1/runs/${runId}`);
  }
  if (
    terminal.status !== 'COMPLETED'
    || terminal.attempts?.length !== 2
    || terminal.attempts[0]?.exit_reason !== 'suspended_for_approval'
    || terminal.attempts[1]?.exit_reason !== 'completed'
  ) {
    throw new Error(`unexpected recovery attempts: ${JSON.stringify(terminal.attempts)}`);
  }

  const { events } = await request(`/v1/runs/${runId}/events`);
  assertGapless(events);
  const types = events.map((event) => event.type);
  if (!types.includes('ApprovalRequested') || !types.includes('ApprovalReceived')) {
    throw new Error(`approval events are incomplete: ${JSON.stringify(types)}`);
  }

  process.stdout.write(`${JSON.stringify({
    runId,
    status: terminal.status,
    attempts: terminal.attempts.map((attempt) => attempt.exit_reason),
  }, null, 2)}\n`);
  process.stdout.write('PASS approval recovery\n');
}

const mode = process.env.QUICKSTART_MODE ?? process.argv[2] ?? 'first-run';
if (mode === 'first-run') await firstRun();
else if (mode === 'approval-create') await approvalCreate();
else if (mode === 'approval-resume') await approvalResume();
else throw new Error(`unknown quickstart mode: ${mode}`);
