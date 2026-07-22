import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../server.js';
import { withTransaction } from '../../db/tx.js';
import { createRun, getRun } from '../../store/runs.js';
import { getAgentVersion, getAgentDefinition } from '../../store/agents.js';
import { listEvents } from '../../store/events.js';
import { listAttempts } from '../../store/attempts.js';
import { listApprovals, decideApproval, getApproval } from '../../store/approvals.js';
import { listGrants } from '../../store/grants.js';
import { getArtifactForTenant, listArtifactsForRun } from '../../store/artifacts.js';
import { childLineageProjection } from '../../store/childLineage.js';
import { runUsage, tenantUsage } from '../../store/usage.js';
import { RunAdmissionRejectedError } from '../../store/admissions.js';
import { appendEvent, transitionRun } from '../../core/transition.js';
import { isTerminal } from '../../core/stateMachine.js';
import type { ModelPrice } from '../../core/costs.js';
import type { RunRow } from '../../core/types.js';

// Keys the server owns inside a run's `input`; a client must never set them —
// they drive workspace/transcript seeding from other runs and would otherwise
// allow pointing a run at another tenant's data (IDOR).
const RESERVED_INPUT_KEYS = ['forkFrom', 'parentWorkspaceId'] as const;

function compatibilityRunResource(
  run: RunRow,
): Omit<
  RunRow,
  | 'managed_session_id'
  | 'awaited_signal_correlation_id'
  | 'awaited_signal_schema'
> {
  const {
    managed_session_id: _managedSessionId,
    awaited_signal_correlation_id: _awaitedSignalCorrelationId,
    awaited_signal_schema: _awaitedSignalSchema,
    ...resource
  } = run;
  return resource;
}

function stripReservedInput(input: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...input };
  for (const k of RESERVED_INPUT_KEYS) delete clean[k];
  return clean;
}

const runInput = z
  .record(z.string(), z.unknown())
  .refine((o) => RESERVED_INPUT_KEYS.every((k) => !(k in o)), {
    message: `input may not contain server-reserved keys: ${RESERVED_INPUT_KEYS.join(', ')}`,
  });

const createRunBody = z.object({
  agentVersionId: z.string(),
  goal: z.string().min(1),
  input: runInput.optional(),
  maxSteps: z.number().int().positive().optional(),
  tokenBudget: z.number().int().positive().optional(),
  scheduledFor: z.string().datetime().optional(),
  grants: z
    .array(
      z.object({
        action: z.string(),
        resource: z.string().optional(),
        requiresApproval: z.boolean().optional(),
        maxCalls: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  debugFaultPoints: z.array(z.string()).optional(),
});

const forkBody = z.object({
  goal: z.string().min(1).optional(),
  input: runInput.optional(),
  maxSteps: z.number().int().positive().optional(),
  tokenBudget: z.number().int().positive().optional(),
});

const usageWindowQuery = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
}).superRefine((window, ctx) => {
  if (window.until !== undefined && window.since === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['until'],
      message: 'until requires since',
    });
  }
  if (
    window.since !== undefined &&
    window.until !== undefined &&
    new Date(window.since) >= new Date(window.until)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['until'],
      message: 'usage window must satisfy since < until',
    });
  }
});

export function registerRunRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { pool } = deps;
  const price: ModelPrice = {
    inputPerMTok: deps.cfg.MODEL_PRICE_INPUT_PER_MTOK,
    outputPerMTok: deps.cfg.MODEL_PRICE_OUTPUT_PER_MTOK,
  };

  app.post('/v1/runs', async (req, reply) => {
    const body = createRunBody.parse(req.body);

    // Fault points are a test/benchmark surface only.
    if ((body.debugFaultPoints?.length ?? 0) > 0 && deps.cfg.HARNESS_ENABLE_FAULTS !== 1) {
      return reply.code(400).send({ error: 'fault injection disabled' });
    }
    const version = await getAgentVersion(pool, body.agentVersionId);
    // The version must belong to an agent owned by the caller's tenant, else a
    // tenant could run another tenant's agent. Report as not-found either way.
    const owner = version && (await getAgentDefinition(pool, version.agent_id, req.tenantId));
    if (!version || !owner) return reply.code(404).send({ error: 'agent version not found' });

    try {
      const run = await withTransaction(pool, (tx) =>
        createRun(tx, { ...body, tenantId: req.tenantId }),
      );
      return reply.code(201).send(compatibilityRunResource(run));
    } catch (err) {
      if (err instanceof RunAdmissionRejectedError) {
        const status = err.reason === 'tenant_unavailable' ? 403 : 429;
        return reply.code(status).send({ error: err.message, reason: err.reason });
      }
      throw err;
    }
  });

  app.get<{ Params: { runId: string } }>('/v1/runs/:runId', async (req, reply) => {
    const run = await getRun(pool, req.params.runId, req.tenantId);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const attempts = await listAttempts(pool, run.id);
    return { ...compatibilityRunResource(run), attempts };
  });

  // Tenant-wide usage rollup (memo §20 /usage). Defaults to the current UTC day;
  // pass ?since=ISO&until=ISO for an explicit half-open event-time window.
  app.get<{ Querystring: { since?: string; until?: string } }>('/v1/usage', async (req) => {
    const window = usageWindowQuery.parse(req.query);
    return tenantUsage(pool, req.tenantId, price, window.since, window.until);
  });

  // Per-run usage + estimated model cost (memo §20). Tenant-scoped.
  app.get<{ Params: { runId: string } }>('/v1/runs/:runId/usage', async (req, reply) => {
    if (!(await getRun(pool, req.params.runId, req.tenantId))) {
      return reply.code(404).send({ error: 'run not found' });
    }
    return runUsage(pool, req.params.runId, price);
  });

  app.get<{
    Params: { runId: string };
    Querystring: { afterSeq?: string; wait?: string };
  }>('/v1/runs/:runId/events', async (req, reply) => {
    const run = await getRun(pool, req.params.runId, req.tenantId);
    if (!run) return reply.code(404).send({ error: 'run not found' });

    const afterSeq = BigInt(req.query.afterSeq ?? '0');
    const waitMs = Math.min(Number(req.query.wait ?? '0'), 30_000);
    const deadline = Date.now() + waitMs;

    let events = await listEvents(pool, run.id, { afterSeq });
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      events = await listEvents(pool, run.id, { afterSeq });
    }
    return { events };
  });

  // Real-time event stream (Server-Sent Events). Same data as the long-poll
  // endpoint, pushed as it lands. We hijack the socket so Fastify's buffered
  // response machinery (onResponse access log, JSON error handler) doesn't
  // interfere with the long-lived text/event-stream response.
  app.get<{ Params: { runId: string }; Querystring: { afterSeq?: string } }>(
    '/v1/runs/:runId/events/stream',
    async (req, reply) => {
      const run = await getRun(pool, req.params.runId, req.tenantId);
      if (!run) return reply.code(404).send({ error: 'run not found' });

      // Resume from Last-Event-ID (set by EventSource on reconnect) or ?afterSeq.
      const resumeFrom = (req.headers['last-event-id'] as string) ?? req.query.afterSeq ?? '0';
      let afterSeq = BigInt(resumeFrom);

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // disable proxy buffering (nginx)
      });
      reply.hijack();

      let clientGone = false;
      req.raw.on('close', () => {
        clientGone = true;
      });

      const start = Date.now();
      let lastBeat = Date.now();
      try {
        for (;;) {
          if (clientGone) break;

          const batch = await listEvents(pool, req.params.runId, { afterSeq });
          for (const e of batch) {
            reply.raw.write(
              `id: ${e.seq}\ndata: ${JSON.stringify({
                seq: e.seq,
                type: e.type,
                payload: e.payload,
                created_at: e.created_at,
              })}\n\n`,
            );
            afterSeq = BigInt(e.seq);
          }

          // End the stream once the run is terminal and the client has seen the
          // final event.
          const cur = await getRun(pool, req.params.runId);
          if (cur && isTerminal(cur.status) && afterSeq >= BigInt(cur.last_event_seq)) {
            reply.raw.write(`event: end\ndata: ${JSON.stringify({ status: cur.status })}\n\n`);
            break;
          }
          if (Date.now() - start > deps.cfg.SSE_MAX_STREAM_MS) break;

          if (batch.length === 0) {
            if (Date.now() - lastBeat > deps.cfg.SSE_HEARTBEAT_MS) {
              reply.raw.write(': keep-alive\n\n');
              lastBeat = Date.now();
            }
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      } catch {
        // Mid-stream error (e.g. DB blip): just close; the client reconnects
        // with Last-Event-ID and resumes from afterSeq.
      } finally {
        reply.raw.end();
      }
    },
  );

  app.post<{ Params: { runId: string }; Body: { message?: string } }>(
    '/v1/runs/:runId/messages',
    async (req, reply) => {
      const message = z.object({ message: z.string().min(1) }).parse(req.body).message;
      const run = await getRun(pool, req.params.runId, req.tenantId);
      if (!run) return reply.code(404).send({ error: 'run not found' });
      if (isTerminal(run.status)) {
        return reply.code(409).send({ error: `run is ${run.status}` });
      }
      const seq = await withTransaction(pool, (tx) =>
        appendEvent(tx, run.id, {
          type: 'UserMessageReceived',
          payload: { message },
        }),
      );
      return reply.code(202).send({ seq: seq.toString() });
    },
  );

  app.get<{ Params: { runId: string } }>(
    '/v1/runs/:runId/approvals',
    async (req, reply) => {
      const run = await getRun(pool, req.params.runId, req.tenantId);
      if (!run) return reply.code(404).send({ error: 'run not found' });
      return { approvals: await listApprovals(pool, run.id) };
    },
  );

  app.post<{
    Params: { runId: string; approvalId: string };
    Body: { decision: string; decidedBy?: string };
  }>('/v1/runs/:runId/approvals/:approvalId', async (req, reply) => {
    const body = z
      .object({
        decision: z.enum(['approve', 'deny']),
        decidedBy: z.string().default('api'),
      })
      .parse(req.body);

    const approval = await getApproval(pool, req.params.approvalId);
    if (!approval || approval.run_id !== req.params.runId) {
      return reply.code(404).send({ error: 'approval not found' });
    }
    // Scope to the caller's tenant: an approval on another tenant's run is 404.
    if (!(await getRun(pool, req.params.runId, req.tenantId))) {
      return reply.code(404).send({ error: 'approval not found' });
    }

    const updated = await withTransaction(pool, async (tx) => {
      const decided = await decideApproval(
        tx,
        approval.id,
        body.decision === 'approve' ? 'APPROVED' : 'DENIED',
        body.decidedBy,
      );
      if (!decided) return null; // already decided

      // Wake the run either way — the agent decides how to proceed after
      // a denial. The run may legitimately be elsewhere if other approvals
      // are still pending.
      const run = await getRun(tx, approval.run_id);
      if (run?.status === 'WAITING_APPROVAL') {
        await transitionRun(tx, run.id, {
          expectFrom: ['WAITING_APPROVAL'],
          to: 'QUEUED',
          event: {
            type: body.decision === 'approve' ? 'ApprovalReceived' : 'ApprovalDenied',
            payload: { approvalId: approval.id },
          },
          patch: { current_attempt_id: null },
        });
      }
      return decided;
    });

    if (!updated) return reply.code(409).send({ error: 'approval already decided' });
    return updated;
  });

  app.post<{
    Params: { runId: string };
    Body: { name: string; payload?: unknown };
  }>('/v1/runs/:runId/signals', async (req, reply) => {
    const body = z
      .object({ name: z.string().min(1), payload: z.unknown().optional() })
      .parse(req.body);

    const result = await withTransaction(pool, async (tx) => {
      const run = await getRun(tx, req.params.runId, req.tenantId);
      if (!run) return { code: 404 as const };
      if (isTerminal(run.status)) return { code: 409 as const, status: run.status };
      if (run.managed_session_id) {
        return { code: 409 as const, error: 'managed_session_event_required' };
      }

      // Record delivery in the ledger regardless of whether the run is
      // currently waiting — a signal may legitimately arrive early.
      await appendEvent(tx, run.id, {
        type: 'SignalReceived',
        payload: { name: body.name, payload: body.payload ?? null },
      });

      // Wake the run only if it is waiting for THIS signal.
      const woke = run.status === 'WAITING_SIGNAL' && run.awaited_signal === body.name;
      if (woke) {
        await transitionRun(tx, run.id, {
          expectFrom: ['WAITING_SIGNAL'],
          to: 'QUEUED',
          event: { type: 'SignalReceived', payload: { name: body.name, woke: true } },
          patch: {
            current_attempt_id: null,
            awaited_signal: null,
            awaited_signal_correlation_id: null,
            awaited_signal_schema: null,
          },
        });
      }
      return { code: 200 as const, woke };
    });

    if (result.code === 404) return reply.code(404).send({ error: 'run not found' });
    if (result.code === 409) {
      return reply.code(409).send({
        error: 'error' in result ? result.error : `run is ${result.status}`,
      });
    }
    return reply.code(202).send({ delivered: true, woke: result.woke });
  });

  app.post<{ Params: { runId: string } }>(
    '/v1/runs/:runId/cancel',
    async (req, reply) => {
      const result = await withTransaction(pool, async (tx) => {
        const run = await getRun(tx, req.params.runId, req.tenantId);
        if (!run) return { code: 404 as const };
        if (isTerminal(run.status)) return { code: 409 as const, status: run.status };

        const cancelled = await transitionRun(tx, run.id, {
          expectFrom: [run.status],
          to: 'CANCELLED',
          event: { type: 'RunCancelled' },
          reason: 'cancelled_by_api',
        });
        // Fence out any live worker: its next heartbeat fails and the
        // epoch aborts.
        if (run.current_attempt_id) {
          await tx.query(
            `UPDATE run_attempts SET state = 'EXITED', exit_reason = 'cancelled'
             WHERE id = $1 AND state = 'ACTIVE'`,
            [run.current_attempt_id],
          );
        }
        return { code: 200 as const, run: cancelled };
      });

      if (result.code === 404) return reply.code(404).send({ error: 'run not found' });
      if (result.code === 409) {
        return reply.code(409).send({ error: `run is ${result.status}` });
      }
      return compatibilityRunResource(result.run);
    },
  );

  // Fork a run: create a new run branched from the source (memo §20). Lineage is
  // recorded in forked_from_run_id (server-set); the epoch derives the workspace
  // copy-on-write seed and the resume step from that source run — never from
  // client input — after a same-tenant check. The fork inherits the source's
  // progress ledger and capability grants (with a fresh call budget). Body may
  // override goal/input/maxSteps/tokenBudget.
  app.post<{
    Params: { runId: string };
    Body: {
      goal?: string;
      input?: Record<string, unknown>;
      maxSteps?: number;
      tokenBudget?: number;
    };
  }>('/v1/runs/:runId/fork', async (req, reply) => {
    const source = await getRun(pool, req.params.runId, req.tenantId);
    if (!source) return reply.code(404).send({ error: 'run not found' });
    const body = forkBody.parse(req.body ?? {});

    const grants = (await listGrants(pool, source.id)).map((g) => ({
      action: g.action_pattern,
      resource: g.resource_pattern,
      requiresApproval: g.requires_approval,
      maxCalls: g.max_calls ?? undefined,
    }));

    try {
      const fork = await withTransaction(pool, (tx) =>
        createRun(tx, {
          tenantId: req.tenantId,
          agentVersionId: source.agent_version_id,
          goal: body.goal ?? source.goal,
          // Strip any server-reserved keys the source's input may carry; the epoch
          // sets the real seeds from forked_from_run_id.
          input: stripReservedInput(body.input ?? source.input),
          progress: source.progress as Record<string, unknown>,
          maxSteps: body.maxSteps ?? source.max_steps,
          tokenBudget: body.tokenBudget ?? (source.token_budget ? Number(source.token_budget) : undefined),
          forkedFromRunId: source.id,
          grants,
        }),
      );
      return reply.code(201).send(compatibilityRunResource(fork));
    } catch (err) {
      if (err instanceof RunAdmissionRejectedError) {
        const status = err.reason === 'tenant_unavailable' ? 403 : 429;
        return reply.code(status).send({ error: err.message, reason: err.reason });
      }
      throw err;
    }
  });

  app.get<{ Params: { runId: string } }>(
    '/v1/runs/:runId/export',
    async (req, reply) => {
      if (!deps.objectStore) {
        return reply.code(501).send({ error: 'export requires an object store' });
      }
      const { exportRunBundle } = await import('../../export/runBundle.js');
      try {
        // Tenant-scoped: an export is a bulk dump of a run's entire state
        // (events, receipts, grants, workspace snapshot) and must never cross
        // tenants. A run owned by another tenant reports as not-found.
        const bundle = await exportRunBundle(
          pool,
          deps.objectStore,
          req.params.runId,
          req.tenantId,
        );
        return bundle;
      } catch (err) {
        if ((err as Error).message.includes('not found')) {
          return reply.code(404).send({ error: 'run not found' });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { runId: string } }>(
    '/v1/runs/:runId/children',
    async (req, reply) => {
      const lineage = await childLineageProjection(pool, req.params.runId, req.tenantId);
      if (!lineage) return reply.code(404).send({ error: 'run not found' });
      return lineage;
    },
  );

  app.get<{ Params: { runId: string } }>(
    '/v1/runs/:runId/artifacts',
    async (req, reply) => {
      const run = await getRun(pool, req.params.runId, req.tenantId);
      if (!run) return reply.code(404).send({ error: 'run not found' });
      const artifacts = await listArtifactsForRun(pool, run.id, req.tenantId);
      return {
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          schemaVersion: artifact.schema_version,
          digest: artifact.digest,
          mimeType: artifact.mime_type,
          sizeBytes: artifact.size_bytes,
          logicalRole: artifact.logical_role,
          producer: {
            runId: artifact.producer_run_id,
            attemptId: artifact.producer_attempt_id,
            step: artifact.producer_step,
          },
          sourcePath: artifact.source_path,
          sourceRefs: artifact.source_refs,
          verificationRefs: artifact.verification_refs,
          evidenceRefs: artifact.evidence_refs,
          contentUrl: `/v1/runs/${run.id}/artifacts/${artifact.id}/content`,
          createdAt: artifact.created_at.toISOString(),
        })),
      };
    },
  );

  app.get<{ Params: { runId: string; artifactId: string } }>(
    '/v1/runs/:runId/artifacts/:artifactId/content',
    async (req, reply) => {
      const artifact = await getArtifactForTenant(pool, req.params.artifactId, req.tenantId);
      if (!artifact || artifact.producer_run_id !== req.params.runId) {
        return reply.code(404).send({ error: 'artifact not found' });
      }
      if (deps.presignGet) {
        const url = await deps.presignGet(artifact.object_key, 300);
        return reply.redirect(url);
      }
      if (!deps.objectStore) {
        return reply.code(501).send({ error: 'artifact content requires an object store' });
      }
      const bytes = await deps.objectStore.get(artifact.object_key);
      return reply
        .type(artifact.mime_type)
        .header('content-length', String(bytes.byteLength))
        .send(bytes);
    },
  );
}
