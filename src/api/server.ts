import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { ObjectStore } from '../providers/types.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerHealthRoutes } from './routes/health.js';
import { resolveTenant } from './auth.js';
import { rateLimiter } from './rateLimit.js';
import { log } from '../log.js';

// The authenticated tenant, attached by the auth hook and read by every handler.
declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

export interface ApiDeps {
  pool: Pool;
  cfg: Config;
  /** Presigner for artifact downloads; wired to TOS when configured. */
  presignGet?: (tosKey: string, ttlSec: number) => Promise<string>;
  /** Object store for run-bundle export (workspace snapshots). */
  objectStore?: ObjectStore;
}

/** Paths served without authentication (liveness/readiness probes). */
const PUBLIC_PATHS = new Set(['/healthz', '/readyz']);

export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    // Bound request bodies so a client can't OOM the API with a huge payload.
    bodyLimit: deps.cfg.API_BODY_LIMIT_BYTES,
    // Trust a correlation id from the caller if present, else generate one.
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
  });

  const limiter = rateLimiter(deps.cfg, deps.pool);

  // --- Authentication + tenant resolution (memo §19 layer 1) ---
  app.addHook('onRequest', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0]!)) return; // probes are open

    const tenant = await resolveTenant(deps.pool, deps.cfg, req.headers.authorization);
    if (!tenant) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (tenant.status !== 'active') {
      return reply.code(403).send({ error: 'tenant suspended' });
    }
    req.tenantId = tenant.id;

    // Per-tenant rate limiting (in-process or Postgres-backed per config).
    const verdict = await limiter.check(tenant.id);
    if (!verdict.ok) {
      reply.header('retry-after', String(verdict.retryAfterSec));
      return reply.code(429).send({ error: 'rate limit exceeded' });
    }
  });

  // --- Structured access log, one JSON line per request ---
  app.addHook('onResponse', async (req, reply) => {
    log.info('request', {
      reqId: req.id,
      method: req.method,
      path: req.url.split('?')[0],
      status: reply.statusCode,
      tenantId: req.tenantId ?? null,
      ms: Math.round(reply.elapsedTime),
    });
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status =
      err.name === 'RunNotFoundError' ? 404
      : err.name === 'UnexpectedStatusError' || err.name === 'InvalidTransitionError' ? 409
      : err.name === 'ZodError' ? 400
      : err.statusCode ?? 500;
    if (status >= 500) {
      log.error('request error', { reqId: req.id, err: err.message, name: err.name });
      return reply.code(status).send({
        error: 'internal_error',
        message: 'Internal server error',
        requestId: req.id,
      });
    }
    return reply.code(status).send({ error: err.name, message: err.message });
  });

  registerHealthRoutes(app, deps);
  registerAgentRoutes(app, deps);
  registerRunRoutes(app, deps);
  return app;
}
