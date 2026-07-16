import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerRunRoutes } from './routes/runs.js';

export interface ApiDeps {
  pool: Pool;
  cfg: Config;
  /** Presigner for artifact downloads; wired to TOS when configured. */
  presignGet?: (tosKey: string, ttlSec: number) => Promise<string>;
}

export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${deps.cfg.API_AUTH_TOKEN}`) {
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
