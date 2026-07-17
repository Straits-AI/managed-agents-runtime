import { signedCallV4 } from './byteplus/signerV4.js';
import type { Evidence, KnowledgeProvider } from './types.js';

/**
 * AgentKit Knowledge Base adapter (memo §9.4) — the RAG counterpart to the
 * Viking Memory binding, on the same data plane
 * (`api-knowledgebase.mlp.cn-hongkong.bytepluses.com`, SignerV4 service `air`,
 * region `cn-north-1`; see byteplus/signerV4.ts). Implements the same
 * KnowledgeProvider interface as PgKnowledgeProvider — a one-line swap.
 *
 * Like Viking Memory, AgentKit Knowledge Base is a billable product that must
 * be activated and have a knowledge base + documents provisioned before
 * retrieval works. The search request shape mirrors the Viking search APIs
 * (collection/resource id + query + a filter/limit config); confirm the exact
 * path (`/api/knowledge/search_knowledge` family) and body against a live
 * knowledge base — the same console-network / probe method that mapped memory.
 */
export interface AgentKitKnowledgeConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const HOST = 'api-knowledgebase.mlp.cn-hongkong.bytepluses.com';

export class AgentKitKnowledgeProvider implements KnowledgeProvider {
  constructor(private readonly cfg: AgentKitKnowledgeConfig) {}

  async retrieve(
    knowledgeBaseId: string,
    query: string,
    limit: number,
  ): Promise<Evidence[]> {
    const res = await signedCallV4<{
      result_list?: { content?: string; title?: string; score?: number; id?: string }[];
    }>({
      host: HOST,
      region: 'cn-north-1',
      service: 'air',
      path: '/api/knowledge/collection/search_knowledge',
      body: JSON.stringify({
        collection_name: knowledgeBaseId,
        project: 'default',
        query,
        limit,
      }),
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      sessionToken: this.cfg.sessionToken,
    });
    return (res.result_list ?? []).map((r, i) => ({
      id: r.id ?? `kb:${i}`,
      title: r.title ?? '',
      content: String(r.content ?? ''),
      score: Number(r.score ?? 0),
      metadata: r,
    }));
  }
}
