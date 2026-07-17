import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';

/**
 * Liveness and readiness probes (unauthenticated; see PUBLIC_PATHS in server).
 *   - /healthz: the process is up and serving. Cheap, never touches the DB.
 *   - /readyz:  the process can do useful work — verifies DB connectivity so a
 *              load balancer stops routing to an instance that lost its database.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not ready', reason: 'database unreachable' });
    }
  });
}
