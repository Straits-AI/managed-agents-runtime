import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { ObjectStore } from '../providers/types.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerRunRoutes } from './routes/runs.js';

export interface ApiDeps {
  pool: Pool;
  cfg: Config;
  /** Presigner for artifact downloads; wired to TOS when configured. */
  presignGet?: (tosKey: string, ttlSec: number) => Promise<string>;
  /** Object store for run-bundle export (workspace snapshots). */
  objectStore?: ObjectStore;
}

export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  const expected = Buffer.from(`Bearer ${deps.cfg.API_AUTH_TOKEN}`);
  app.addHook('onRequest', async (req, reply) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    const ok =
      given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status =
      err.name === 'RunNotFoundError' ? 404
      : err.name === 'UnexpectedStatusError' || err.name === 'InvalidTransitionError' ? 409
      : err.name === 'ZodError' ? 400
      : err.statusCode ?? 500;
    reply.code(status).send({ error: err.name, message: err.message });
  });

  registerAgentRoutes(app, deps);
  registerRunRoutes(app, deps);
  return app;
}
