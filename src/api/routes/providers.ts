import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.js';
import {
  parseCapabilitySelectionRequest,
  selectProvidersByCapability,
} from '../../providers/capabilities.js';

export function registerProviderRoutes(app: FastifyInstance, deps: ApiDeps): void {
  if (!deps.providerPortability) return;

  app.get('/v1/provider-capabilities', async () => ({
    apiVersion: 'provider-contracts/v1',
    contracts: deps.providerPortability!.catalog.contracts,
    profiles: deps.providerPortability!.manifests,
  }));

  app.post('/v1/provider-capabilities/resolve', async (req) => {
    const request = parseCapabilitySelectionRequest(req.body);
    try {
      return selectProvidersByCapability({
        catalog: deps.providerPortability!.catalog,
        manifests: deps.providerPortability!.manifests,
        requirements: request.requirements,
      });
    } catch (cause) {
      const error = new Error(
        cause instanceof Error ? cause.message : 'provider capability selection failed',
        { cause },
      ) as Error & { statusCode: number };
      error.name = 'ProviderSelectionError';
      error.statusCode = 400;
      throw error;
    }
  });
}
