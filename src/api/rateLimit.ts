import type { Config } from '../config.js';

export interface RateVerdict {
  ok: boolean;
  retryAfterSec: number;
}

export interface RateLimiter {
  check(tenantId: string): RateVerdict;
}

/**
 * A simple per-tenant token-bucket rate limiter, in-process. `capacity` tokens
 * refill at `refillPerSec`; each request spends one. This bounds a single API
 * instance; a multi-instance deployment would move this to a shared store
 * (Redis), but the per-instance bucket already protects each node and gives
 * tenants isolation from one another. Disabled when the configured rate is 0.
 */
export function rateLimiter(cfg: Config): RateLimiter {
  const capacity = cfg.RATE_LIMIT_BURST;
  const refillPerSec = cfg.RATE_LIMIT_PER_SEC;
  if (refillPerSec <= 0) {
    return { check: () => ({ ok: true, retryAfterSec: 0 }) };
  }

  const buckets = new Map<string, { tokens: number; last: number }>();

  return {
    check(tenantId: string): RateVerdict {
      const now = Date.now();
      const b = buckets.get(tenantId) ?? { tokens: capacity, last: now };
      // Refill proportionally to elapsed time, capped at capacity.
      const elapsedSec = (now - b.last) / 1000;
      b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
      b.last = now;

      if (b.tokens < 1) {
        buckets.set(tenantId, b);
        const retryAfterSec = Math.ceil((1 - b.tokens) / refillPerSec);
        return { ok: false, retryAfterSec: Math.max(1, retryAfterSec) };
      }
      b.tokens -= 1;
      buckets.set(tenantId, b);
      return { ok: true, retryAfterSec: 0 };
    },
  };
}
