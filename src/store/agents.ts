import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { newId } from '../ids.js';

type Q = Pool | Tx;

export interface AgentDefinitionRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  created_at: Date;
}

export interface AgentVersionRow {
  id: string;
  agent_id: string;
  version: number;
  instructions: string;
  model_policy: { model?: string; maxTokens?: number; temperature?: number };
  tool_policy: Record<string, unknown>;
  skill_refs: unknown[];
  mcp_toolset_refs: unknown[];
  sandbox_spec: {
    image?: string;
    cpuMilli?: number;
    memoryMB?: number;
    timeoutMinutes?: number;
  };
  context_strategy: Record<string, unknown>;
  verifier_policy: Record<string, unknown>;
  knowledge_config: { knowledgeBaseId?: string } & Record<string, unknown>;
  created_at: Date;
}

export async function createAgentDefinition(
  q: Q,
  input: { name: string; description?: string },
): Promise<AgentDefinitionRow> {
  const { rows } = await q.query<AgentDefinitionRow>(
    `INSERT INTO agent_definitions (id, name, description)
     VALUES ($1, $2, $3) RETURNING *`,
    [newId('ad'), input.name, input.description ?? null],
  );
  return rows[0]!;
}

export async function getAgentDefinition(
  q: Q,
  id: string,
): Promise<AgentDefinitionRow | null> {
  const { rows } = await q.query<AgentDefinitionRow>(
    'SELECT * FROM agent_definitions WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function createAgentVersion(
  tx: Tx,
  input: {
    agentId: string;
    instructions: string;
    modelPolicy: AgentVersionRow['model_policy'];
    toolPolicy?: Record<string, unknown>;
    skillRefs?: unknown[];
    mcpToolsetRefs?: unknown[];
    sandboxSpec?: AgentVersionRow['sandbox_spec'];
    contextStrategy?: Record<string, unknown>;
    verifierPolicy?: Record<string, unknown>;
    knowledgeConfig?: Record<string, unknown>;
  },
): Promise<AgentVersionRow> {
  // Serialize version allocation per agent.
  await tx.query('SELECT id FROM agent_definitions WHERE id = $1 FOR UPDATE', [
    input.agentId,
  ]);
  const { rows: vrows } = await tx.query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM agent_versions WHERE agent_id = $1`,
    [input.agentId],
  );
  const { rows } = await tx.query<AgentVersionRow>(
    `INSERT INTO agent_versions
       (id, agent_id, version, instructions, model_policy, tool_policy,
        skill_refs, mcp_toolset_refs, sandbox_spec, context_strategy, verifier_policy,
        knowledge_config)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      newId('av'),
      input.agentId,
      vrows[0]!.next,
      input.instructions,
      JSON.stringify(input.modelPolicy),
      JSON.stringify(input.toolPolicy ?? {}),
      JSON.stringify(input.skillRefs ?? []),
      JSON.stringify(input.mcpToolsetRefs ?? []),
      JSON.stringify(input.sandboxSpec ?? {}),
      JSON.stringify(input.contextStrategy ?? {}),
      JSON.stringify(input.verifierPolicy ?? {}),
      JSON.stringify(input.knowledgeConfig ?? {}),
    ],
  );
  return rows[0]!;
}

export async function getAgentVersion(
  q: Q,
  id: string,
): Promise<AgentVersionRow | null> {
  const { rows } = await q.query<AgentVersionRow>(
    'SELECT * FROM agent_versions WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}
