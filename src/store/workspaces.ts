import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { newId } from '../ids.js';

type Q = Pool | Tx;

export interface WorkspaceRevisionRow {
  id: string;
  workspace_id: string;
  parent_revision_id: string | null;
  tos_key: string;
  digest: string;
  size_bytes: string | null;
  created_by_attempt_id: string | null;
  created_at: Date;
}

/** Record an immutable snapshot and advance the workspace head. */
export async function insertRevision(
  tx: Tx,
  input: {
    workspaceId: string;
    tosKey: string;
    digest: string;
    sizeBytes?: number;
    attemptId?: string;
  },
): Promise<WorkspaceRevisionRow> {
  const { rows: heads } = await tx.query<{ head_revision_id: string | null }>(
    'SELECT head_revision_id FROM workspaces WHERE id = $1 FOR UPDATE',
    [input.workspaceId],
  );
  if (heads.length === 0) throw new Error(`Workspace not found: ${input.workspaceId}`);

  const { rows } = await tx.query<WorkspaceRevisionRow>(
    `INSERT INTO workspace_revisions
       (id, workspace_id, parent_revision_id, tos_key, digest, size_bytes, created_by_attempt_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      newId('rev'),
      input.workspaceId,
      heads[0]!.head_revision_id,
      input.tosKey,
      input.digest,
      input.sizeBytes ?? null,
      input.attemptId ?? null,
    ],
  );
  await tx.query('UPDATE workspaces SET head_revision_id = $2 WHERE id = $1', [
    input.workspaceId,
    rows[0]!.id,
  ]);
  return rows[0]!;
}

export async function getRevision(
  q: Q,
  revisionId: string,
): Promise<WorkspaceRevisionRow | null> {
  const { rows } = await q.query<WorkspaceRevisionRow>(
    'SELECT * FROM workspace_revisions WHERE id = $1',
    [revisionId],
  );
  return rows[0] ?? null;
}

export async function headRevision(
  q: Q,
  workspaceId: string,
): Promise<WorkspaceRevisionRow | null> {
  const { rows } = await q.query<WorkspaceRevisionRow>(
    `SELECT r.* FROM workspaces w
     JOIN workspace_revisions r ON r.id = w.head_revision_id
     WHERE w.id = $1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

export async function listRevisions(
  q: Q,
  workspaceId: string,
): Promise<WorkspaceRevisionRow[]> {
  const { rows } = await q.query<WorkspaceRevisionRow>(
    'SELECT * FROM workspace_revisions WHERE workspace_id = $1 ORDER BY created_at ASC',
    [workspaceId],
  );
  return rows;
}
