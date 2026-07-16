import type { Pool } from 'pg';

export interface OutboxRow {
  id: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
}

/**
 * Phase 1 in-process publisher stub: drains unpublished outbox rows and
 * marks them published. The seam where Kafka/RocketMQ plugs in later
 * (memo §11) — consumers in Phase 1 read run_events directly.
 */
export async function drainOutbox(
  pool: Pool,
  handler: (row: OutboxRow) => Promise<void> | void,
  limit = 100,
): Promise<number> {
  const { rows } = await pool.query<OutboxRow>(
    `SELECT * FROM outbox WHERE published_at IS NULL ORDER BY id ASC LIMIT $1`,
    [limit],
  );
  for (const row of rows) {
    await handler(row);
    await pool.query('UPDATE outbox SET published_at = now() WHERE id = $1', [row.id]);
  }
  return rows.length;
}
