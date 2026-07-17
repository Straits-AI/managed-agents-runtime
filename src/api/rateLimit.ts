import type { Pool } from 'pg';
import type { Config } from '../config.js';

export interface RateVerdict {
  ok: boolean;
  retryAfterSec: number;
}

export interface RateLimiter {
  check(tenantId: string): Promise<RateVerdict>;
}

const ALWAYS_OK: RateLimiter = { check: async () => ({ ok: true, retryAfterSec: 0 }) };

/**
 * Select a rate limiter from config. `instance` (default) is an in-process
 * token bucket that bounds a single API node — fast, no DB load. `global` is a
 * Postgres-backed bucket shared across all API instances. Either is disabled
 * when RATE_LIMIT_PER_SEC is 0.
 */
export function rateLimiter(cfg: Config, pool: Pool): RateLimiter {
  if (cfg.RATE_LIMIT_PER_SEC <= 0) return ALWAYS_OK;
  return cfg.RATE_LIMIT_SCOPE === 'global'
    ? pgRateLimiter(cfg, pool)
    : instanceRateLimiter(cfg);
}

/**
 * Per-tenant token bucket held in this process's memory. `capacity` tokens
 * refill at `refillPerSec`; each request spends one.
 */
export function instanceRateLimiter(cfg: Config): RateLimiter {
  const capacity = cfg.RATE_LIMIT_BURST;
  const refillPerSec = cfg.RATE_LIMIT_PER_SEC;
  const buckets = new Map<string, { tokens: number; last: number }>();

  return {
    check(tenantId: string): Promise<RateVerdict> {
      const now = Date.now();
      const b = buckets.get(tenantId) ?? { tokens: capacity, last: now };
      const elapsedSec = (now - b.last) / 1000;
      b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
      b.last = now;

      if (b.tokens < 1) {
        buckets.set(tenantId, b);
        const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec));
        return Promise.resolve({ ok: false, retryAfterSec });
      }
      b.tokens -= 1;
      buckets.set(tenantId, b);
      return Promise.resolve({ ok: true, retryAfterSec: 0 });
    },
  };
}

/**
 * Postgres-backed token bucket shared across instances. Refill and spend happen
 * in ONE atomic statement: upsert the tenant's row, refilling proportional to
 * elapsed time (capped at burst) and spending a token, returning the remaining
 * balance. A negative balance means the bucket was empty — deny (the statement
 * floors at -1 so it never over-drafts and retry-after stays bounded).
 */
export function pgRateLimiter(cfg: Config, pool: Pool): RateLimiter {
  const capacity = cfg.RATE_LIMIT_BURST;
  const rate = cfg.RATE_LIMIT_PER_SEC;

  return {
    async check(tenantId: string): Promise<RateVerdict> {
      const { rows } = await pool.query<{ tokens: number }>(
        `INSERT INTO rate_buckets (tenant_id, tokens, updated_at)
           VALUES ($1, $2 - 1, now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           tokens = GREATEST(
             -1,
             LEAST($2::float, rate_buckets.tokens
               + EXTRACT(EPOCH FROM now() - rate_buckets.updated_at) * $3::float) - 1
           ),
           updated_at = now()
         RETURNING tokens`,
        [tenantId, capacity, rate],
      );
      const tokens = rows[0]!.tokens;
      if (tokens < 0) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(1 / rate)) };
      }
      return { ok: true, retryAfterSec: 0 };
    },
  };
}
