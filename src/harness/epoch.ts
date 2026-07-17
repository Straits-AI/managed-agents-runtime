import type { Pool } from 'pg';
import type { EpochContext } from './worker.js';
import type {
  CheckpointAgentState,
  EpochExitReason,
  ProgressLedger,
  RunRow,
} from '../core/types.js';
import type {
  ChatMessage,
  MemoryProvider,
  MemoryRecord,
  ModelProvider,
  ObjectStore,
  SandboxHandle,
  SandboxProvider,
} from '../providers/types.js';
import { withTransaction } from '../db/tx.js';
import { appendEvent, transitionRun } from '../core/transition.js';
import { getAgentVersion } from '../store/agents.js';
import { insertCheckpoint, latestCheckpoint } from '../store/checkpoints.js';
import { listGrants } from '../store/grants.js';
import { listEvents } from '../store/events.js';
import { listApprovals } from '../store/approvals.js';
import { compileContext } from './contextCompiler.js';
import { WorkspaceManager, WORKSPACE_DIR } from './workspace.js';
import { dispatchTool, TOOL_DEFS, TOOL_DOCS, type ToolContext } from './toolRouter.js';
import { verify, type VerifierPolicy } from './verifier.js';
import { tokenBudgetExceeded } from './limits.js';
import { maybeCrash } from './faults.js';

export interface EpochProviders {
  model: ModelProvider;
  sandbox: SandboxProvider;
  objectStore: ObjectStore;
  /** Long-term cross-run memory (optional; recall into context + `remember`). */
  memory?: MemoryProvider;
}

/** How many memories to recall into context at the start of an epoch. */
const MEMORY_RECALL_LIMIT = 8;

const MAX_VERIFY_RETRIES = 2;
const MAX_NO_TOOL_TURNS = 3;

/**
 * The real execution epoch (memo §13, §16): restore durable state into a
 * fresh sandbox, run the ModelArk tool loop, checkpoint continuously, and
 * exit with a durable reason. Every epoch is disposable — all state a
 * future epoch needs is in Postgres and TOS before this one ends.
 */
export function createRealEpoch(providers: EpochProviders) {
  return async function realEpoch(ctx: EpochContext): Promise<EpochExitReason> {
    const { pool, cfg, run, attempt, signal } = ctx;
    const workspaces = new WorkspaceManager(pool, providers.sandbox, providers.objectStore);

    const version = await getAgentVersion(pool, run.agent_version_id);
    if (!version) throw new Error(`agent version missing: ${run.agent_version_id}`);

    // --- Restore durable state ---
    const ckpt = await latestCheckpoint(pool, run.id);
    const agentState: CheckpointAgentState = ckpt?.agent_state ?? { step: 0 };
    let transcript: ChatMessage[] = [];
    if (agentState.transcriptTosKey) {
      transcript = JSON.parse(
        (await providers.objectStore.get(agentState.transcriptTosKey)).toString('utf8'),
      ) as ChatMessage[];
    }
    let step = agentState.step;
    let verifyRetries = 0;
    let noToolTurns = 0;

    // --- Allocate sandbox and restore workspace ---
    const sandbox = await providers.sandbox.create({
      runId: run.id,
      timeoutMinutes: version.sandbox_spec.timeoutMinutes ?? cfg.SANDBOX_TIMEOUT_MINUTES,
      image: version.sandbox_spec.image,
      cpuMilli: version.sandbox_spec.cpuMilli,
      memoryMB: version.sandbox_spec.memoryMB,
    });
    await withTransaction(pool, async (tx) => {
      await tx.query(
        `UPDATE run_attempts SET sandbox_id = $2, sandbox_domain = $3 WHERE id = $1`,
        [attempt.id, sandbox.sandboxId, sandbox.baseUrl],
      );
      await appendEvent(
        tx,
        run.id,
        { type: 'SandboxAllocated', payload: { sandboxId: sandbox.sandboxId } },
        { attemptId: attempt.id },
      );
    });

    const cleanup = async () => {
      await providers.sandbox.terminate(sandbox).catch(() => {});
      await withTransaction(pool, (tx) =>
        appendEvent(
          tx,
          run.id,
          { type: 'SandboxTerminated', payload: { sandboxId: sandbox.sandboxId } },
          { attemptId: attempt.id },
        ),
      ).catch(() => {});
    };

    try {
      await workspaces.restore(sandbox, {
        runId: run.id,
        attemptId: attempt.id,
        workspaceId: run.workspace_id!,
        seedFiles: run.input.files as Record<string, string> | undefined,
        initCommand: run.input.initCommand as string | undefined,
      });

      const memoryScope = { tenantId: run.tenant_id, agentId: version.agent_id };
      const toolCtx: ToolContext = {
        pool,
        cfg,
        run,
        attempt,
        sandbox,
        sandboxProvider: providers.sandbox,
        objectStore: providers.objectStore,
        step,
        memory: providers.memory,
        memoryScope,
      };

      // Recall long-term memory once per epoch (stable within a run): the most
      // relevant facts this agent has remembered across previous runs.
      const recalledMemories: MemoryRecord[] = providers.memory
        ? await providers.memory
            .search(memoryScope, run.goal, MEMORY_RECALL_LIMIT)
            .catch(() => [])
        : [];

      const saveCheckpoint = async (state: Partial<CheckpointAgentState> = {}) => {
        const transcriptTosKey = `runs/${run.id}/transcripts/${attempt.id}-${step}.json`;
        await providers.objectStore.put(
          transcriptTosKey,
          Buffer.from(JSON.stringify(transcript)),
        );
        const revisionId = await workspaces.checkpoint(sandbox, {
          runId: run.id,
          attemptId: attempt.id,
          workspaceId: run.workspace_id!,
        });
        await withTransaction(pool, async (tx) => {
          const { rows } = await tx.query<{ last_event_seq: string; progress: ProgressLedger }>(
            'SELECT last_event_seq, progress FROM runs WHERE id = $1',
            [run.id],
          );
          await insertCheckpoint(tx, {
            runId: run.id,
            attemptId: attempt.id,
            eventSeq: BigInt(rows[0]!.last_event_seq),
            workspaceRevisionId: revisionId,
            progress: rows[0]!.progress,
            agentState: { step, transcriptTosKey, ...state },
          });
        });
        maybeCrash(cfg, run, 'after_checkpoint');
      };

      // --- Resume a suspended tool call (e.g. approval decided) ---
      if (agentState.pendingToolCall) {
        const pending = agentState.pendingToolCall;
        toolCtx.step = step;
        const outcome = await dispatchTool(toolCtx, pending.name, pending.arguments);
        if (outcome.kind === 'suspend_approval') {
          // Still undecided (shouldn't happen — resume implies decision).
          await cleanup();
          return 'suspended_for_approval';
        }
        if (outcome.kind === 'suspend_signal') {
          // Signal not yet delivered — keep waiting.
          await saveCheckpoint({ pendingToolCall: pending });
          await cleanup();
          return 'suspended_for_signal';
        }
        const content =
          outcome.kind === 'result'
            ? outcome.content
            : `completion acknowledged: ${outcome.summary}`;
        transcript.push({ role: 'tool', content, toolCallId: pending.id });
        step += 1;
      }

      // --- Main loop ---
      for (;;) {
        if (signal.aborted) return 'lease_lost';

        if (step >= run.max_steps) {
          await saveCheckpoint();
          await cleanup();
          return 'budget_exhausted';
        }
        const budget = await tokenBudgetExceeded(pool, run.id);
        if (budget) {
          await saveCheckpoint();
          await cleanup();
          return 'budget_exhausted';
        }

        // Fresh dynamic context each iteration.
        const [grants, freshRun] = await Promise.all([
          listGrants(pool, run.id),
          pool
            .query<RunRow>('SELECT * FROM runs WHERE id = $1', [run.id])
            .then((r) => r.rows[0]!),
        ]);
        const messages = compileContext({
          version,
          run: freshRun,
          grants,
          transcript,
          userMessages: await unseenUserMessages(pool, run.id),
          approvalOutcomes: await recentApprovalOutcomes(pool, run.id),
          memories: recalledMemories,
          toolDocs: TOOL_DOCS,
        });

        await withTransaction(pool, (tx) =>
          appendEvent(
            tx,
            run.id,
            { type: 'ModelInvocationStarted', payload: { step } },
            { attemptId: attempt.id },
          ),
        );
        const completion = await providers.model.chat({
          model: version.model_policy.model ?? cfg.ARK_MODEL ?? '',
          messages,
          tools: TOOL_DEFS,
          maxTokens: version.model_policy.maxTokens,
          temperature: version.model_policy.temperature,
        });
        await withTransaction(pool, (tx) =>
          appendEvent(
            tx,
            run.id,
            {
              type: 'ModelInvocationCompleted',
              payload: { step, usage: completion.usage },
            },
            {
              attemptId: attempt.id,
              patch: {
                tokens_used: String(
                  Number(run.tokens_used) +
                    completion.usage.inputTokens +
                    completion.usage.outputTokens,
                ),
              },
            },
          ),
        );
        run.tokens_used = String(
          Number(run.tokens_used) +
            completion.usage.inputTokens +
            completion.usage.outputTokens,
        );

        transcript.push(completion.message);

        const toolCalls = completion.message.toolCalls ?? [];
        if (toolCalls.length === 0) {
          noToolTurns += 1;
          if (noToolTurns >= MAX_NO_TOOL_TURNS) {
            throw new Error('model stopped using tools without completing the run');
          }
          transcript.push({
            role: 'user',
            content:
              'Continue working with the available tools. When the goal is fully achieved, call run_complete.',
          });
          continue;
        }
        noToolTurns = 0;

        for (const call of toolCalls) {
          if (signal.aborted) return 'lease_lost';
          toolCtx.step = step;
          const outcome = await dispatchTool(toolCtx, call.name, call.arguments);

          if (outcome.kind === 'suspend_approval') {
            // The tool router already transitioned to WAITING_APPROVAL.
            // Persist everything a future epoch needs, then release compute.
            await saveCheckpoint({ pendingToolCall: call });
            await cleanup();
            return 'suspended_for_approval';
          }

          if (outcome.kind === 'suspend_signal') {
            // Tool router already transitioned to WAITING_SIGNAL; the pending
            // call replays on resume and returns the delivered signal payload.
            await saveCheckpoint({ pendingToolCall: call });
            await cleanup();
            return 'suspended_for_signal';
          }

          if (outcome.kind === 'complete') {
            const result = await finishRun(
              { pool, run, attempt, sandbox, providers, workspaces },
              outcome.summary,
              outcome.artifacts,
              version.verifier_policy as VerifierPolicy,
            );
            if (result === 'completed') {
              await cleanup();
              return 'completed';
            }
            verifyRetries += 1;
            if (verifyRetries > MAX_VERIFY_RETRIES) {
              await withTransaction(pool, (tx) =>
                transitionRun(tx, run.id, {
                  expectFrom: ['RUNNING'],
                  to: 'FAILED',
                  event: {
                    type: 'RunFailed',
                    payload: { reason: 'verification_retries_exhausted' },
                  },
                  attemptId: attempt.id,
                  reason: 'verification_retries_exhausted',
                }),
              );
              await cleanup();
              return 'error';
            }
            transcript.push({
              role: 'tool',
              content: `verification FAILED:\n${result.join('\n')}\nFix these problems, then call run_complete again.`,
              toolCallId: call.id,
            });
            continue;
          }

          transcript.push({
            role: 'tool',
            content: outcome.content,
            toolCallId: call.id,
          });
        }

        step += 1;
        if (step % cfg.CHECKPOINT_EVERY_STEPS === 0) await saveCheckpoint();
      }
    } catch (err) {
      if (!signal.aborted) {
        await cleanup();
      }
      throw err;
    }
  };
}

/** VERIFYING → COMPLETED (with artifact upload) or back to RUNNING. */
async function finishRun(
  ctx: {
    pool: Pool;
    run: RunRow;
    attempt: { id: string };
    sandbox: SandboxHandle;
    providers: EpochProviders;
    workspaces: WorkspaceManager;
  },
  summary: string,
  artifacts: string[],
  policy: VerifierPolicy,
): Promise<'completed' | string[]> {
  const { pool, run, attempt } = ctx;

  await withTransaction(pool, (tx) =>
    transitionRun(tx, run.id, {
      expectFrom: ['RUNNING'],
      to: 'VERIFYING',
      event: { type: 'VerificationStarted', payload: { summary, artifacts } },
      attemptId: attempt.id,
    }),
  );

  const result = await verify({
    pool,
    runId: run.id,
    policy,
    claimedArtifacts: artifacts,
    sandbox: ctx.sandbox,
    sandboxProvider: ctx.providers.sandbox,
  });

  if (!result.passed) {
    await withTransaction(pool, (tx) =>
      transitionRun(tx, run.id, {
        expectFrom: ['VERIFYING'],
        to: 'RUNNING',
        event: { type: 'VerificationFailed', payload: { failures: result.failures } },
        attemptId: attempt.id,
      }),
    );
    return result.failures;
  }

  // Upload declared artifacts to TOS for durable retrieval.
  const artifactKeys: Record<string, string> = {};
  for (const path of artifacts) {
    const abs = path.startsWith('/') ? path : `${WORKSPACE_DIR}/${path}`;
    const content = await ctx.providers.sandbox.readFile(ctx.sandbox, abs);
    const key = `runs/${run.id}/artifacts/${path.replace(/^\//, '')}`;
    await ctx.providers.objectStore.put(key, Buffer.from(content));
    artifactKeys[path] = key;
  }
  // Final workspace snapshot so the completed state is durable.
  await ctx.workspaces.checkpoint(ctx.sandbox, {
    runId: run.id,
    attemptId: attempt.id,
    workspaceId: run.workspace_id!,
  });

  await withTransaction(pool, (tx) =>
    transitionRun(tx, run.id, {
      expectFrom: ['VERIFYING'],
      to: 'COMPLETED',
      event: {
        type: 'RunCompleted',
        payload: { summary, artifacts: artifactKeys },
      },
      attemptId: attempt.id,
    }),
  );
  return 'completed';
}

/** All user messages received so far (Phase 1: presented every epoch). */
async function unseenUserMessages(pool: Pool, runId: string): Promise<string[]> {
  const events = await listEvents(pool, runId, { limit: 1000 });
  return events
    .filter((e) => e.type === 'UserMessageReceived')
    .map((e) => String(e.payload.message ?? ''));
}

async function recentApprovalOutcomes(
  pool: Pool,
  runId: string,
): Promise<{ action: string; decision: string }[]> {
  const approvals = await listApprovals(pool, runId);
  return approvals
    .filter((a) => a.status !== 'PENDING')
    .map((a) => ({
      action: `${a.action.action} on ${a.action.resource ?? 'unknown'}`,
      decision: a.status,
    }));
}
