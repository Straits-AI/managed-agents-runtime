import { timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { getTenant, resolveApiKey, type TenantRow } from '../store/tenants.js';

/** Constant-time string compare that never short-circuits on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a compare to avoid a length-timing oracle.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve an Authorization header to the authenticated tenant, or null.
 *
 * Two credentials are accepted:
 *   1. the configured API_AUTH_TOKEN → the built-in 'default' tenant. This keeps
 *      existing single-token deployments working unchanged.
 *   2. a minted per-tenant API key (mak_…) → its owning tenant, looked up by
 *      SHA-256 hash. Only active keys of active tenants resolve.
 */
export async function resolveTenant(
  pool: Pool,
  cfg: Config,
  authorization: string | undefined,
): Promise<TenantRow | null> {
  const prefix = 'Bearer ';
  if (!authorization || !authorization.startsWith(prefix)) return null;
  const token = authorization.slice(prefix.length);
  if (token.length === 0) return null;

  // Built-in operator token → default tenant.
  if (safeEqual(token, cfg.API_AUTH_TOKEN)) {
    return getTenant(pool, 'default');
  }
  // Per-tenant API key.
  return resolveApiKey(pool, token);
}
