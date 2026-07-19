import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../server.js';
import { withTransaction } from '../../db/tx.js';
import {
  createAgentDefinition,
  createAgentVersion,
  getAgentDefinition,
} from '../../store/agents.js';
import { getKnowledgeBinding } from '../../store/knowledgeBindings.js';

const createAgentBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const createVersionBody = z.object({
  instructions: z.string().min(1),
  modelPolicy: z.object({
    model: z.string().optional(),
    escalationModel: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
  }).default({}),
  toolPolicy: z.record(z.string(), z.unknown()).optional(),
  skillRefs: z.array(z.unknown()).optional(),
  mcpToolsetRefs: z.array(z.unknown()).optional(),
  sandboxSpec: z.object({
    image: z.string().optional(),
    cpuMilli: z.number().int().positive().optional(),
    memoryMB: z.number().int().positive().optional(),
    timeoutMinutes: z.number().int().positive().optional(),
  }).optional(),
  contextStrategy: z.record(z.string(), z.unknown()).optional(),
  verifierPolicy: z.record(z.string(), z.unknown()).optional(),
  knowledgeConfig: z.object({
    binding: z.string().min(1).max(200),
  }).strict().optional(),
});

export function registerAgentRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/v1/agents', async (req, reply) => {
    const body = createAgentBody.parse(req.body);
    const agent = await createAgentDefinition(deps.pool, { ...body, tenantId: req.tenantId });
    return reply.code(201).send(agent);
  });

  app.post<{ Params: { agentId: string } }>(
    '/v1/agents/:agentId/versions',
    async (req, reply) => {
      // Only the owning tenant can add versions to an agent.
      const agent = await getAgentDefinition(deps.pool, req.params.agentId, req.tenantId);
      if (!agent) return reply.code(404).send({ error: 'agent not found' });

      const body = createVersionBody.parse(req.body);
      if (deps.cfg.KNOWLEDGE_PROVIDER === 'agentkit' && body.knowledgeConfig?.binding) {
        const binding = await getKnowledgeBinding(
          deps.pool,
          req.tenantId,
          body.knowledgeConfig.binding,
        );
        if (
          !binding ||
          (deps.cfg.AGENTKIT_KNOWLEDGE_LIVE_VERIFIED === 1 &&
            binding.live_verified_at === null)
        ) {
          return reply.code(400).send({ error: 'knowledge binding is unavailable' });
        }
      }
      const version = await withTransaction(deps.pool, (tx) =>
        createAgentVersion(tx, { agentId: agent.id, ...body }),
      );
      return reply.code(201).send(version);
    },
  );
}
