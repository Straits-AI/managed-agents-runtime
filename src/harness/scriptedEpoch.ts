import { createHash } from 'node:crypto';
import type { EpochContext } from './worker.js';
import type {
  EpochExitReason,
  SemanticAction,
  SignalPayloadSchema,
} from '../core/types.js';
import { withTransaction } from '../db/tx.js';
import { appendEvent, transitionRun } from '../core/transition.js';
import { insertCheckpoint, latestCheckpoint } from '../store/checkpoints.js';
import { insertApproval, listApprovals } from '../store/approvals.js';
import { listEvents } from '../store/events.js';
import { getRun } from '../store/runs.js';
import { spawnChildren } from '../scheduler/children.js';
import { tokenBudgetExceeded } from './limits.js';
import { MODEL_INVOCATION_LOCK_SEED } from '../core/locks.js';
import { buildBoundedRunResult } from '../core/delegatedResults.js';
import { createArtifact, type CreateArtifactInput } from '../store/artifacts.js';
import { FsObjectStore } from '../providers/local/fsObjectStore.js';
import {
  deterministicArtifactId,
  mimeTypeFor,
  normalizeArtifactPath,
} from './artifacts.js';
import {
  createCheckpointEnvelope,
  type CheckpointEnvelopeV2,
} from '../core/checkpoints.js';

/**
 * Deterministic no-model epoch used by tests and pre-credential milestones.
 * Interprets run.input.script — an array of ops — resuming from the last
 * checkpoint's step index, exactly as the real epoch resumes from a
 * checkpoint.
 */
export type ScriptOp =
  | { op: 'progress'; note: string }
  | { op: 'sleep'; ms: number }
  | { op: 'checkpoint' }
  | { op: 'requestApproval'; action: SemanticAction }
  | {
      op: 'waitSignal';
      name: string;
      correlationId?: string;
      payloadSchema?: SignalPayloadSchema;
    }
  | { op: 'delegate'; goals: string[]; childScript?: ScriptOp[] }
  | { op: 'fail'; once?: boolean }
  | {
      op: 'complete';
      artifacts?: Array<{ path: string; content: string }>;
    };

async function stageScriptedArtifacts(
  ctx: EpochContext,
  artifacts: Array<{ path: string; content: string }>,
  producerStep: number,
): Promise<CreateArtifactInput[]> {
  if (artifacts.length === 0) return [];
  if (!ctx.cfg.LOCAL_OBJECT_STORE_DIR) {
    throw new Error('scripted artifacts require LOCAL_OBJECT_STORE_DIR');
  }
  if (artifacts.length > 32) throw new Error('scripted completion supports at most 32 artifacts');
  const store = new FsObjectStore(ctx.cfg.LOCAL_OBJECT_STORE_DIR, ctx.cfg.TOS_MAX_OBJECT_BYTES);
  const seen = new Set<string>();
  const staged: CreateArtifactInput[] = [];
  for (const artifact of artifacts) {
    const sourcePath = normalizeArtifactPath(artifact.path);
    if (seen.has(sourcePath)) throw new Error(`duplicate scripted artifact path: ${sourcePath}`);
    seen.add(sourcePath);
    const bytes = Buffer.from(artifact.content, 'utf8');
    if (bytes.byteLength > 100_000) throw new Error('scripted artifact exceeds 100000 bytes');
    const digestHex = createHash('sha256').update(bytes).digest('hex');
    const id = deterministicArtifactId(ctx.run.id, sourcePath, digestHex);
    const objectKey = `runs/${ctx.run.id}/artifacts/${id}`;
    await store.put(objectKey, bytes);
    staged.push({
      id,
      producerRunId: ctx.run.id,
      producerAttemptId: ctx.attempt.id,
      producerStep,
      digest: `sha256:${digestHex}`,
      mimeType: mimeTypeFor(sourcePath),
      sizeBytes: bytes.byteLength,
      logicalRole: 'deliverable',
      sourcePath,
      sourceRefs: [{ kind: 'scripted_fixture', path: sourcePath }],
      verificationRefs: [{ kind: 'scripted_verifier', status: 'passed' }],
      evidenceRefs: [],
      objectKey,
    });
  }
  return staged;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

function checkpointReferences(
  runId: string,
  eventSeq: bigint | string,
  childRunIds: string[] = [],
): CheckpointEnvelopeV2['references'] {
  return {
    childRunIds,
    artifactIds: [],
    evidence: [{ runId, eventSeq: eventSeq.toString() }],
  };
}

export async function scriptedEpoch(ctx: EpochContext): Promise<EpochExitReason> {
  const { pool, run, attempt, signal } = ctx;
  const script = (run.input.script ?? []) as ScriptOp[];

  const ckpt = await latestCheckpoint(pool, run.id);
  // A forked run resumes from the SOURCE run's checkpoint step (memo §20),
  // derived from the server-set forked_from_run_id (never client input) and only
  // when the source is the same tenant.
  let step = ckpt?.agent_state.step ?? 0;
  if (!ckpt && run.forked_from_run_id) {
    const source = await getRun(pool, run.forked_from_run_id, run.tenant_id);
    if (source) {
      step = (await latestCheckpoint(pool, source.id))?.agent_state.step ?? 0;
    }
  }

  while (step < script.length) {
    if (signal.aborted) return 'lease_lost';
    // Same hard ceilings the real epoch enforces, so budget/step exhaustion is
    // testable without a live model.
    if (step >= run.max_steps || (await tokenBudgetExceeded(pool, run.id))) {
      return 'budget_exhausted';
    }
    const op = script[step]!;

    switch (op.op) {
      case 'progress':
        await withTransaction(pool, (tx) =>
          appendEvent(tx, run.id, {
            type: 'ProgressUpdated',
            payload: { note: op.note, step },
          }, {
            attemptId: attempt.id,
            patch: { progress: { completed: [op.note] } },
          }),
        );
        break;

      case 'sleep':
        await abortableSleep(op.ms, signal);
        if (signal.aborted) return 'lease_lost';
        break;

      case 'checkpoint':
        await withTransaction(pool, async (tx) => {
          const seq = await appendEvent(
            tx,
            run.id,
            { type: 'WorkspaceCheckpointed', payload: { step } },
            { attemptId: attempt.id },
          );
          await insertCheckpoint(tx, {
            runId: run.id,
            attemptId: attempt.id,
            eventSeq: seq,
            progress: {},
            agentState: createCheckpointEnvelope({
              step: step + 1,
              references: checkpointReferences(run.id, seq),
            }),
          });
        });
        break;

      case 'requestApproval': {
        // On resume after approval, this step is already decided — skip it.
        const decided = (await listApprovals(pool, run.id)).find(
          (a) =>
            a.status !== 'PENDING' &&
            (a.action.arguments as { scriptStep?: number }).scriptStep === step,
        );
        if (decided) break;

        await withTransaction(pool, async (tx) => {
          const approval = await insertApproval(tx, {
            runId: run.id,
            attemptId: attempt.id,
            action: {
              ...op.action,
              arguments: { ...op.action.arguments, scriptStep: step },
            },
          });
          const seq = await appendEvent(
            tx,
            run.id,
            {
              type: 'ApprovalRequested',
              payload: { approvalId: approval.id, action: op.action.action },
            },
            { attemptId: attempt.id },
          );
          await insertCheckpoint(tx, {
            runId: run.id,
            attemptId: attempt.id,
            eventSeq: seq,
            progress: {},
            agentState: createCheckpointEnvelope({
              step: step + 1,
              commitments: {
                awaitedSignal: null,
                pendingApprovalIds: [approval.id],
                activeChildRunIds: [],
                pendingWork: {
                  active: [],
                  blocked: [{ item: op.action.action, reason: 'approval pending' }],
                  remaining: [],
                },
              },
              references: checkpointReferences(run.id, seq),
            }),
          });
          await transitionRun(tx, run.id, {
            expectFrom: ['RUNNING'],
            to: 'WAITING_APPROVAL',
            event: { type: 'ApprovalRequested', payload: { approvalId: approval.id } },
            attemptId: attempt.id,
          });
        });
        return 'suspended_for_approval';
      }

      case 'waitSignal': {
        // Resume-safe: if the signal already arrived, continue past the wait.
        const { rows } = await pool.query(
          `SELECT 1 FROM run_events
           WHERE run_id = $1 AND type = 'SignalReceived' AND payload->>'name' = $2 LIMIT 1`,
          [run.id, op.name],
        );
        if (rows.length > 0) break;

        await withTransaction(pool, async (tx) => {
          const seq = await appendEvent(
            tx,
            run.id,
            { type: 'SignalReceived', payload: { waiting_for: op.name } },
            { attemptId: attempt.id },
          );
          await insertCheckpoint(tx, {
            runId: run.id,
            attemptId: attempt.id,
            eventSeq: seq,
            progress: {},
            agentState: createCheckpointEnvelope({
              step: step + 1,
              commitments: {
                awaitedSignal: op.name,
                pendingApprovalIds: [],
                activeChildRunIds: [],
                pendingWork: {
                  active: [],
                  blocked: [{ item: `wait for ${op.name}`, reason: 'signal pending' }],
                  remaining: [],
                },
              },
              references: checkpointReferences(run.id, seq),
            }),
          });
          await transitionRun(tx, run.id, {
            expectFrom: ['RUNNING'],
            to: 'WAITING_SIGNAL',
            event: { type: 'SignalReceived', payload: { waiting_for: op.name } },
            attemptId: attempt.id,
            patch: {
              awaited_signal: op.name,
              awaited_signal_correlation_id: op.correlationId ?? null,
              awaited_signal_schema: op.payloadSchema ?? { type: 'any' },
            },
          });
        });
        return 'suspended_for_signal';
      }

      case 'delegate': {
        // On resume after children resolve, this step is already done — skip it.
        const alreadySpawned = (await listEvents(pool, run.id)).some(
          (e) => e.type === 'ChildRunSpawned' && (e.payload as { childRunIds?: string[] }).childRunIds,
        );
        if (alreadySpawned) break;

        await withTransaction(pool, async (tx) => {
          const childRunIds = await spawnChildren(tx, {
            parentRunId: run.id,
            attemptId: attempt.id,
            children: op.goals.map((g) => ({
              agentVersionId: run.agent_version_id,
              goal: g,
              input: { script: (op.childScript ?? [{ op: 'complete' }]) as ScriptOp[] },
            })),
          });
          const { rows } = await tx.query<{ last_event_seq: string }>(
            'SELECT last_event_seq FROM runs WHERE id = $1',
            [run.id],
          );
          const eventSeq = rows[0]!.last_event_seq;
          await insertCheckpoint(tx, {
            runId: run.id,
            attemptId: attempt.id,
            eventSeq: BigInt(eventSeq),
            progress: {},
            agentState: createCheckpointEnvelope({
              step: step + 1,
              commitments: {
                awaitedSignal: null,
                pendingApprovalIds: [],
                activeChildRunIds: childRunIds,
                pendingWork: {
                  active: op.goals,
                  blocked: [],
                  remaining: ['merge delegated results'],
                },
              },
              references: checkpointReferences(run.id, eventSeq, childRunIds),
            }),
          });
        });
        return 'suspended_for_children';
      }

      case 'fail':
        if (op.once && attempt.attempt_no > 1) break; // succeed on retry
        throw new Error(`scripted failure at step ${step}`);

      case 'complete': {
        const scriptedResult = buildBoundedRunResult('scripted completion', {});
        const stagedArtifacts = await stageScriptedArtifacts(ctx, op.artifacts ?? [], step);
        await withTransaction(pool, async (tx) => {
          // Preserve the atomic VERIFYING -> COMPLETED scripted fast path while
          // taking the terminal lock before the first run-row lock.
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, $2))', [
            run.id,
            MODEL_INVOCATION_LOCK_SEED,
          ]);
          await transitionRun(tx, run.id, {
            expectFrom: ['RUNNING'],
            to: 'VERIFYING',
            event: { type: 'VerificationStarted' },
            attemptId: attempt.id,
          });
          await transitionRun(tx, run.id, {
            expectFrom: ['VERIFYING'],
            to: 'COMPLETED',
            event: {
              type: 'RunCompleted',
              payload: {
                verification: 'scripted-pass',
                artifacts: stagedArtifacts.map((artifact) => artifact.id),
              },
            },
            attemptId: attempt.id,
            patch: {
              result: scriptedResult.value,
              result_size_bytes: scriptedResult.sizeBytes,
            },
          });
          for (const artifact of stagedArtifacts) await createArtifact(tx, artifact);
        });
        return 'completed';
      }
    }
    step += 1;
  }

  // Script ended without an explicit complete op.
  const scriptedResult = buildBoundedRunResult('scripted completion', {});
  await withTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, $2))', [
      run.id,
      MODEL_INVOCATION_LOCK_SEED,
    ]);
    await transitionRun(tx, run.id, {
      expectFrom: ['RUNNING'],
      to: 'VERIFYING',
      event: { type: 'VerificationStarted' },
      attemptId: attempt.id,
    });
    await transitionRun(tx, run.id, {
      expectFrom: ['VERIFYING'],
      to: 'COMPLETED',
      event: { type: 'RunCompleted' },
      attemptId: attempt.id,
      patch: {
        result: scriptedResult.value,
        result_size_bytes: scriptedResult.sizeBytes,
      },
    });
  });
  return 'completed';
}
