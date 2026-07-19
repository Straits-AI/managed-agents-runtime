import type { Tx } from '../db/tx.js';
import type { RunRow } from '../core/types.js';
import { appendEvent } from '../core/transition.js';

export async function beginModelInvocation(
  tx: Tx,
  input: { runId: string; attemptId: string; step: number },
): Promise<RunRow | null> {
  const { rows } = await tx.query<RunRow>(
    `SELECT r.* FROM runs r
     JOIN run_attempts a ON a.id = $2 AND a.run_id = r.id
     WHERE r.id = $1
       AND r.status = 'RUNNING'
       AND r.current_attempt_id = $2
       AND a.state = 'ACTIVE'
     FOR UPDATE OF r`,
    [input.runId, input.attemptId],
  );
  const run = rows[0];
  if (!run) return null;
  await appendEvent(
    tx,
    input.runId,
    { type: 'ModelInvocationStarted', payload: { step: input.step } },
    { attemptId: input.attemptId },
  );
  return run;
}

/**
 * Add metered usage to the latest durable total under a run-row lock. Usage is
 * recorded even when the producing attempt lost its lease after dispatch; this
 * prevents a retry and a stale completion from last-write-wins undercounting.
 */
export async function completeModelInvocation(
  tx: Tx,
  input: {
    runId: string;
    attemptId: string;
    step: number;
    usage: { inputTokens: number; outputTokens: number };
  },
): Promise<{ tokensUsed: bigint; stillOwned: boolean }> {
  const { rows } = await tx.query<
    Pick<RunRow, 'tokens_used' | 'current_attempt_id' | 'status'>
  >('SELECT tokens_used, current_attempt_id, status FROM runs WHERE id = $1 FOR UPDATE', [
    input.runId,
  ]);
  const run = rows[0];
  if (!run) throw new Error(`run missing while recording model usage: ${input.runId}`);
  const invocationTokens =
    BigInt(input.usage.inputTokens) + BigInt(input.usage.outputTokens);
  const tokensUsed = BigInt(run.tokens_used) + invocationTokens;
  await appendEvent(
    tx,
    input.runId,
    {
      type: 'ModelInvocationCompleted',
      payload: { step: input.step, usage: input.usage },
    },
    {
      attemptId: input.attemptId,
      patch: { tokens_used: tokensUsed.toString() },
    },
  );
  const { rows: attempts } = await tx.query<{ state: string }>(
    'SELECT state FROM run_attempts WHERE id = $1',
    [input.attemptId],
  );
  return {
    tokensUsed,
    stillOwned:
      run.status === 'RUNNING' &&
      run.current_attempt_id === input.attemptId &&
      attempts[0]?.state === 'ACTIVE',
  };
}
