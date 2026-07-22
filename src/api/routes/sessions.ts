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

async function withCancellationRetry<T>(operation: () => Promise<T>): Promise<T> {
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
        const result = await withCancellationRetry(() =>
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
