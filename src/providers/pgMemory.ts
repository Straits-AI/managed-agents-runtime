import type { Pool } from 'pg';
import { newId } from '../ids.js';
import type { MemoryProvider, MemoryRecord, MemoryScope } from './types.js';

/**
 * Postgres-backed long-term memory (the default MemoryProvider). Recall ranks
 * by full-text relevance to the query, falling back to recency when the query
 * matches nothing — so an agent always sees its most relevant or most recent
 * memories. Swap for AgentKitMemoryProvider without touching the kernel.
 */
export class PgMemoryProvider implements MemoryProvider {
  constructor(private readonly pool: Pool) {}

  async search(scope: MemoryScope, query: string, limit: number): Promise<MemoryRecord[]> {
    const { rows } = await this.pool.query<{
      id: string;
      kind: string;
      content: string;
      metadata: Record<string, unknown>;
      created_at: Date;
      rank: number;
    }>(
      `SELECT id, kind, content, metadata, created_at,
              ts_rank(search_tsv, websearch_to_tsquery('english', $3)) AS rank
       FROM agent_memory
       WHERE tenant_id = $1 AND agent_id = $2
       ORDER BY rank DESC, created_at DESC
       LIMIT $4`,
      [scope.tenantId, scope.agentId, query || ' ', limit],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      content: r.content,
      metadata: r.metadata,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async write(
    scope: MemoryScope,
    entries: { content: string; kind?: string; metadata?: Record<string, unknown>; runId?: string }[],
  ): Promise<void> {
    for (const e of entries) {
      if (!e.content?.trim()) continue;
      await this.pool.query(
        `INSERT INTO agent_memory (id, tenant_id, agent_id, kind, content, metadata, run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          newId('mem'),
          scope.tenantId,
          scope.agentId,
          e.kind ?? 'fact',
          e.content.trim(),
          JSON.stringify(e.metadata ?? {}),
          e.runId ?? null,
        ],
      );
    }
  }
}
