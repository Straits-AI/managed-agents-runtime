import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { createApiKey, createTenant } from '../src/store/tenants.js';
import { createTestDb, type TestDb } from './helpers/db.js';
import { spawnWorker, waitFor } from './helpers/worker.js';
import { withTransaction } from '../src/db/tx.js';
import {
  dispatchPendingSessionEvents,
  receiveManagedSessionEvent,
  type SessionEventType,
} from '../src/store/sessionEvents.js';
import { transitionRun } from '../src/core/transition.js';
import { Ajv, type AnySchema } from 'ajv';
import addFormatsModule from 'ajv-formats';

let db: TestDb;
let app: FastifyInstance;
let key: string;
let otherTenantKey: string;
let agentVersionId: string;
let otherAgentVersionId: string;
let tenantId: string;
let principalId: string;
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

const auth = () => ({ authorization: `Bearer ${key}` });
const event = (eventId: string, type: SessionEventType = 'kertas.objective.requested') => ({
  apiVersion: 'kertas.runtime/v1alpha1' as const,
  eventId,
  type,
  occurredAt: '2026-07-22T00:00:00.000Z',
  subject: { type: 'project', ref: 'opaque-project-ref' },
  data: { goal: `goal for ${eventId}` },
  inputSnapshotRefs: [{
    snapshotId: `snap-${eventId}`,
    digest: `sha256:${'a'.repeat(64)}`,
    sizeBytes: 128,
    formatVersion: 'kertas.workspace/v1',
  }],
  correlationId: `cor-${eventId}`,
});

async function createSession(idempotencyKey: string, start?: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1alpha1/sessions',
    headers: { ...auth(), 'idempotency-key': idempotencyKey },
    payload: {
      agentVersionId,
      objective: 'Continue from authenticated events',
      ...(start ? { start } : {}),
    },
  });
}

beforeAll(async () => {
  db = await createTestDb();
  app = buildServer({
    pool: db.pool,
    cfg: loadConfig({
      ...process.env,
      DATABASE_URL: db.url,
      API_AUTH_TOKEN: 'operator-events',
      RATE_LIMIT_PER_SEC: '0',
    }),
  });
  const tenant = await createTenant(db.pool, { name: 'Session events tenant' });
  tenantId = tenant.id;
  const apiKey = await createApiKey(db.pool, { tenantId: tenant.id, name: 'event-source' });
  key = apiKey.plaintext;
  principalId = `api-key:${apiKey.id}`;
  const otherTenant = await createTenant(db.pool, { name: 'Other session events tenant' });
  const otherApiKey = await createApiKey(db.pool, {
    tenantId: otherTenant.id,
    name: 'other-event-source',
  });
  otherTenantKey = otherApiKey.plaintext;
  const agent = await app.inject({
    method: 'POST', url: '/v1/agents', headers: auth(), payload: { name: 'event-agent' },
  });
  const version = await app.inject({
    method: 'POST', url: `/v1/agents/${agent.json().id}/versions`, headers: auth(),
    payload: { instructions: 'handle events', modelPolicy: { model: 'none' } },
  });
  agentVersionId = version.json().id;
  const otherAuth = { authorization: `Bearer ${otherTenantKey}` };
  const otherAgent = await app.inject({
    method: 'POST', url: '/v1/agents', headers: otherAuth, payload: { name: 'other-event-agent' },
  });
  const otherVersion = await app.inject({
    method: 'POST', url: `/v1/agents/${otherAgent.json().id}/versions`, headers: otherAuth,
    payload: { instructions: 'handle other events', modelPolicy: { model: 'none' } },
  });
  otherAgentVersionId = otherVersion.json().id;
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('ManagedSession inbound events', () => {
  it('deduplicates, rejects conflicts and untrusted/bounded payloads, and dispatches IDLE future work', async () => {
    const session = await createSession('event-session-1');
    const url = `/v1alpha1/sessions/${session.json().id}/events`;

    const crossTenantPost = await app.inject({
      method: 'POST', url,
      headers: { authorization: `Bearer ${otherTenantKey}` },
      payload: event('cross-tenant-post'),
    });
    expect(crossTenantPost.statusCode).toBe(404);
    const crossTenantGet = await app.inject({
      method: 'GET', url,
      headers: { authorization: `Bearer ${otherTenantKey}` },
    });
    expect(crossTenantGet.statusCode).toBe(404);

    const unknown = await app.inject({
      method: 'POST', url, headers: auth(),
      payload: { ...event('unknown'), type: 'unknown.event' },
    });
    expect(unknown.statusCode).toBe(400);
    const selfGranted = await app.inject({
      method: 'POST', url, headers: auth(),
      payload: { ...event('self-granted'), source: { type: 'admin', id: 'forged' } },
    });
    expect(selfGranted.statusCode).toBe(400);
    const oversized = await app.inject({
      method: 'POST', url, headers: auth(),
      payload: { ...event('too-large'), data: { value: 'x'.repeat(70_000) } },
    });
    expect(oversized.statusCode).toBe(400);
    const signedUrl = await app.inject({
      method: 'POST', url, headers: auth(),
      payload: {
        ...event('signed-url'),
        inputSnapshotRefs: [{
          snapshotId: 'snap-unsafe', digest: `sha256:${'b'.repeat(64)}`,
          sizeBytes: 1, formatVersion: 'v1', url: 'https://signed.invalid/secret',
        }],
      },
    });
    expect(signedUrl.statusCode).toBe(400);
    const urlAsId = await app.inject({
      method: 'POST', url, headers: auth(),
      payload: {
        ...event('url-as-id'),
        inputSnapshotRefs: [{
          snapshotId: 'https://signed.invalid/secret?token=secret',
          digest: `sha256:${'b'.repeat(64)}`,
          sizeBytes: 1,
          formatVersion: 'v1',
        }],
      },
    });
    expect(urlAsId.statusCode).toBe(400);

    const accepted = await app.inject({ method: 'POST', url, headers: auth(), payload: event('evt-1') });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({
      apiVersion: 'kertas.runtime/v1alpha1', kind: 'ManagedSessionEvent',
      eventId: 'evt-1', receivedSequence: 1, dispatchClass: 'future-run',
      status: 'PENDING', runId: null,
      source: { type: 'authenticated-principal', id: expect.stringMatching(/^api-key:/) },
    });
    const contractResponse = await app.inject({
      method: 'GET', url: '/v1/contracts/kertas.runtime/v1alpha1', headers: auth(),
    });
    const contract = contractResponse.json();
    const ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(ajv);
    ajv.addSchema([
      contract.schemas.sessionEventCreate,
      contract.schemas.sessionEventResource,
      contract.schemas.sessionEventList,
    ] as AnySchema[]);
    expect(
      ajv.getSchema(contract.schemas.sessionEventCreate.$id)!(event('evt-schema')),
    ).toBe(true);
    expect(
      ajv.getSchema(contract.schemas.sessionEventResource.$id)!(accepted.json()),
    ).toBe(true);
    const replay = await app.inject({ method: 'POST', url, headers: auth(), payload: event('evt-1') });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(accepted.json().id);
    const conflict = await app.inject({
      method: 'POST', url, headers: auth(),
      payload: { ...event('evt-1'), data: { goal: 'different' } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'event_conflict' });

    const listed = await app.inject({ method: 'GET', url, headers: auth() });
    expect(listed.json().events).toHaveLength(1);
    expect(listed.json().nextCursor).toBeNull();
    expect(ajv.getSchema(contract.schemas.sessionEventList.$id)!(listed.json())).toBe(true);
    const worker = spawnWorker(db.url);
    const dispatched = await waitFor(async () => {
      const response = await app.inject({ method: 'GET', url, headers: auth() });
      return response.json().events[0]?.status === 'DISPATCHED'
        ? response.json().events[0]
        : null;
    }, { label: 'idle event dispatch' });
    await worker.stop();
    const runs = await app.inject({
      method: 'GET', url: `/v1alpha1/sessions/${session.json().id}/runs`, headers: auth(),
    });
    expect(runs.json().runs).toHaveLength(1);
    expect(runs.json().runs[0].id).toBe(dispatched.runId);
  });

  it('serializes concurrent future deliveries into one gap-free canonical order', async () => {
    const session = await createSession('event-session-burst', { goal: 'hold active' });
    const url = `/v1alpha1/sessions/${session.json().id}/events`;
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      app.inject({ method: 'POST', url, headers: auth(), payload: event(`burst-${index}`, 'kertas.feedback.received') }),
    ));
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    const listed = await app.inject({ method: 'GET', url, headers: auth() });
    expect(listed.json().events.map((item: { receivedSequence: number }) => item.receivedSequence))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(listed.json().events.every((item: { status: string }) => item.status === 'PENDING')).toBe(true);
    const firstPage = await app.inject({ method: 'GET', url: `${url}?limit=7`, headers: auth() });
    expect(firstPage.json().events).toHaveLength(7);
    expect(firstPage.json().nextCursor).toBe('7');
    const secondPage = await app.inject({
      method: 'GET', url: `${url}?limit=7&after=${firstPage.json().nextCursor}`, headers: auth(),
    });
    expect(secondPage.json().events[0].receivedSequence).toBe(8);
    expect((await app.inject({ method: 'GET', url: `${url}?limit=201`, headers: auth() })).statusCode)
      .toBe(400);
    expect((await app.inject({
      method: 'GET', url: `${url}?after=9999999999999999999`, headers: auth(),
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: 'GET', url: `${url}?after=abc`, headers: auth(),
    })).statusCode).toBe(400);
    const runs = await app.inject({
      method: 'GET', url: `/v1alpha1/sessions/${session.json().id}/runs`, headers: auth(),
    });
    expect(runs.json().runs).toHaveLength(1);

    const crashPayload = event('crash-retry', 'kertas.feedback.received');
    await expect(withTransaction(db.pool, async (tx) => {
      await receiveManagedSessionEvent(tx, {
        tenantId,
        sessionId: session.json().id,
        sourceType: 'authenticated-principal',
        sourceId: principalId,
        sourceEventId: crashPayload.eventId,
        apiVersion: crashPayload.apiVersion,
        type: crashPayload.type,
        occurredAt: crashPayload.occurredAt,
        subject: crashPayload.subject,
        data: crashPayload.data,
        inputSnapshotRefs: crashPayload.inputSnapshotRefs,
        correlationId: crashPayload.correlationId,
      });
      throw new Error('simulated crash before event commit');
    })).rejects.toThrow(/simulated crash/);
    const retry = await app.inject({ method: 'POST', url, headers: auth(), payload: crashPayload });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().receivedSequence).toBe(21);
    const afterRetry = await app.inject({ method: 'GET', url, headers: auth() });
    expect(afterRetry.json().events).toHaveLength(21);
  });

  it('consumes an authenticated current-run signal exactly once against its durable wait', async () => {
    const session = await createSession('event-session-signal', {
      goal: 'wait for signal',
      input: {
        script: [{
          op: 'waitSignal',
          name: 'continue',
          correlationId: 'cor-signal-1',
          payloadSchema: {
            type: 'object',
            required: ['approved'],
            properties: { approved: { type: 'boolean' } },
            additionalProperties: false,
          },
        }],
      },
    });
    const worker = spawnWorker(db.url);
    await waitFor(async () => {
      const runs = await app.inject({
        method: 'GET', url: `/v1alpha1/sessions/${session.json().id}/runs`, headers: auth(),
      });
      return runs.json().runs[0]?.status === 'WAITING_SIGNAL';
    }, { label: 'signal wait' });
    await worker.stop();
    const waitingRuns = await app.inject({
      method: 'GET', url: `/v1alpha1/sessions/${session.json().id}/runs`, headers: auth(),
    });
    const legacySignal = await app.inject({
      method: 'POST', url: `/v1/runs/${waitingRuns.json().runs[0].id}/signals`, headers: auth(),
      payload: { name: 'continue', payload: { approved: true } },
    });
    expect(legacySignal.statusCode).toBe(409);
    expect(legacySignal.json()).toEqual({ error: 'managed_session_event_required' });
    const url = `/v1alpha1/sessions/${session.json().id}/events`;
    const payload = {
      ...event('signal-1', 'kertas.signal.received'),
      data: { name: 'continue', payload: { approved: true } },
      inputSnapshotRefs: [],
    };
    const wrongCorrelation = await app.inject({
      method: 'POST', url, headers: auth(),
      payload: { ...payload, eventId: 'signal-wrong-correlation', correlationId: 'wrong' },
    });
    expect(wrongCorrelation.statusCode).toBe(409);
    const wrongSchema = await app.inject({
      method: 'POST', url, headers: auth(),
      payload: {
        ...payload,
        eventId: 'signal-wrong-schema',
        correlationId: 'cor-signal-1',
        data: { name: 'continue', payload: { approved: 'yes' } },
      },
    });
    expect(wrongSchema.statusCode).toBe(409);
    payload.correlationId = 'cor-signal-1';
    const accepted = await app.inject({ method: 'POST', url, headers: auth(), payload });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({
      dispatchClass: 'current-run', status: 'CONSUMED', runId: expect.any(String),
    });
    const replay = await app.inject({ method: 'POST', url, headers: auth(), payload });
    expect(replay.statusCode).toBe(200);
    const runs = await app.inject({
      method: 'GET', url: `/v1alpha1/sessions/${session.json().id}/runs`, headers: auth(),
    });
    expect(runs.json().runs[0].status).toBe('QUEUED');
  });

  it('preserves ordered receipts through admission deferral and prevents overtaking', async () => {
    const session = await createSession('event-session-ordered-deferral', {
      goal: 'hold first run', input: { script: [{ op: 'complete' }] },
    });
    const sessionId = session.json().id as string;
    const url = `/v1alpha1/sessions/${sessionId}/events`;
    expect((await app.inject({
      method: 'POST', url, headers: auth(),
      payload: event('oldest-pending', 'kertas.feedback.received'),
    })).json().status).toBe('PENDING');
    const runs = await app.inject({
      method: 'GET', url: `/v1alpha1/sessions/${sessionId}/runs`, headers: auth(),
    });
    const firstRunId = runs.json().runs[0].id as string;
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, firstRunId, {
        expectFrom: ['QUEUED'], to: 'STARTING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, firstRunId, {
        expectFrom: ['STARTING'], to: 'RUNNING', event: { type: 'AttemptStarted' },
      });
      await transitionRun(tx, firstRunId, {
        expectFrom: ['RUNNING'], to: 'VERIFYING', event: { type: 'VerificationStarted' },
      });
      await transitionRun(tx, firstRunId, {
        expectFrom: ['VERIFYING'], to: 'COMPLETED', event: { type: 'RunCompleted' },
      });
    });
    await db.pool.query('UPDATE tenants SET max_concurrent_runs = 0 WHERE id = $1', [tenantId]);
    const dispatchClock = new Date();
    expect(await dispatchPendingSessionEvents(db.pool, {
      retryDelayMs: 60_000,
      now: dispatchClock,
    })).toEqual([]);
    expect((await app.inject({
      method: 'POST', url, headers: auth(),
      payload: event('newer-pending', 'kertas.feedback.received'),
    })).json().status).toBe('PENDING');
    let listed = await app.inject({ method: 'GET', url, headers: auth() });
    expect(listed.json().events.map((item: { status: string }) => item.status))
      .toEqual(['PENDING', 'PENDING']);
    await db.pool.query('UPDATE tenants SET max_concurrent_runs = NULL WHERE id = $1', [tenantId]);
    await dispatchPendingSessionEvents(db.pool, {
      now: new Date(dispatchClock.getTime() + 1_000),
    });
    listed = await app.inject({ method: 'GET', url, headers: auth() });
    expect(listed.json().events.map((item: { status: string }) => item.status))
      .toEqual(['PENDING', 'PENDING']);
    await dispatchPendingSessionEvents(db.pool, {
      now: new Date(dispatchClock.getTime() + 61_000),
    });
    listed = await app.inject({ method: 'GET', url, headers: auth() });
    expect(listed.json().events.map((item: { status: string }) => item.status))
      .toEqual(['DISPATCHED', 'PENDING']);
  });

  it('serializes a dedup key across sessions and terminally stales queued work on cancellation', async () => {
    const sessionA = await createSession('event-session-cross-a', {
      goal: 'active A', input: { script: [{ op: 'complete' }] },
    });
    const sessionB = await createSession('event-session-cross-b', {
      goal: 'active B', input: { script: [{ op: 'complete' }] },
    });
    const urlA = `/v1alpha1/sessions/${sessionA.json().id}/events`;
    const urlB = `/v1alpha1/sessions/${sessionB.json().id}/events`;
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: urlA, headers: auth(), payload: event('shared-source-id') }),
      app.inject({ method: 'POST', url: urlB, headers: auth(), payload: event('shared-source-id') }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);

    const acceptedUrl = responses[0]!.statusCode === 201 ? urlA : urlB;
    const acceptedSession = responses[0]!.statusCode === 201 ? sessionA : sessionB;
    const cancel = await app.inject({
      method: 'POST', url: `/v1alpha1/sessions/${acceptedSession.json().id}/cancel`,
      headers: { ...auth(), 'idempotency-key': 'cancel-queued-event' },
      payload: { reason: 'test cancellation' },
    });
    expect(cancel.statusCode).toBe(200);
    const listed = await app.inject({ method: 'GET', url: acceptedUrl, headers: auth() });
    expect(listed.json().events[0]).toMatchObject({
      status: 'STALE', statusReason: 'session_cancelled', consumedAt: expect.any(String),
    });
    const replay = await app.inject({
      method: 'POST', url: acceptedUrl, headers: auth(), payload: event('shared-source-id'),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe('STALE');

    const eventId = listed.json().events[0].id as string;
    await expect(db.pool.query(
      `UPDATE managed_session_events SET data = '{"tampered":true}' WHERE id = $1`,
      [eventId],
    )).rejects.toThrow(/receipt payload is immutable/);
    await expect(db.pool.query(
      'DELETE FROM managed_session_events WHERE id = $1', [eventId],
    )).rejects.toThrow(/receipts are immutable/);
  });

  it('defers blocked admission candidates so a later tenant cannot be starved', async () => {
    await db.pool.query(
      `UPDATE managed_session_events
       SET dispatch_after = now() + interval '1 hour'
       WHERE status = 'PENDING'`,
    );
    await db.pool.query('UPDATE tenants SET max_concurrent_runs = 0 WHERE id = $1', [tenantId]);
    const blocked = await createSession('event-session-fairness-blocked');
    const blockedUrl = `/v1alpha1/sessions/${blocked.json().id}/events`;
    expect((await app.inject({
      method: 'POST', url: blockedUrl, headers: auth(), payload: event('fairness-blocked'),
    })).statusCode).toBe(201);

    const otherHeaders = {
      authorization: `Bearer ${otherTenantKey}`,
      'idempotency-key': 'event-session-fairness-eligible',
    };
    const eligible = await app.inject({
      method: 'POST', url: '/v1alpha1/sessions', headers: otherHeaders,
      payload: { agentVersionId: otherAgentVersionId, objective: 'eligible other tenant' },
    });
    const eligibleUrl = `/v1alpha1/sessions/${eligible.json().id}/events`;
    expect((await app.inject({
      method: 'POST', url: eligibleUrl,
      headers: { authorization: `Bearer ${otherTenantKey}` },
      payload: event('fairness-eligible'),
    })).statusCode).toBe(201);

    expect(await dispatchPendingSessionEvents(db.pool, {
      candidateLimit: 1, retryDelayMs: 60_000,
    })).toEqual([]);
    expect(await dispatchPendingSessionEvents(db.pool, {
      candidateLimit: 1, retryDelayMs: 60_000,
    })).toHaveLength(1);
    const eligibleEvents = await app.inject({
      method: 'GET', url: eligibleUrl,
      headers: { authorization: `Bearer ${otherTenantKey}` },
    });
    expect(eligibleEvents.json().events[0].status).toBe('DISPATCHED');
    await db.pool.query('UPDATE tenants SET max_concurrent_runs = NULL WHERE id = $1', [tenantId]);
  });

  it('dispatches the oldest queued future event after the active Run becomes terminal', async () => {
    const session = await createSession('event-session-follow-on', {
      goal: 'finish first episode',
      input: { script: [{ op: 'complete' }] },
    });
    const url = `/v1alpha1/sessions/${session.json().id}/events`;
    const queued = await app.inject({
      method: 'POST', url, headers: auth(),
      payload: event('follow-on-1', 'kertas.feedback.received'),
    });
    expect(queued.json().status).toBe('PENDING');
    const worker = spawnWorker(db.url);
    const dispatched = await waitFor(async () => {
      const listed = await app.inject({ method: 'GET', url, headers: auth() });
      if (listed.statusCode !== 200) {
        throw new Error(`event list failed: ${listed.statusCode} ${listed.body}`);
      }
      const item = listed.json().events[0];
      return item?.status === 'DISPATCHED' ? item : null;
    }, { label: 'queued event dispatch' });
    await worker.stop();
    const runs = await app.inject({
      method: 'GET', url: `/v1alpha1/sessions/${session.json().id}/runs`, headers: auth(),
    });
    expect(runs.json().runs).toHaveLength(2);
    expect(runs.json().runs[1].id).toBe(dispatched.runId);
  });
});
