import type { FastifyInstance } from 'fastify';
import {
  CURRENT_COMPATIBILITY_MODE,
  loadCurrentRunContract,
  runtimeContractCatalog,
} from '../../contracts/catalog.js';

export function registerContractRoutes(app: FastifyInstance): void {
  app.get('/v1/contracts', async () => runtimeContractCatalog());

  app.get<{ Params: { family: string; version: string } }>(
    '/v1/contracts/:family/:version',
    async (req, reply) => {
      const contractId = `${req.params.family}/${req.params.version}`;
      if (contractId !== CURRENT_COMPATIBILITY_MODE) {
        return reply.code(404).send({ error: 'contract_not_supported', contractId });
      }
      return loadCurrentRunContract();
    },
  );
}
