import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import type { RunEventRow } from '../core/types.js';

type Q = Pool | Tx;

export async function listEvents(
  q: Q,
  runId: string,
  opts: { afterSeq?: bigint; limit?: number } = {},
): Promise<RunEventRow[]> {
  const { rows } = await q.query<RunEventRow>(
    `SELECT * FROM run_events
     WHERE run_id = $1 AND seq > $2
     ORDER BY seq ASC
     LIMIT $3`,
    [runId, (opts.afterSeq ?? 0n).toString(), opts.limit ?? 500],
  );
  return rows;
}
