import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../server.js';
import { withTransaction } from '../../db/tx.js';
import { getAgentDefinition, getAgentVersion } from '../../store/agents.js';
import {
  cancelManagedSession,
  createManagedSession,
  getManagedSession,
  listManagedSessionRuns,
  SessionIdempotencyConflictError,
  type ManagedSessionRow,
} from '../../store/sessions.js';
import {
  listManagedSessionEvents,
  receiveManagedSessionEvent,
  SessionEventConflictError,
  SessionEventDeliveryError,
  type ManagedSessionEventRow,
} from '../../store/sessionEvents.js';

const createSessionBody = z.object({
  agentVersionId: z.string().min(1),
  objective: z.string().min(1).max(16_384),
  correlationRef: z.string().min(1).max(1_000).optional(),
  policy: z.record(z.string(), z.unknown()).optional(),
  credentialGrantRefs: z.array(z.string().min(1).max(500)).max(100).optional(),
  start: z.object({
    goal: z.string().min(1).max(16_384),
    input: z.record(z.string(), z.unknown()).optional(),
    maxSteps: z.number().int().positive().optional(),
    tokenBudget: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();

const cancelSessionBody = z.object({
  reason: z.string().min(1).max(1_000).default('user_requested'),
}).strict();

const snapshotReference = z.object({
  snapshotId: z.string().min(1).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(1_000_000_000),
  formatVersion: z.string().min(1).max(100),
}).strict();

const sessionEventBody = z.object({
  apiVersion: z.literal('kertas.runtime/v1alpha1'),
  eventId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  type: z.enum([
    'kertas.signal.received',
    'kertas.objective.requested',
    'kertas.feedback.received',
  ]),
  occurredAt: z.string().datetime({ offset: true }),
  sourceSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  subject: z.object({
    type: z.string().min(1).max(100),
    ref: z.string().min(1).max(1_000),
  }).strict().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  inputSnapshotRefs: z.array(snapshotReference).max(16).default([]),
  correlationId: z.string().min(1).max(500).optional(),
}).strict().superRefine((body, context) => {
  if (Buffer.byteLength(JSON.stringify(body.data)) > 65_536) {
    context.addIssue({ code: 'custom', path: ['data'], message: 'data exceeds 65536 bytes' });
  }
  if (body.type === 'kertas.signal.received' && typeof body.data.name !== 'string') {
    context.addIssue({ code: 'custom', path: ['data', 'name'], message: 'signal name is required' });
  }
});

const sessionEventListQuery = z.object({
  after: z.string().max(19)
    .refine((value) => /^[0-9]+$/.test(value)
      && BigInt(value) <= 9_223_372_036_854_775_807n)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

async function withContentionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((code !== '40P01' && code !== '40001') || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
}

function idempotencyKey(headers: Record<string, unknown>): string | null {
  const value = headers['idempotency-key'];
  return typeof value === 'string' && /^\S{1,200}$/.test(value) ? value : null;
}

function sessionResource(session: ManagedSessionRow) {
  return {
    apiVersion: 'kertas.runtime/v1alpha1',
    kind: 'ManagedSession',
    id: session.id,
    tenantId: session.tenant_id,
    version: Number(session.version),
    state: session.state,
    agentVersionId: session.agent_version_id,
    objective: session.objective,
    correlationRef: session.correlation_ref,
    policy: session.policy,
    credentialGrantRefs: session.credential_grant_refs,
    currentTopLevelRunId: session.current_top_level_run_id,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  };
}

function sessionEventResource(event: ManagedSessionEventRow) {
  return {
    apiVersion: 'kertas.runtime/v1alpha1',
    kind: 'ManagedSessionEvent',
    id: event.id,
    sessionId: event.session_id,
    eventId: event.source_event_id,
    source: { type: event.source_type, id: event.source_id, sequence: event.source_sequence },
    receivedSequence: Number(event.received_sequence),
    type: event.type,
    occurredAt: event.occurred_at,
    subject: event.subject,
    data: event.data,
    inputSnapshotRefs: event.input_snapshot_refs,
    correlationId: event.correlation_id,
    dispatchClass: event.dispatch_class,
    status: event.status,
    statusReason: event.status_reason,
    runId: event.run_id,
    receivedAt: event.created_at,
    consumedAt: event.consumed_at,
  };
}

export function registerSessionRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/v1alpha1/sessions', async (req, reply) => {
    const key = idempotencyKey(req.headers);
    if (!key) return reply.code(400).send({ error: 'idempotency_key_required' });
    const body = createSessionBody.parse(req.body);
    const version = await getAgentVersion(deps.pool, body.agentVersionId);
    const owner = version && await getAgentDefinition(
      deps.pool,
      version.agent_id,
      req.tenantId,
    );
    if (!version || !owner) {
      return reply.code(404).send({ error: 'agent_version_not_found' });
    }
    try {
      const result = await withTransaction(deps.pool, (tx) =>
        createManagedSession(tx, {
          tenantId: req.tenantId,
          principalId: req.principalId,
          idempotencyKey: key,
          ...body,
        }),
      );
      return reply.code(result.replayed ? 200 : 201).send(sessionResource(result.session));
    } catch (error) {
      if (error instanceof SessionIdempotencyConflictError) {
        return reply.code(409).send({ error: 'idempotency_conflict' });
      }
      throw error;
    }
  });

  app.get<{ Params: { sessionId: string } }>(
    '/v1alpha1/sessions/:sessionId',
    async (req, reply) => {
      const session = await getManagedSession(deps.pool, req.params.sessionId, req.tenantId);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      return sessionResource(session);
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    '/v1alpha1/sessions/:sessionId/cancel',
    async (req, reply) => {
      const key = idempotencyKey(req.headers);
      if (!key) return reply.code(400).send({ error: 'idempotency_key_required' });
      const body = cancelSessionBody.parse(req.body ?? {});
      try {
        const result = await withContentionRetry(() =>
          withTransaction(deps.pool, (tx) =>
            cancelManagedSession(tx, {
              tenantId: req.tenantId,
              principalId: req.principalId,
              sessionId: req.params.sessionId,
              idempotencyKey: key,
              reason: body.reason,
            }),
          ),
        );
        if (!result) return reply.code(404).send({ error: 'session_not_found' });
        return reply.code(200).send(sessionResource(result.session));
      } catch (error) {
        if (error instanceof SessionIdempotencyConflictError) {
          return reply.code(409).send({ error: 'idempotency_conflict' });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    '/v1alpha1/sessions/:sessionId/events',
    async (req, reply) => {
      const body = sessionEventBody.parse(req.body);
      try {
        const result = await withContentionRetry(() =>
          withTransaction(deps.pool, (tx) => receiveManagedSessionEvent(tx, {
            tenantId: req.tenantId,
            sessionId: req.params.sessionId,
            sourceType: 'authenticated-principal',
            sourceId: req.principalId,
            sourceEventId: body.eventId,
            sourceSequence: body.sourceSequence,
            apiVersion: body.apiVersion,
            type: body.type,
            occurredAt: body.occurredAt,
            subject: body.subject,
            data: body.data,
            inputSnapshotRefs: body.inputSnapshotRefs,
            correlationId: body.correlationId,
          })),
        );
        if (!result) return reply.code(404).send({ error: 'session_not_found' });
        return reply.code(result.replayed ? 200 : 201).send(sessionEventResource(result.event));
      } catch (error) {
        if (error instanceof SessionEventConflictError) {
          return reply.code(409).send({ error: 'event_conflict' });
        }
        if (error instanceof SessionEventDeliveryError) {
          return reply.code(409).send({ error: 'event_not_deliverable', reason: error.reason });
        }
        throw error;
      }
    },
  );

  app.get<{
    Params: { sessionId: string };
    Querystring: { after?: string; limit?: string };
  }>(
    '/v1alpha1/sessions/:sessionId/events',
    async (req, reply) => {
      const session = await getManagedSession(deps.pool, req.params.sessionId, req.tenantId);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const query = sessionEventListQuery.parse(req.query);
      const result = await listManagedSessionEvents(deps.pool, session.id, req.tenantId, {
        afterReceivedSequence: query.after,
        limit: query.limit,
      });
      return {
        apiVersion: 'kertas.runtime/v1alpha1',
        kind: 'ManagedSessionEventList',
        sessionId: session.id,
        events: result.events.map(sessionEventResource),
        nextCursor: result.nextCursor,
      };
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    '/v1alpha1/sessions/:sessionId/runs',
    async (req, reply) => {
      const session = await getManagedSession(deps.pool, req.params.sessionId, req.tenantId);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const runs = await listManagedSessionRuns(deps.pool, session.id, req.tenantId);
      return {
        apiVersion: 'kertas.runtime/v1alpha1',
        kind: 'ManagedSessionRunList',
        sessionId: session.id,
        runs: runs.map((run) => ({
          apiVersion: 'kertas.runtime/v1alpha1',
          kind: 'Run',
          id: run.id,
          sessionId: run.managed_session_id,
          parentRunId: run.parent_run_id,
          status: run.status,
          statusReason: run.status_reason,
          goal: run.goal,
          createdAt: run.created_at,
          updatedAt: run.updated_at,
        })),
      };
    },
  );
}
