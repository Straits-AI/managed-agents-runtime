import type { Pool } from 'pg';
import { newId } from '../ids.js';
import type { Evidence, KnowledgeProvider } from './types.js';

/**
 * Postgres-backed knowledge retrieval (the default KnowledgeProvider): full-text
 * ranking over ingested documents. Swap for AgentKitKnowledgeProvider without
 * touching the kernel.
 */
export class PgKnowledgeProvider implements KnowledgeProvider {
  constructor(private readonly pool: Pool) {}

  async retrieve(
    knowledgeBaseId: string,
    query: string,
    limit: number,
    tenantId = 'default',
  ): Promise<Evidence[]> {
    // OR the query terms so a passage matching ANY term is retrieved (RAG-style
    // recall), ranked by relevance. Sanitize to keep to_tsquery syntax valid.
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
      .join(' | ');
    if (!terms) return [];
    const { rows } = await this.pool.query<{
      id: string;
      title: string;
      content: string;
      metadata: Record<string, unknown>;
      score: number;
    }>(
      `SELECT id, title, content, metadata,
              ts_rank(search_tsv, to_tsquery('english', $3)) AS score
       FROM knowledge_docs
       WHERE tenant_id = $1 AND knowledge_base_id = $2
         AND search_tsv @@ to_tsquery('english', $3)
       ORDER BY score DESC
       LIMIT $4`,
      [tenantId, knowledgeBaseId, terms, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      score: Number(r.score),
      metadata: r.metadata,
    }));
  }

  /** Ingest documents into a knowledge base (used to seed a KB for retrieval). */
  async ingest(
    knowledgeBaseId: string,
    docs: { title?: string; content: string; metadata?: Record<string, unknown> }[],
    tenantId = 'default',
  ): Promise<void> {
    for (const d of docs) {
      if (!d.content?.trim()) continue;
      await this.pool.query(
        `INSERT INTO knowledge_docs (id, tenant_id, knowledge_base_id, title, content, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newId('kdoc'),
          tenantId,
          knowledgeBaseId,
          d.title ?? '',
          d.content.trim(),
          JSON.stringify(d.metadata ?? {}),
        ],
      );
    }
  }
}
