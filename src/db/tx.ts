import type { Pool, PoolClient } from 'pg';

export type Tx = PoolClient;

/**
 * Run `fn` inside a single transaction. Rolls back on any throw.
 * All durable state changes in the kernel go through this helper so
 * event append + row update + outbox insert are always atomic.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Run a transaction on a caller-owned client without releasing the session. */
export async function withClientTransaction<T>(
  client: PoolClient,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
