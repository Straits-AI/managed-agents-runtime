import type { Tx } from '../db/tx.js';
import type { EventType, RunRow, RunStatus } from './types.js';
import { InvalidTransitionError, isTerminal, isTransitionAllowed } from './stateMachine.js';
import { releaseRunAdmission } from '../store/admissions.js';
import { MODEL_INVOCATION_LOCK_SEED } from './locks.js';

/**
 * The single choke point for run state changes (memo §11, §12).
 *
 * In ONE transaction (caller supplies the open Tx):
 *   1. SELECT ... FOR UPDATE on the run row
 *   2. assert status ∈ expectFrom and the edge is legal
 *   3. append run_events with seq = last_event_seq + 1 (gapless)
 *   4. UPDATE runs (status, last_event_seq, optional patch columns)
 *   5. INSERT outbox
 *
 * No other code path may update runs.status.
 */
export interface TransitionOptions {
  expectFrom: RunStatus[];
  to: RunStatus;
  event: { type: EventType; payload?: Record<string, unknown> };
  attemptId?: string;
  reason?: string;
  patch?: Partial<
    Pick<
      RunRow,
      'workspace_id' | 'current_attempt_id' | 'progress' | 'tokens_used' | 'awaited_signal'
      | 'awaited_signal_correlation_id' | 'awaited_signal_schema'
      | 'result' | 'result_size_bytes'
    >
  >;
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

export class UnexpectedStatusError extends Error {
  constructor(
    public readonly runId: string,
    public readonly actual: RunStatus,
    public readonly expected: RunStatus[],
  ) {
    super(
      `Run ${runId} is ${actual}, expected one of: ${expected.join(', ')}`,
    );
    this.name = 'UnexpectedStatusError';
  }
}

async function lockRun(tx: Tx, runId: string): Promise<RunRow> {
  const { rows } = await tx.query<RunRow>(
    'SELECT * FROM runs WHERE id = $1 FOR UPDATE',
    [runId],
  );
  const run = rows[0];
  if (!run) throw new RunNotFoundError(runId);
  return run;
}

async function insertEvent(
  tx: Tx,
  runId: string,
  seq: bigint,
  type: EventType,
  payload: Record<string, unknown>,
  attemptId: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO run_events (run_id, seq, type, payload, attempt_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [runId, seq.toString(), type, JSON.stringify(payload), attemptId],
  );
  await tx.query(
    `INSERT INTO outbox (topic, key, payload) VALUES ('run_events', $1, $2)`,
    [runId, JSON.stringify({ runId, seq: seq.toString(), type, ...payload })],
  );
}

async function projectTopLevelRunStateToSession(
  tx: Tx,
  run: RunRow,
  status: RunStatus,
): Promise<void> {
  if (!run.managed_session_id || run.parent_run_id !== null) return;

  const state = status === 'WAITING_APPROVAL'
    ? 'REQUIRES_ACTION'
    : ['WAITING_SIGNAL', 'WAITING_CHILDREN', 'SLEEPING', 'SUSPENDED'].includes(status)
      ? 'WAITING'
      : isTerminal(status)
        ? 'IDLE'
        : 'ACTIVE';
  const clearCurrentRun = isTerminal(status);
  await tx.query(
    `UPDATE managed_sessions
     SET state = $2,
         current_top_level_run_id = CASE WHEN $3 THEN NULL ELSE current_top_level_run_id END,
         version = version + 1,
         updated_at = now()
     WHERE id = $1
       AND current_top_level_run_id = $4
       AND state NOT IN ('CANCELLED', 'ARCHIVED')
       AND (state IS DISTINCT FROM $2
            OR ($3 AND current_top_level_run_id IS NOT NULL))`,
    [run.managed_session_id, state, clearCurrentRun, run.id],
  );
}

export async function transitionRun(
  tx: Tx,
  runId: string,
  opts: TransitionOptions,
): Promise<RunRow> {
  if (isTerminal(opts.to)) {
    // A provider call may outlive its worker lease. Terminal transitions wait
    // for that call to finish and record actual usage before releasing the
    // run's admission capacity. Every model completion takes this same lock
    // before the run-row lock, preserving a single lock order.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, $2))', [
      runId,
      MODEL_INVOCATION_LOCK_SEED,
    ]);
  }
  const run = await lockRun(tx, runId);

  if (!opts.expectFrom.includes(run.status)) {
    throw new UnexpectedStatusError(runId, run.status, opts.expectFrom);
  }
  if (!isTransitionAllowed(run.status, opts.to)) {
    throw new InvalidTransitionError(runId, run.status, opts.to);
  }

  const seq = BigInt(run.last_event_seq) + 1n;
  await insertEvent(
    tx,
    runId,
    seq,
    opts.event.type,
    { from: run.status, to: opts.to, ...opts.event.payload },
    opts.attemptId ?? null,
  );

  const patch = opts.patch ?? {};
  const { rows } = await tx.query<RunRow>(
    `UPDATE runs SET
       status = $2,
       status_reason = $3,
       last_event_seq = $4,
       workspace_id = COALESCE($5, workspace_id),
       current_attempt_id = CASE WHEN $8 THEN $6 ELSE current_attempt_id END,
       progress = COALESCE($7, progress),
       tokens_used = COALESCE($9, tokens_used),
       awaited_signal = CASE WHEN $10 THEN $11 ELSE awaited_signal END,
       result = CASE WHEN $12 THEN $13::jsonb ELSE result END,
       result_size_bytes = CASE WHEN $14 THEN $15 ELSE result_size_bytes END,
       awaited_signal_correlation_id = CASE WHEN $16 THEN $17 ELSE awaited_signal_correlation_id END,
       awaited_signal_schema = CASE WHEN $18 THEN $19::jsonb ELSE awaited_signal_schema END,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      runId,
      opts.to,
      opts.reason ?? null,
      seq.toString(),
      patch.workspace_id ?? null,
      patch.current_attempt_id ?? null,
      patch.progress !== undefined ? JSON.stringify(patch.progress) : null,
      'current_attempt_id' in patch,
      patch.tokens_used ?? null,
      'awaited_signal' in patch,
      patch.awaited_signal ?? null,
      'result' in patch,
      patch.result === undefined || patch.result === null ? null : JSON.stringify(patch.result),
      'result_size_bytes' in patch,
      patch.result_size_bytes ?? null,
      'awaited_signal_correlation_id' in patch,
      patch.awaited_signal_correlation_id ?? null,
      'awaited_signal_schema' in patch,
      patch.awaited_signal_schema === undefined || patch.awaited_signal_schema === null
        ? null
        : JSON.stringify(patch.awaited_signal_schema),
    ],
  );
  if (isTerminal(opts.to)) {
    await releaseRunAdmission(tx, runId, `run_${opts.to.toLowerCase()}`);
  }
  await projectTopLevelRunStateToSession(tx, run, opts.to);
  return rows[0]!;
}

/**
 * Append a non-transition event (ModelInvocationCompleted, ProgressUpdated,
 * ...). Locks the run row so the per-run sequence stays gapless under
 * concurrent writers.
 */
export async function appendEvent(
  tx: Tx,
  runId: string,
  event: { type: EventType; payload?: Record<string, unknown> },
  opts: {
    attemptId?: string;
    patch?: TransitionOptions['patch'];
  } = {},
): Promise<bigint> {
  const run = await lockRun(tx, runId);
  const seq = BigInt(run.last_event_seq) + 1n;
  await insertEvent(
    tx,
    runId,
    seq,
    event.type,
    event.payload ?? {},
    opts.attemptId ?? null,
  );

  const patch = opts.patch ?? {};
  await tx.query(
    `UPDATE runs SET
       last_event_seq = $2,
       progress = COALESCE($3, progress),
       tokens_used = COALESCE($4, tokens_used),
       workspace_id = COALESCE($5, workspace_id),
       updated_at = now()
     WHERE id = $1`,
    [
      runId,
      seq.toString(),
      patch.progress !== undefined ? JSON.stringify(patch.progress) : null,
      patch.tokens_used ?? null,
      patch.workspace_id ?? null,
    ],
  );
  return seq;
}
