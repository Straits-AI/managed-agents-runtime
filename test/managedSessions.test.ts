import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { createApiKey, createTenant } from '../src/store/tenants.js';
import { createTestDb, type TestDb } from './helpers/db.js';
import { spawnWorker, waitFor, type SpawnedWorker } from './helpers/worker.js';
import { withTransaction } from '../src/db/tx.js';
import { createRun, ManagedSessionAdmissionError } from '../src/store/runs.js';
import { cancelManagedSession, createManagedSession } from '../src/store/sessions.js';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';

let db: TestDb;
let app: FastifyInstance;
let tenantAId: string;
let tenantBId: string;
let keyA: string;
let keyA2: string;
let keyB: string;
let agentVersionA: string;
const workers: SpawnedWorker[] = [];
const installFormats = addFormats as unknown as (ajv: Ajv) => Ajv;

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

beforeAll(async () => {
  db = await createTestDb();
  app = buildServer({
    pool: db.pool,
    cfg: loadConfig({
      ...process.env,
      DATABASE_URL: db.url,
      API_AUTH_TOKEN: 'operator-test-token',
    }),
  });
  const tenantA = await createTenant(db.pool, { name: 'Session tenant A' });
  const tenantB = await createTenant(db.pool, { name: 'Session tenant B' });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
  keyA = (await createApiKey(db.pool, { tenantId: tenantA.id, name: 'kertas-a' })).plaintext;
  keyA2 = (await createApiKey(db.pool, { tenantId: tenantA.id, name: 'kertas-a-2' })).plaintext;
  keyB = (await createApiKey(db.pool, { tenantId: tenantB.id, name: 'kertas-b' })).plaintext;

  const agent = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: bearer(keyA),
    payload: { name: 'managed-session-agent' },
  });
  expect(agent.statusCode).toBe(201);
  const version = await app.inject({
    method: 'POST',
    url: `/v1/agents/${agent.json().id}/versions`,
    headers: bearer(keyA),
    payload: { instructions: 'continue an objective', modelPolicy: { model: 'none' } },
  });
  expect(version.statusCode).toBe(201);
  agentVersionA = version.json().id;
});

afterAll(async () => {
  while (workers.length > 0) await workers.pop()!.stop();
  await app.close();
  await db.drop();
});

function sessionPayload(objective = 'Continue the opaque Kertas handoff') {
  return {
    agentVersionId: agentVersionA,
    objective,
    correlationRef: 'opaque-project-correlation',
    policy: { maximumRuns: 5 },
    credentialGrantRefs: [],
  };
}

describe('kertas.runtime/v1alpha1 ManagedSession API', () => {
  it('publishes discoverable schemas that validate the public session resources', async () => {
    const discovery = await app.inject({
      method: 'GET',
      url: '/v1/contracts',
      headers: bearer(keyA),
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json().plannedContracts).toContainEqual(expect.objectContaining({
      id: 'kertas.runtime/v1alpha1',
      lifecycle: 'not_available',
      features: { managedSession: true, inboundEvents: false },
    }));

    const contractResponse = await app.inject({
      method: 'GET',
      url: '/v1/contracts/kertas.runtime/v1alpha1',
      headers: bearer(keyA),
    });
    expect(contractResponse.statusCode).toBe(200);
    const contract = contractResponse.json();
    expect(contract.status).toBe('planned');
    expect(contract.semantics).toMatchObject({
      topLevelResource: 'ManagedSession',
      contractCompleteness: 'partial',
      projectCorrelationIsAuthorization: false,
      runCompletionImpliesKertasOutcome: false,
      runCompletionImpliesKertasRelease: false,
    });

    const ajv = new Ajv({ strict: true, allErrors: true });
    installFormats(ajv);
    const validateCreate = ajv.compile(contract.schemas.sessionCreate);
    const validateSession = ajv.compile(contract.schemas.sessionResource);
    const validateRuns = ajv.compile(contract.schemas.sessionRunList);
    const payload = {
      ...sessionPayload('Validate the managed session contract'),
      start: { goal: 'Remain queued for contract validation' },
    };
    expect(validateCreate(payload), JSON.stringify(validateCreate.errors)).toBe(true);

    const created = await app.inject({
      method: 'POST',
      url: '/v1alpha1/sessions',
      headers: { ...bearer(keyA), 'idempotency-key': 'contract-schema-session' },
      payload,
    });
    expect(validateSession(created.json()), JSON.stringify(validateSession.errors)).toBe(true);
    const runs = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}/runs`,
      headers: bearer(keyA),
    });
    expect(validateRuns(runs.json()), JSON.stringify(validateRuns.errors)).toBe(true);
  });

  it('creates exactly one tenant-scoped session per idempotency command', async () => {
    const missingKey = await app.inject({
      method: 'POST',
      url: '/v1alpha1/sessions',
      headers: bearer(keyA),
      payload: sessionPayload(),
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toEqual({ error: 'idempotency_key_required' });

    const headers = { ...bearer(keyA), 'idempotency-key': 'create-session-command-1' };
    const created = await app.inject({
      method: 'POST',
      url: '/v1alpha1/sessions',
      headers,
      payload: sessionPayload(),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      apiVersion: 'kertas.runtime/v1alpha1',
      kind: 'ManagedSession',
      tenantId: tenantAId,
      version: 1,
      state: 'IDLE',
      agentVersionId: agentVersionA,
      objective: 'Continue the opaque Kertas handoff',
      correlationRef: 'opaque-project-correlation',
      currentTopLevelRunId: null,
    });
    expect(created.json()).not.toHaveProperty('project');
    expect(created.json().createdAt).toEqual(expect.any(String));
    expect(created.json().updatedAt).toEqual(expect.any(String));

    const replay = await app.inject({
      method: 'POST',
      url: '/v1alpha1/sessions',
      headers,
      payload: sessionPayload(),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(created.json().id);

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1alpha1/sessions',
      headers,
      payload: sessionPayload('Different objective under the same command key'),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'idempotency_conflict' });

    const ownerRead = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}`,
      headers: bearer(keyA),
    });
    expect(ownerRead.statusCode).toBe(200);
    expect(ownerRead.json().id).toBe(created.json().id);

    const crossTenantRead = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}`,
      headers: bearer(keyB),
    });
    expect(crossTenantRead.statusCode).toBe(404);
    expect(crossTenantRead.json()).toEqual({ error: 'session_not_found' });
  });

  it('atomically creates at most one active initial top-level Run under a replay burst', async () => {
    const headers = { ...bearer(keyA), 'idempotency-key': 'create-active-session-burst' };
    const payload = {
      ...sessionPayload('Start one bounded execution episode'),
      start: {
        goal: 'Initial bounded Run',
        input: { script: [{ op: 'complete' }] },
        maxSteps: 10,
        tokenBudget: 1_000,
      },
    };

    const burst = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({ method: 'POST', url: '/v1alpha1/sessions', headers, payload }),
      ),
    );
    expect(burst.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(burst.filter((response) => response.statusCode === 200)).toHaveLength(11);
    const sessionIds = new Set(burst.map((response) => response.json().id));
    expect(sessionIds.size).toBe(1);
    expect(burst[0]!.json()).toMatchObject({
      state: 'ACTIVE',
      currentTopLevelRunId: expect.any(String),
    });

    const sessionId = burst[0]!.json().id;
    const runs = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${sessionId}/runs`,
      headers: bearer(keyA),
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toMatchObject({
      apiVersion: 'kertas.runtime/v1alpha1',
      kind: 'ManagedSessionRunList',
      sessionId,
    });
    expect(runs.json().runs).toHaveLength(1);
    expect(runs.json().runs[0]).toMatchObject({
      kind: 'Run',
      sessionId,
      parentRunId: null,
      status: 'QUEUED',
    });
  });

  it('scopes idempotency to the authenticated principal inside a tenant', async () => {
    const idempotency = { 'idempotency-key': 'same-key-different-principal' };
    const first = await app.inject({
      method: 'POST',
      url: '/v1alpha1/sessions',
      headers: { ...bearer(keyA), ...idempotency },
      payload: sessionPayload('Principal A session'),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1alpha1/sessions',
      headers: { ...bearer(keyA2), ...idempotency },
      payload: sessionPayload('Principal B session'),
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().id).not.toBe(second.json().id);
    expect(first.json().tenantId).toBe(second.json().tenantId);

    await expect(withTransaction(db.pool, (tx) => createManagedSession(tx, {
      tenantId: tenantBId,
      principalId: 'internal-test-principal',
      idempotencyKey: 'cross-tenant-agent-version',
      agentVersionId: agentVersionA,
      objective: 'must not bind a foreign agent version',
    }))).rejects.toThrow(/does not belong to tenant/);
  });

  it('cancels durably and idempotently while fencing the active top-level Run', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1alpha1/sessions',
      headers: { ...bearer(keyA), 'idempotency-key': 'create-session-to-cancel' },
      payload: {
        ...sessionPayload('Cancel this bounded episode'),
        start: { goal: 'Queued work', input: { script: [{ op: 'complete' }] } },
      },
    });
    expect(created.statusCode).toBe(201);

    const crossTenantCancel = await app.inject({
      method: 'POST',
      url: `/v1alpha1/sessions/${created.json().id}/cancel`,
      headers: { ...bearer(keyB), 'idempotency-key': 'cross-tenant-cancel' },
      payload: { reason: 'must remain undiscoverable' },
    });
    expect(crossTenantCancel.statusCode).toBe(404);
    expect(crossTenantCancel.json()).toEqual({ error: 'session_not_found' });

    const missingKey = await app.inject({
      method: 'POST',
      url: `/v1alpha1/sessions/${created.json().id}/cancel`,
      headers: bearer(keyA),
      payload: { reason: 'user_requested' },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toEqual({ error: 'idempotency_key_required' });

    const cancelHeaders = { ...bearer(keyA), 'idempotency-key': 'cancel-session-command' };
    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1alpha1/sessions/${created.json().id}/cancel`,
      headers: cancelHeaders,
      payload: { reason: 'user_requested' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      id: created.json().id,
      state: 'CANCELLED',
      currentTopLevelRunId: created.json().currentTopLevelRunId,
    });

    const replay = await app.inject({
      method: 'POST',
      url: `/v1alpha1/sessions/${created.json().id}/cancel`,
      headers: cancelHeaders,
      payload: { reason: 'user_requested' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(cancelled.json().id);

    const conflict = await app.inject({
      method: 'POST',
      url: `/v1alpha1/sessions/${created.json().id}/cancel`,
      headers: cancelHeaders,
      payload: { reason: 'different_reason' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'idempotency_conflict' });

    const runs = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}/runs`,
      headers: bearer(keyA),
    });
    expect(runs.json().runs).toHaveLength(1);
    expect(runs.json().runs[0].status).toBe('CANCELLED');

    await expect(
      withTransaction(db.pool, (tx) => createRun(tx, {
        tenantId: tenantAId,
        managedSessionId: created.json().id,
        agentVersionId: agentVersionA,
        goal: 'must remain fenced after cancellation',
      })),
    ).rejects.toBeInstanceOf(ManagedSessionAdmissionError);
  });

  it('returns to IDLE after Run completion without claiming Kertas outcome success', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1alpha1/sessions',
      headers: { ...bearer(keyA), 'idempotency-key': 'complete-one-session-run' },
      payload: {
        ...sessionPayload('Complete one execution episode'),
        start: {
          goal: 'Complete this Run only',
          input: { script: [{ op: 'complete' }] },
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const completionWorker = spawnWorker(db.url);

    const settled = await waitFor<Record<string, unknown>>(
      async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/v1alpha1/sessions/${created.json().id}`,
          headers: bearer(keyA),
        });
        return response.json().state === 'IDLE' ? response.json() : null;
      },
      { timeoutMs: 30_000, label: 'session returns to idle' },
    );
    expect(settled!.currentTopLevelRunId).toBeNull();
    expect(settled).not.toHaveProperty('outcome');
    expect(settled).not.toHaveProperty('release');

    const runs = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}/runs`,
      headers: bearer(keyA),
    });
    expect(runs.json().runs[0].status).toBe('COMPLETED');
    await completionWorker.stop();

    const followOn = await withTransaction(db.pool, (tx) => createRun(tx, {
      tenantId: tenantAId,
      managedSessionId: created.json().id,
      agentVersionId: agentVersionA,
      goal: 'A second bounded execution episode',
    }));
    const activeAgain = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}`,
      headers: bearer(keyA),
    });
    expect(activeAgain.json()).toMatchObject({
      state: 'ACTIVE',
      currentTopLevelRunId: followOn.id,
    });
    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1alpha1/sessions/${created.json().id}/cancel`,
      headers: { ...bearer(keyA), 'idempotency-key': 'cancel-follow-on-session' },
      payload: { reason: 'test_cleanup' },
    });
    expect(cancelled.statusCode).toBe(200);
  }, 40_000);

  it('keeps delegated children in the parent session without consuming a second top-level slot', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1alpha1/sessions',
      headers: { ...bearer(keyA), 'idempotency-key': 'create-delegating-session' },
      payload: {
        ...sessionPayload('Delegate bounded work'),
        start: {
          goal: 'Parent work',
          input: {
            script: [
              {
                op: 'delegate',
                goals: ['child work'],
                childScript: [{ op: 'waitSignal', name: 'hold-child' }],
              },
            ],
          },
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const delegationWorker = spawnWorker(db.url);

    const runs = await waitFor(
      async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/v1alpha1/sessions/${created.json().id}/runs`,
          headers: bearer(keyA),
        });
        return response.json().runs?.length === 2 ? response.json().runs : null;
      },
      { timeoutMs: 30_000, label: 'session child membership' },
    );
    expect(runs.every((run: { sessionId: string }) => run.sessionId === created.json().id)).toBe(true);
    const parent = runs.find((run: { parentRunId: string | null }) => run.parentRunId === null);
    const child = runs.find((run: { parentRunId: string | null }) => run.parentRunId !== null);
    expect(parent).toBeTruthy();
    expect(child).toMatchObject({ parentRunId: parent.id });

    const replacement = await withTransaction(db.pool, (tx) => createRun(tx, {
      tenantId: tenantAId,
      agentVersionId: agentVersionA,
      goal: 'replacement child work',
      parentRunId: parent.id,
      replacesRunId: child.id,
      replacementGeneration: 1,
    }));
    expect(replacement.managed_session_id).toBe(created.json().id);
    const afterReplacement = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}/runs`,
      headers: bearer(keyA),
    });
    expect(afterReplacement.json().runs).toHaveLength(3);
    expect(afterReplacement.json().runs.every(
      (run: { sessionId: string }) => run.sessionId === created.json().id,
    )).toBe(true);

    const session = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}`,
      headers: bearer(keyA),
    });
    expect(session.json().state).toBe('WAITING');

    await delegationWorker.stop();
    await expect(withTransaction(db.pool, async (tx) => {
      await cancelManagedSession(tx, {
        tenantId: tenantAId,
        principalId: 'crash-simulation-principal',
        sessionId: created.json().id,
        idempotencyKey: 'rolled-back-cancel-command',
        reason: 'simulated_process_loss',
      });
      throw new Error('simulated process loss before commit');
    })).rejects.toThrow(/simulated process loss/);
    const afterRollback = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}`,
      headers: bearer(keyA),
    });
    expect(afterRollback.json().state).toBe('WAITING');
    const runsAfterRollback = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}/runs`,
      headers: bearer(keyA),
    });
    expect(runsAfterRollback.json().runs.some(
      (run: { status: string }) => run.status !== 'CANCELLED',
    )).toBe(true);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1alpha1/sessions/${created.json().id}/cancel`,
      headers: { ...bearer(keyA), 'idempotency-key': 'cancel-delegated-session' },
      payload: { reason: 'cancel_all_session_members' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().state).toBe('CANCELLED');
    const fencedRuns = await app.inject({
      method: 'GET',
      url: `/v1alpha1/sessions/${created.json().id}/runs`,
      headers: bearer(keyA),
    });
    expect(fencedRuns.json().runs).toHaveLength(3);
    const beforeById = new Map<string, string>(runsAfterRollback.json().runs.map(
      (run: { id: string; status: string }) => [run.id, run.status],
    ));
    for (const run of fencedRuns.json().runs as { id: string; status: string }[]) {
      const before = beforeById.get(run.id)!;
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(before)) {
        expect(run.status).toBe(before);
      } else {
        expect(run.status).toBe('CANCELLED');
      }
    }
  }, 40_000);
});
