import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { newId } from '../ids.js';

type Q = Pool | Tx;

export interface KnowledgeBindingRow {
  id: string;
  tenant_id: string;
  name: string;
  provider: 'agentkit';
  provider_project: string;
  provider_collection: string;
  status: 'active' | 'disabled';
  revision: number;
  live_verified_at: Date | null;
  created_at: Date;
}

/**
 * Replace or reactivate a logical binding without allowing a previous live
 * verification to carry over to different provider coordinates. The revision
 * is the optimistic token used when a verification probe completes.
 */
export async function rebindKnowledgeBinding(
  q: Q,
  input: {
    tenantId: string;
    name: string;
    provider: 'agentkit';
    providerProject: string;
    providerCollection: string;
  },
): Promise<KnowledgeBindingRow> {
  const { rows } = await q.query<KnowledgeBindingRow>(
    `INSERT INTO knowledge_bindings
       (id, tenant_id, name, provider, provider_project, provider_collection)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       provider = EXCLUDED.provider,
       provider_project = EXCLUDED.provider_project,
       provider_collection = EXCLUDED.provider_collection,
       status = 'active',
       revision = knowledge_bindings.revision + 1,
       live_verified_at = NULL
     RETURNING *`,
    [
      newId('kbnd'),
      input.tenantId,
      input.name,
      input.provider,
      input.providerProject,
      input.providerCollection,
    ],
  );
  return rows[0]!;
}

export async function createKnowledgeBinding(
  q: Q,
  input: {
    tenantId: string;
    name: string;
    provider: 'agentkit';
    providerProject: string;
    providerCollection: string;
    liveVerifiedAt?: Date;
  },
): Promise<KnowledgeBindingRow> {
  const { rows } = await q.query<KnowledgeBindingRow>(
    `INSERT INTO knowledge_bindings
       (id, tenant_id, name, provider, provider_project, provider_collection,
        live_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      newId('kbnd'),
      input.tenantId,
      input.name,
      input.provider,
      input.providerProject,
      input.providerCollection,
      input.liveVerifiedAt ?? null,
    ],
  );
  return rows[0]!;
}

export async function getKnowledgeBinding(
  q: Q,
  tenantId: string,
  name: string,
): Promise<KnowledgeBindingRow | null> {
  const { rows } = await q.query<KnowledgeBindingRow>(
    `SELECT * FROM knowledge_bindings
     WHERE tenant_id = $1 AND name = $2 AND status = 'active'`,
    [tenantId, name],
  );
  return rows[0] ?? null;
}

export async function listKnowledgeBindings(
  q: Q,
  tenantId: string,
): Promise<KnowledgeBindingRow[]> {
  const { rows } = await q.query<KnowledgeBindingRow>(
    `SELECT * FROM knowledge_bindings WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  );
  return rows;
}

export async function disableKnowledgeBinding(
  q: Q,
  tenantId: string,
  name: string,
): Promise<boolean> {
  const result = await q.query(
    `UPDATE knowledge_bindings SET status = 'disabled'
     WHERE tenant_id = $1 AND name = $2 AND status = 'active'`,
    [tenantId, name],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markKnowledgeBindingVerified(
  q: Q,
  tenantId: string,
  name: string,
  expectedRevision: number,
): Promise<boolean> {
  const result = await q.query(
    `UPDATE knowledge_bindings SET live_verified_at = now()
     WHERE tenant_id = $1 AND name = $2 AND status = 'active' AND revision = $3`,
    [tenantId, name, expectedRevision],
  );
  return (result.rowCount ?? 0) > 0;
}
