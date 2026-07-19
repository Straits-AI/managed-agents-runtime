import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { newId } from '../ids.js';

type Q = Pool | Tx;

export type ReceiptStatus =
  | 'PENDING'
  | 'COMMITTED'
  | 'FAILED'
  | 'NEEDS_RECONCILIATION';

export interface ToolReceiptRow {
  id: string;
  run_id: string;
  attempt_id: string;
  step: number;
  semantic_action: string;
  request_digest: string;
  idempotency_key: string;
  approval_id: string | null;
  status: ReceiptStatus;
  external_txn_id: string | null;
  result_digest: string | null;
  result: Record<string, unknown> | null;
  reversibility: string;
  started_at: Date;
  completed_at: Date | null;
}

export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable stringify (sorted keys) so identical args yield identical digests. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Idempotency key for an external action (memo §18): identical
 * (run, action, canonical args, approval) always maps to the same key,
 * across attempts and workers.
 */
export function idempotencyKey(input: {
  runId: string;
  action: string;
  args: Record<string, unknown>;
  approvalId?: string | null;
}): string {
  return sha256(
    `${input.runId}\n${input.action}\n${canonicalJson(input.args)}\n${input.approvalId ?? ''}`,
  );
}

export async function findReceiptByKey(
  q: Q,
  runId: string,
  key: string,
): Promise<ToolReceiptRow | null> {
  const { rows } = await q.query<ToolReceiptRow>(
    'SELECT * FROM tool_receipts WHERE run_id = $1 AND idempotency_key = $2',
    [runId, key],
  );
  return rows[0] ?? null;
}

/**
 * Replacement runs are fresh attempts at the same logical subtask. External
 * idempotency must therefore be rooted at the first run in the replacement
 * lineage rather than reset whenever a new run id is allocated.
 */
export async function replacementRootRunId(q: Q, runId: string): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `WITH RECURSIVE lineage AS (
       SELECT id, replaces_run_id FROM runs WHERE id = $1
       UNION
       SELECT r.id, r.replaces_run_id
       FROM runs r
       JOIN lineage l ON r.id = l.replaces_run_id
     )
     SELECT id FROM lineage WHERE replaces_run_id IS NULL LIMIT 1`,
    [runId],
  );
  return rows[0]?.id ?? runId;
}

/** Find a receipt created by this run or any predecessor it replaces. */
export async function findReceiptByLineageKey(
  q: Q,
  runId: string,
  key: string,
): Promise<ToolReceiptRow | null> {
  const { rows } = await q.query<ToolReceiptRow>(
    `WITH RECURSIVE lineage AS (
       SELECT id, replaces_run_id FROM runs WHERE id = $1
       UNION
       SELECT r.id, r.replaces_run_id
       FROM runs r
       JOIN lineage l ON r.id = l.replaces_run_id
     )
     SELECT receipt.*
     FROM tool_receipts receipt
     JOIN lineage ON lineage.id = receipt.run_id
     WHERE receipt.idempotency_key = $2
     ORDER BY
       CASE receipt.status WHEN 'COMMITTED' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,
       receipt.started_at DESC
     LIMIT 1`,
    [runId, key],
  );
  return rows[0] ?? null;
}

export async function insertPendingReceipt(
  tx: Tx,
  input: {
    runId: string;
    attemptId: string;
    step: number;
    action: string;
    args: Record<string, unknown>;
    idempotencyKey: string;
    approvalId?: string | null;
    reversibility?: string;
  },
): Promise<ToolReceiptRow> {
  const { rows } = await tx.query<ToolReceiptRow>(
    `INSERT INTO tool_receipts
       (id, run_id, attempt_id, step, semantic_action, request_digest,
        idempotency_key, approval_id, status, reversibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)
     RETURNING *`,
    [
      newId('rcpt'),
      input.runId,
      input.attemptId,
      input.step,
      input.action,
      sha256(canonicalJson(input.args)),
      input.idempotencyKey,
      input.approvalId ?? null,
      input.reversibility ?? 'unknown',
    ],
  );
  return rows[0]!;
}

export async function commitReceipt(
  tx: Tx,
  receiptId: string,
  result: { externalTxnId?: string; result: Record<string, unknown> },
): Promise<void> {
  await tx.query(
    `UPDATE tool_receipts
     SET status = 'COMMITTED', external_txn_id = $2, result = $3,
         result_digest = $4, completed_at = now()
     WHERE id = $1 AND status = 'PENDING'`,
    [
      receiptId,
      result.externalTxnId ?? null,
      JSON.stringify(result.result),
      sha256(canonicalJson(result.result)),
    ],
  );
}

export async function failReceipt(
  tx: Tx,
  receiptId: string,
  status: 'FAILED' | 'NEEDS_RECONCILIATION',
): Promise<void> {
  await tx.query(
    `UPDATE tool_receipts SET status = $2, completed_at = now()
     WHERE id = $1 AND status = 'PENDING'`,
    [receiptId, status],
  );
}
