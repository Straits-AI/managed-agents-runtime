import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import type { SemanticAction } from '../core/types.js';
import { newId } from '../ids.js';

type Q = Pool | Tx;

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

export interface ApprovalRow {
  id: string;
  run_id: string;
  requested_by_attempt_id: string | null;
  action: SemanticAction;
  status: ApprovalStatus;
  decision_by: string | null;
  decided_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

export async function insertApproval(
  tx: Tx,
  input: { runId: string; attemptId: string; action: SemanticAction },
): Promise<ApprovalRow> {
  const { rows } = await tx.query<ApprovalRow>(
    `INSERT INTO approvals (id, run_id, requested_by_attempt_id, action)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [newId('apr'), input.runId, input.attemptId, JSON.stringify(input.action)],
  );
  return rows[0]!;
}

export async function getApproval(q: Q, id: string): Promise<ApprovalRow | null> {
  const { rows } = await q.query<ApprovalRow>('SELECT * FROM approvals WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function listApprovals(
  q: Q,
  runId: string,
  status?: ApprovalStatus,
): Promise<ApprovalRow[]> {
  const { rows } = await q.query<ApprovalRow>(
    `SELECT * FROM approvals WHERE run_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at ASC`,
    [runId, status ?? null],
  );
  return rows;
}

/**
 * Lock and revalidate an approval at the execution boundary using the database
 * clock. An expired PENDING/APPROVED row is durably transitioned to EXPIRED so
 * no worker can continue using a stale authorization decision.
 */
export async function lockApprovalForExecution(
  tx: Tx,
  input: {
    approvalId: string;
    runId: string;
    action: string;
    resource: string;
    idempotencyKey: string;
  },
): Promise<ApprovalRow | null> {
  const { rows } = await tx.query<ApprovalRow & { is_expired: boolean }>(
    `SELECT a.*,
            (a.expires_at IS NOT NULL AND a.expires_at <= clock_timestamp()) AS is_expired
     FROM approvals a
     WHERE a.id = $1 AND a.run_id = $2
       AND a.action->>'action' = $3
       AND a.action->>'resource' = $4
       AND a.action->'arguments'->>'__idemKey' = $5
     FOR UPDATE`,
    [
      input.approvalId,
      input.runId,
      input.action,
      input.resource,
      input.idempotencyKey,
    ],
  );
  const approval = rows[0];
  if (!approval) return null;
  if (
    approval.is_expired &&
    (approval.status === 'PENDING' || approval.status === 'APPROVED')
  ) {
    const { rows: expired } = await tx.query<ApprovalRow>(
      `UPDATE approvals SET status = 'EXPIRED'
       WHERE id = $1 AND status IN ('PENDING', 'APPROVED')
       RETURNING *`,
      [approval.id],
    );
    return expired[0] ?? null;
  }
  return approval;
}

/** Decide a PENDING approval; returns null if it was not PENDING (idempotent-safe). */
export async function decideApproval(
  tx: Tx,
  approvalId: string,
  decision: 'APPROVED' | 'DENIED',
  decidedBy: string,
): Promise<ApprovalRow | null> {
  const { rows } = await tx.query<ApprovalRow>(
    `UPDATE approvals
     SET status = $2, decision_by = $3, decided_at = now()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING *`,
    [approvalId, decision, decidedBy],
  );
  return rows[0] ?? null;
}
