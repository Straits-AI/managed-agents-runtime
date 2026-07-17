import type { Pool } from 'pg';
import { withTransaction } from '../db/tx.js';
import type { EventPublisher } from '../providers/types.js';

export interface OutboxRow {
  id: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
}

/**
 * Drain one batch of unpublished outbox rows and hand them to the publisher
 * (memo §11). Rows are locked `FOR UPDATE SKIP LOCKED`, so multiple relay
 * processes never publish the same event. Publishing happens inside the
 * transaction: if `publisher.publish` throws, the batch stays unpublished and is
 * retried on the next drain (at-least-once delivery). Returns the batch size.
 */
export async function drainOutbox(
  pool: Pool,
  publisher: EventPublisher,
  limit = 100,
): Promise<number> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<OutboxRow>(
      `SELECT * FROM outbox WHERE published_at IS NULL
       ORDER BY id ASC LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (rows.length === 0) return 0;
    await publisher.publish(rows);
    await tx.query(`UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])`, [
      rows.map((r) => r.id),
    ]);
    return rows.length;
  });
}
