import type { Pool } from 'pg';

/**
 * A run's token budget is a hard ceiling (memo §16.9): once cumulative model
 * usage reaches it, the run stops gracefully rather than looping. Shared by the
 * real and scripted epochs so both enforce it identically.
 */
export async function tokenBudgetExceeded(pool: Pool, runId: string): Promise<boolean> {
  const { rows } = await pool.query<{ tokens_used: string; token_budget: string | null }>(
    'SELECT tokens_used, token_budget FROM runs WHERE id = $1',
    [runId],
  );
  const row = rows[0];
  if (!row || row.token_budget === null) return false;
  return BigInt(row.tokens_used) >= BigInt(row.token_budget);
}
