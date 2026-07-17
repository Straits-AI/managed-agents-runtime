import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../server.js';
import { withTransaction } from '../../db/tx.js';
import { createRun, getRun } from '../../store/runs.js';
import { getAgentVersion } from '../../store/agents.js';
import { listEvents } from '../../store/events.js';
import { listAttempts } from '../../store/attempts.js';
import { listApprovals, decideApproval, getApproval } from '../../store/approvals.js';
import { listRevisions } from '../../store/workspaces.js';
import { appendEvent, transitionRun } from '../../core/transition.js';
import { isTerminal } from '../../core/stateMachine.js';

const createRunBody = z.object({
  agentVersionId: z.string(),
  goal: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
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

export function registerRunRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { pool } = deps;

  app.post('/v1/runs', async (req, reply) => {
    const body = createRunBody.parse(req.body);

    // Fault points are a test/benchmark surface only.
    if ((body.debugFaultPoints?.length ?? 0) > 0 && deps.cfg.HARNESS_ENABLE_FAULTS !== 1) {
      return reply.code(400).send({ error: 'fault injection disabled' });
    }
    const version = await getAgentVersion(pool, body.agentVersionId);
    if (!version) return reply.code(404).send({ error: 'agent version not found' });

    const run = await withTransaction(pool, (tx) => createRun(tx, body));
    return reply.code(201).send(run);
  });

  app.get<{ Params: { runId: string } }>('/v1/runs/:runId', async (req, reply) => {
    const run = await getRun(pool, req.params.runId);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const attempts = await listAttempts(pool, run.id);
    return { ...run, attempts };
  });

  app.get<{
    Params: { runId: string };
    Querystring: { afterSeq?: string; wait?: string };
  }>('/v1/runs/:runId/events', async (req, reply) => {
    const run = await getRun(pool, req.params.runId);
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

  app.post<{ Params: { runId: string }; Body: { message?: string } }>(
    '/v1/runs/:runId/messages',
    async (req, reply) => {
      const message = z.object({ message: z.string().min(1) }).parse(req.body).message;
      const run = await getRun(pool, req.params.runId);
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
      const run = await getRun(pool, req.params.runId);
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
      const run = await getRun(tx, req.params.runId);
      if (!run) return { code: 404 as const };
      if (isTerminal(run.status)) return { code: 409 as const, status: run.status };

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
          patch: { current_attempt_id: null, awaited_signal: null },
        });
      }
      return { code: 200 as const, woke };
    });

    if (result.code === 404) return reply.code(404).send({ error: 'run not found' });
    if (result.code === 409) {
      return reply.code(409).send({ error: `run is ${result.status}` });
    }
    return reply.code(202).send({ delivered: true, woke: result.woke });
  });

  app.post<{ Params: { runId: string } }>(
    '/v1/runs/:runId/cancel',
    async (req, reply) => {
      const result = await withTransaction(pool, async (tx) => {
        const run = await getRun(tx, req.params.runId);
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
      return result.run;
    },
  );

  app.get<{ Params: { runId: string } }>(
    '/v1/runs/:runId/export',
    async (req, reply) => {
      if (!deps.objectStore) {
        return reply.code(501).send({ error: 'export requires an object store' });
      }
      const { exportRunBundle } = await import('../../export/runBundle.js');
      try {
        const bundle = await exportRunBundle(pool, deps.objectStore, req.params.runId);
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
    '/v1/runs/:runId/artifacts',
    async (req, reply) => {
      const run = await getRun(pool, req.params.runId);
      if (!run) return reply.code(404).send({ error: 'run not found' });
      const revisions = run.workspace_id
        ? await listRevisions(pool, run.workspace_id)
        : [];
      const withUrls = await Promise.all(
        revisions.map(async (r) => ({
          ...r,
          downloadUrl: deps.presignGet
            ? await deps.presignGet(r.tos_key, 3600)
            : null,
        })),
      );
      return { revisions: withUrls };
    },
  );
}
