import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import type { CheckpointAgentState, ProgressLedger } from '../core/types.js';
import { newId } from '../ids.js';
import {
  CHECKPOINT_SCHEMA_VERSION,
  decodeCheckpointEnvelope,
  validateCheckpointEnvelope,
} from '../core/checkpoints.js';

type Q = Pool | Tx;

export interface CheckpointRow {
  id: string;
  run_id: string;
  attempt_id: string;
  event_seq: string;
  workspace_revision_id: string | null;
  progress: ProgressLedger;
  agent_state: CheckpointAgentState;
  schema_version: number;
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
  validateCheckpointEnvelope(input.agentState);
  const { rows } = await tx.query<CheckpointRow>(
    `INSERT INTO checkpoints
       (id, run_id, attempt_id, event_seq, workspace_revision_id, progress,
        agent_state, schema_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      newId('ckpt'),
      input.runId,
      input.attemptId,
      input.eventSeq.toString(),
      input.workspaceRevisionId ?? null,
      JSON.stringify(input.progress),
      JSON.stringify(input.agentState),
      CHECKPOINT_SCHEMA_VERSION,
    ],
  );
  rows[0]!.agent_state = decodeCheckpointEnvelope(
    rows[0]!.schema_version,
    rows[0]!.agent_state,
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
  const row = rows[0];
  if (!row) return null;
  row.agent_state = decodeCheckpointEnvelope(row.schema_version, row.agent_state);
  return row;
}
