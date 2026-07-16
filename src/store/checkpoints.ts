import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import type { CheckpointAgentState, ProgressLedger } from '../core/types.js';
import { newId } from '../ids.js';

type Q = Pool | Tx;

export interface CheckpointRow {
  id: string;
  run_id: string;
  attempt_id: string;
  event_seq: string;
  workspace_revision_id: string | null;
  progress: ProgressLedger;
  agent_state: CheckpointAgentState;
  created_at: Date;
}

export async function insertCheckpoint(
  tx: Tx,
  input: {
    runId: string;
    attemptId: string;
    eventSeq: bigint;
    workspaceRevisionId?: string;
    progress: ProgressLedger;
    agentState: CheckpointAgentState;
  },
): Promise<CheckpointRow> {
  const { rows } = await tx.query<CheckpointRow>(
    `INSERT INTO checkpoints
       (id, run_id, attempt_id, event_seq, workspace_revision_id, progress, agent_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      newId('ckpt'),
      input.runId,
      input.attemptId,
      input.eventSeq.toString(),
      input.workspaceRevisionId ?? null,
      JSON.stringify(input.progress),
      JSON.stringify(input.agentState),
    ],
  );
  return rows[0]!;
}

export async function latestCheckpoint(
  q: Q,
  runId: string,
): Promise<CheckpointRow | null> {
  const { rows } = await q.query<CheckpointRow>(
    `SELECT * FROM checkpoints WHERE run_id = $1
     ORDER BY event_seq DESC, created_at DESC LIMIT 1`,
    [runId],
  );
  return rows[0] ?? null;
}
