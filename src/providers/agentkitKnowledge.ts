import { signedCallV4 } from './byteplus/signerV4.js';
import type { SignV4Input } from './byteplus/signerV4.js';
import type { Evidence, KnowledgeProvider } from './types.js';
import type { Pool } from 'pg';
import { getKnowledgeBinding } from '../store/knowledgeBindings.js';

/**
 * AgentKit Knowledge Base adapter (memo §9.4) — the RAG counterpart to the
 * Viking Memory binding, on the same data plane
 * (`api-knowledgebase.mlp.cn-hongkong.bytepluses.com`, SignerV4 service `air`,
 * region `cn-north-1`; see byteplus/signerV4.ts). Implements the same
 * KnowledgeProvider interface as PgKnowledgeProvider — a one-line swap.
 *
 * Provider project and collection identifiers are resolved from an
 * authoritative tenant-owned binding. Callers supply only its logical name.
 * The product is billable and must be provisioned before retrieval works; use
 * `npm run admin knowledge verify` to make a real signed request and record the
 * binding's live-contract verification before enabling shared execution.
 */
export interface AgentKitKnowledgeConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  requireLiveVerified: boolean;
}

export type AgentKitKnowledgeCall = <T>(input: SignV4Input) => Promise<T>;

export class KnowledgeBindingUnavailableError extends Error {
  constructor() {
    super('knowledge binding is unavailable');
    this.name = 'KnowledgeBindingUnavailableError';
  }
}

const HOST = 'api-knowledgebase.mlp.cn-hongkong.bytepluses.com';

export class AgentKitKnowledgeProvider implements KnowledgeProvider {
  constructor(
    private readonly pool: Pool,
    private readonly cfg: AgentKitKnowledgeConfig,
    private readonly call: AgentKitKnowledgeCall = signedCallV4,
  ) {}

  async retrieve(
    knowledgeBaseId: string,
    query: string,
    limit: number,
    tenantId?: string,
  ): Promise<Evidence[]> {
    if (!tenantId) throw new KnowledgeBindingUnavailableError();
    const binding = await getKnowledgeBinding(this.pool, tenantId, knowledgeBaseId);
    if (
      !binding ||
      binding.provider !== 'agentkit' ||
      (this.cfg.requireLiveVerified && binding.live_verified_at === null)
    ) {
      throw new KnowledgeBindingUnavailableError();
    }
    const res = await this.call<{
      result_list?: { content?: string; title?: string; score?: number; id?: string }[];
    }>({
      host: HOST,
      region: 'cn-north-1',
      service: 'air',
      path: '/api/knowledge/collection/search_knowledge',
      body: JSON.stringify({
        collection_name: binding.provider_collection,
        project: binding.provider_project,
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
