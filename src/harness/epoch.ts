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
  KnowledgeProvider,
  MemoryProvider,
  MemoryRecord,
  ModelProvider,
  ObjectStore,
  SandboxHandle,
  SandboxProvider,
  SkillProvider,
  SkillRef,
  McpToolProvider,
  CredentialProvider,
  ToolCall,
  ToolDef,
} from '../providers/types.js';
import { materializeSkills, type MaterializedSkill } from './skills.js';
import { resolveMcpTools } from './mcp.js';
import { withClientTransaction, withTransaction, type Tx } from '../db/tx.js';
import { appendEvent, transitionRun } from '../core/transition.js';
import { getAgentVersion, knowledgeReferenceFromConfig } from '../store/agents.js';
import { getRun } from '../store/runs.js';
import { insertCheckpoint, latestCheckpoint } from '../store/checkpoints.js';
import { listGrants } from '../store/grants.js';
import { listEvents } from '../store/events.js';
import { listApprovals } from '../store/approvals.js';
import { compileContext } from './contextCompiler.js';
import { WorkspaceManager, WORKSPACE_DIR } from './workspace.js';
import { dispatchTool, TOOL_DEFS, TOOL_DOCS, type ToolContext } from './toolRouter.js';
import { verify, type VerifierPolicy } from './verifier.js';
import { limitModelInvocation, tokenBudgetExceeded } from './limits.js';
import { maybeCrash } from './faults.js';
import { routeModel } from './modelRouter.js';
import {
  evaluate as superviseStep,
  initialSupervisorState,
  type SupervisorState,
  type SupervisorThresholds,
} from './supervisor.js';
import {
  actionSignature,
  ledgerCompleted,
  ledgerRemaining,
  recordSupervision,
} from './supervision.js';
import {
  beginModelInvocation,
  completeModelInvocation,
} from '../store/modelUsage.js';
import { MODEL_INVOCATION_LOCK_SEED } from '../core/locks.js';
import { invocationAbortFence } from './invocationAbort.js';
import { createArtifact } from '../store/artifacts.js';
import { stageArtifactOutputs } from './artifacts.js';

export interface EpochProviders {
  model: ModelProvider;
  sandbox: SandboxProvider;
  objectStore: ObjectStore;
  /** Long-term cross-run memory (optional; recall into context + `remember`). */
  memory?: MemoryProvider;
  /** Knowledge-base retrieval (optional; enables the `knowledge_search` tool). */
  knowledge?: KnowledgeProvider;
  /** Resolves version-pinned skills materialized into the workspace (optional). */
  skills?: SkillProvider;
  /** MCP toolsets surfaced to the model and routed through policy (optional). */
  mcp?: McpToolProvider;
  /** Credential broker: injects scoped secrets into tool calls (memo §9.5). */
  credentials?: CredentialProvider;
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
    // Fork/child seeds are derived from the run's SERVER-SET lineage columns
    // (forked_from_run_id / parent_run_id), never from client-controllable
    // run.input: a caller could otherwise point at another tenant's workspace or
    // transcript in TOS (IDOR). The source is used only after confirming it
    // belongs to the same tenant.
    const ckpt = await latestCheckpoint(pool, run.id);
    let seedWorkspaceId: string | undefined;
    let forkAgentState: CheckpointAgentState | undefined;
    const lineageId = run.forked_from_run_id ?? run.parent_run_id;
    if (lineageId) {
      const source = await getRun(pool, lineageId, run.tenant_id);
      if (source) {
        seedWorkspaceId = source.workspace_id ?? undefined; // copy-on-write seed
        // A fork additionally resumes execution state from the source checkpoint.
        if (!ckpt && run.forked_from_run_id) {
          forkAgentState = (await latestCheckpoint(pool, source.id))?.agent_state;
        }
      }
    }
    const agentState: CheckpointAgentState = ckpt?.agent_state ?? forkAgentState ?? { step: 0 };
    let transcript: ChatMessage[] = [];
    if (agentState.transcriptTosKey) {
      transcript = JSON.parse(
        (await providers.objectStore.get(agentState.transcriptTosKey)).toString('utf8'),
      ) as ChatMessage[];
    }
    let step = agentState.step;
    let verifyRetries = 0;
    let noToolTurns = 0;
    // Semantic supervisor state, restored from the checkpoint so loop/stagnation
    // detection and the escalation ladder survive worker crashes (memo §25).
    let supervisorState: SupervisorState =
      (agentState.supervisor as SupervisorState | undefined) ?? initialSupervisorState();
    const supThresholds: SupervisorThresholds = {
      loopThreshold: cfg.SUPERVISOR_LOOP_THRESHOLD,
      stagnationSteps: cfg.SUPERVISOR_STAGNATION_STEPS,
      window: cfg.SUPERVISOR_WINDOW,
      budgetHeadroom: cfg.SUPERVISOR_BUDGET_HEADROOM,
      maxEscalations: cfg.SUPERVISOR_MAX_ESCALATIONS,
    };

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
        parentWorkspaceId: seedWorkspaceId, // server-derived from lineage, tenant-checked
      });

      // Materialize version-pinned skills into the workspace (memo §9.1).
      const skills: MaterializedSkill[] = await materializeSkills(
        sandbox,
        providers.sandbox,
        providers.skills,
        (version.skill_refs as SkillRef[]) ?? [],
      );

      // Resolve MCP toolsets (memo §9.2): their tools join the model tool list
      // and route back through the capability layer.
      const mcp = await resolveMcpTools(
        providers.mcp,
        (version.mcp_toolset_refs as string[]) ?? [],
      );
      const allTools: ToolDef[] = [...TOOL_DEFS, ...mcp.defs];

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
        knowledge: providers.knowledge,
        knowledgeReference: knowledgeReferenceFromConfig(version.knowledge_config),
        mcp: providers.mcp,
        mcpRoute: mcp.route,
        credentials: providers.credentials,
        signal,
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
            agentState: { step, transcriptTosKey, supervisor: supervisorState, ...state },
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
        if (outcome.kind === 'suspend_children') {
          // Children still running (shouldn't happen — resume implies resolved).
          await saveCheckpoint({ pendingToolCall: pending });
          await cleanup();
          return 'suspended_for_children';
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

        // Serialize provider calls for this logical run across lease expiry and
        // retries. The lock is session-scoped, so process/connection loss also
        // releases it. A retry must wait, then recompute capacity from the usage
        // recorded by any stale completion before issuing another call.
        const invocationClient = await pool.connect();
        const invocationAbort = invocationAbortFence(invocationClient, signal);
        let invocation:
          | { kind: 'lease_lost' }
          | { kind: 'budget_exhausted' }
          | {
              kind: 'completed';
              completion: Awaited<ReturnType<ModelProvider['chat']>>;
              freshRun: RunRow;
              remaining: bigint | null;
              stillOwned: boolean;
              tokensUsed: bigint;
            };
        try {
          await invocationClient.query(
            'SELECT pg_advisory_lock(hashtextextended($1, $2))',
            [run.id, MODEL_INVOCATION_LOCK_SEED],
          );
          if (signal.aborted) {
            invocation = { kind: 'lease_lost' };
          } else {
            const startedRun = await withClientTransaction(invocationClient, (tx) =>
              beginModelInvocation(tx, {
                runId: run.id,
                attemptId: attempt.id,
                step,
              }),
            );
            if (!startedRun) {
              invocation = { kind: 'lease_lost' };
            } else {
              const grants = await listGrants(invocationClient, run.id);
              const messages = compileContext({
                version,
                run: startedRun,
                grants,
                transcript,
                userMessages: await unseenUserMessages(invocationClient, run.id),
                approvalOutcomes: await recentApprovalOutcomes(invocationClient, run.id),
                memories: recalledMemories,
                skills,
                toolDocs: TOOL_DOCS,
              });
              const invocationLimit = limitModelInvocation({
                tokenBudget: startedRun.token_budget,
                tokensUsed: startedRun.tokens_used,
                messages,
                tools: allTools,
                requestedMaxTokens: version.model_policy.maxTokens,
                defaultMaxTokens: cfg.MODEL_MAX_OUTPUT_TOKENS,
              });
              if (!invocationLimit) {
                invocation = { kind: 'budget_exhausted' };
              } else {
                const completion = await providers.model.chat({
                  // Adaptive model routing: a supervisor escalation bumps to a
                  // stronger model for subsequent steps (memo §25).
                  model: routeModel(
                    version.model_policy,
                    cfg,
                    supervisorState.escalationLevel,
                  ),
                  messages,
                  tools: allTools,
                  maxTokens: invocationLimit.maxTokens,
                  temperature: version.model_policy.temperature,
                  signal: invocationAbort.signal,
                });
                const recorded = await withClientTransaction(invocationClient, (tx) =>
                  completeModelInvocation(tx, {
                    runId: run.id,
                    attemptId: attempt.id,
                    step,
                    usage: completion.usage,
                  }),
                );
                invocation = {
                  kind: 'completed',
                  completion,
                  freshRun: startedRun,
                  remaining: invocationLimit.remaining,
                  stillOwned: recorded.stillOwned,
                  tokensUsed: recorded.tokensUsed,
                };
              }
            }
          }
        } finally {
          if (!invocationAbort.clientLost()) {
            await invocationClient
              .query('SELECT pg_advisory_unlock(hashtextextended($1, $2))', [
                run.id,
                MODEL_INVOCATION_LOCK_SEED,
              ])
              .catch(() => {});
          }
          const clientLost = invocationAbort.clientLost();
          invocationAbort.dispose();
          invocationClient.release(
            clientLost ? new Error('model invocation lock session lost') : undefined,
          );
        }

        if (invocation.kind === 'lease_lost' || !('stillOwned' in invocation) || !invocation.stillOwned) {
          if (invocation.kind === 'budget_exhausted') {
            await saveCheckpoint();
            await cleanup();
            return 'budget_exhausted';
          }
          return 'lease_lost';
        }
        const { completion, freshRun } = invocation;
        run.tokens_used = invocation.tokensUsed.toString();
        const invocationTokens =
          BigInt(completion.usage.inputTokens) + BigInt(completion.usage.outputTokens);
        if (invocation.remaining !== null && invocationTokens > invocation.remaining) {
          // A provider that ignores maxTokens has violated its kernel contract.
          // Persist the actual metered usage above, but never issue another call.
          await saveCheckpoint();
          await cleanup();
          return 'budget_exhausted';
        }

        transcript.push(completion.message);

        const toolCalls = completion.message.toolCalls ?? [];

        // --- Semantic supervisor (memo §25) ---
        // Watch for loops / stagnation / context loss / low budget and steer the
        // run: a corrective note, a stronger model, a budget-aware wind-down, or,
        // if a stuck run can't be recovered, a definitive terminate so it can
        // never spin forever burning budget.
        if (cfg.SUPERVISOR_ENABLED) {
          const { signature, targets } = actionSignature(toolCalls);
          const sup = superviseStep(
            {
              state: supervisorState,
              proposedSignature: toolCalls.length > 0 ? signature : null,
              proposedTargets: targets,
              completedItems: ledgerCompleted(freshRun.progress),
              remainingItems: ledgerRemaining(freshRun.progress),
              step,
              maxSteps: run.max_steps,
              tokensUsed: BigInt(run.tokens_used),
              tokenBudget: run.token_budget === null ? null : BigInt(run.token_budget),
            },
            supThresholds,
          );
          supervisorState = sup.state;

          if (sup.detections.length > 0 || sup.directive.kind !== 'continue') {
            await recordSupervision(pool, run.id, attempt.id, sup);
          }

          if (sup.directive.kind === 'terminate') {
            // The supervisor owns this terminal FAILED transition; settleAttempt
            // must not retry (the 'failed' exit reason), because retrying would
            // just reproduce the same stuck loop.
            const reason = sup.directive.reason;
            await withTransaction(pool, (tx) =>
              transitionRun(tx, run.id, {
                expectFrom: ['RUNNING'],
                to: 'FAILED',
                event: { type: 'RunFailed', payload: { reason } },
                attemptId: attempt.id,
                reason,
              }),
            );
            await saveCheckpoint();
            await cleanup();
            return 'failed';
          }
          if (
            sup.directive.kind === 'recover' ||
            sup.directive.kind === 'escalate_model' ||
            sup.directive.kind === 'wind_down'
          ) {
            // Inject the steer as a user turn the model sees on its next call.
            transcript.push({ role: 'user', content: sup.directive.note });
          }
        }

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

          if (outcome.kind === 'suspend_children') {
            // Tool router already spawned children + transitioned to
            // WAITING_CHILDREN; the pending call replays on resume and returns
            // the resolved child outcomes for the parent to merge.
            await saveCheckpoint({ pendingToolCall: call });
            await cleanup();
            return 'suspended_for_children';
          }

          if (outcome.kind === 'complete') {
            const result = await finishRun(
              { pool, run, attempt, sandbox, providers, workspaces },
              outcome.summary,
              outcome.artifacts,
              version.verifier_policy as VerifierPolicy,
              step,
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
              return 'failed';
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
  producerStep: number,
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

  const verificationPassedEventSeq = await withTransaction(pool, (tx) =>
    appendEvent(tx, run.id, {
      type: 'VerificationPassed',
      payload: { artifacts },
    }, { attemptId: attempt.id }),
  );

  const stagedArtifacts = await stageArtifactOutputs({
    runId: run.id,
    attemptId: attempt.id,
    producerStep,
    verificationPassedEventSeq: verificationPassedEventSeq.toString(),
    sandbox: ctx.sandbox,
    sandboxProvider: ctx.providers.sandbox,
    objectStore: ctx.providers.objectStore,
  }, artifacts);
  // Final workspace snapshot so the completed state is durable.
  await ctx.workspaces.checkpoint(ctx.sandbox, {
    runId: run.id,
    attemptId: attempt.id,
    workspaceId: run.workspace_id!,
  });

  await withTransaction(pool, async (tx) => {
    for (const artifact of stagedArtifacts) await createArtifact(tx, artifact);
    await transitionRun(tx, run.id, {
      expectFrom: ['VERIFYING'],
      to: 'COMPLETED',
      event: {
        type: 'RunCompleted',
        payload: { summary, artifacts: stagedArtifacts.map((artifact) => artifact.id) },
      },
      attemptId: attempt.id,
    });
  });
  return 'completed';
}

/** All user messages received so far (Phase 1: presented every epoch). */
async function unseenUserMessages(q: Pool | Tx, runId: string): Promise<string[]> {
  const events = await listEvents(q, runId, { limit: 1000 });
  return events
    .filter((e) => e.type === 'UserMessageReceived')
    .map((e) => String(e.payload.message ?? ''));
}

async function recentApprovalOutcomes(
  q: Pool | Tx,
  runId: string,
): Promise<{ action: string; decision: string }[]> {
  const approvals = await listApprovals(q, runId);
  return approvals
    .filter((a) => a.status !== 'PENDING')
    .map((a) => ({
      action: `${a.action.action} on ${a.action.resource ?? 'unknown'}`,
      decision: a.status,
    }));
}
