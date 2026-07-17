import type { Pool } from 'pg';
import type { ObjectStore } from '../providers/types.js';

/**
 * A portable, provider-neutral snapshot of a run's authoritative state (memo
 * §20/§21): the run, its gapless event history, attempts, receipts, approvals,
 * grants, and the workspace (revision metadata + the latest snapshot tarball
 * inlined as base64). Everything a customer needs to audit, replay, or move the
 * run to another deployment — the execution state is owned by us, not the
 * cloud provider.
 */
export interface RunBundle {
  bundleVersion: 1;
  exportedAtSeq: string; // the run's last_event_seq at export
  run: Record<string, unknown>;
  attempts: Record<string, unknown>[];
  events: { seq: string; type: string; payload: unknown; created_at: string }[];
  receipts: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  grants: Record<string, unknown>[];
  workspace: {
    revisions: Record<string, unknown>[];
    latestSnapshotBase64: string | null;
    latestSnapshotKey: string | null;
  };
}

export async function exportRunBundle(
  pool: Pool,
  store: ObjectStore,
  runId: string,
): Promise<RunBundle> {
  const one = async (sql: string) => (await pool.query(sql, [runId])).rows;
  const run = (await pool.query('SELECT * FROM runs WHERE id = $1', [runId])).rows[0];
  if (!run) throw new Error(`run not found: ${runId}`);

  const events = (
    await pool.query(
      'SELECT seq, type, payload, created_at FROM run_events WHERE run_id = $1 ORDER BY seq',
      [runId],
    )
  ).rows;

  // Verify the exported history is gapless before we hand it off.
  events.forEach((e, i) => {
    if (Number(e.seq) !== i + 1) {
      throw new Error(`event history has a gap at position ${i} (seq ${e.seq}); refusing to export`);
    }
  });

  const revisions = run.workspace_id
    ? (await pool.query(
        'SELECT * FROM workspace_revisions WHERE workspace_id = $1 ORDER BY created_at',
        [run.workspace_id],
      )).rows
    : [];
  const latest = revisions[revisions.length - 1];
  let latestSnapshotBase64: string | null = null;
  if (latest?.tos_key) {
    latestSnapshotBase64 = (await store.get(latest.tos_key as string)).toString('base64');
  }

  return {
    bundleVersion: 1,
    exportedAtSeq: String(run.last_event_seq),
    run,
    attempts: await one('SELECT * FROM run_attempts WHERE run_id = $1 ORDER BY attempt_no'),
    events,
    receipts: await one('SELECT * FROM tool_receipts WHERE run_id = $1 ORDER BY started_at'),
    approvals: await one('SELECT * FROM approvals WHERE run_id = $1 ORDER BY created_at'),
    grants: await one('SELECT * FROM capability_grants WHERE run_id = $1 ORDER BY created_at'),
    workspace: {
      revisions,
      latestSnapshotBase64,
      latestSnapshotKey: (latest?.tos_key as string) ?? null,
    },
  };
}
