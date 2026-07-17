import { VikingMemoryClient } from './byteplus/vikingMemory.js';
import type { MemoryProvider, MemoryRecord, MemoryScope } from './types.js';

/**
 * AgentKit Memory adapter (memo §9.3), backed by Viking Memory — implements the
 * same MemoryProvider interface as PgMemoryProvider, so it is a one-line swap in
 * the worker (MEMORY_PROVIDER=agentkit).
 *
 * WORKING end-to-end (verified 2026-07-17 against collection `managed_agents_mem`):
 * wrote a memory, and after ~10s of async AI extraction, recalled it via search.
 *   - data plane: api-knowledgebase.mlp.cn-hongkong.bytepluses.com, SignerV4
 *     service `air`, region `cn-north-1` (see byteplus/vikingMemory.ts).
 *   - Memory is AI-EXTRACTED asynchronously from written session messages, so a
 *     write is not necessarily searchable immediately.
 *
 * Scope mapping: MemoryScope {tenantId, agentId} → Viking user_id
 * `${tenantId}:${agentId}` (per-agent isolation) and assistant_id `${agentId}`.
 */
export interface AgentKitMemoryConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** The Viking Memory collection name (created in the AgentKit/Viking console). */
  collectionName: string;
}

function userId(scope: MemoryScope): string {
  return `${scope.tenantId}:${scope.agentId}`;
}

export class AgentKitMemoryProvider implements MemoryProvider {
  private readonly client: VikingMemoryClient;

  constructor(cfg: AgentKitMemoryConfig) {
    if (!cfg.collectionName) {
      throw new Error(
        'AgentKitMemoryProvider needs AGENTKIT_MEMORY_COLLECTION (a Viking Memory ' +
          'collection name). Create one in the AgentKit/Viking console, or use ' +
          'PgMemoryProvider (MEMORY_PROVIDER=pg).',
      );
    }
    this.client = new VikingMemoryClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      sessionToken: cfg.sessionToken,
      collectionName: cfg.collectionName,
    });
  }

  async search(scope: MemoryScope, query: string, limit: number): Promise<MemoryRecord[]> {
    const res = await this.client.getContext({ userId: userId(scope), query, limit });
    const parts = res.context_parts ?? [];
    const records: MemoryRecord[] = parts
      .filter((p) => p.content)
      .map((p, i) => ({
        id: `viking:${i}`,
        kind: String(p.memory_type ?? 'event'),
        content: String(p.content),
        metadata: p,
        createdAt: new Date().toISOString(),
      }));
    // Fall back to the merged `context` string when no discrete parts came back.
    if (records.length === 0 && res.context?.trim()) {
      records.push({
        id: 'viking:context',
        kind: 'context',
        content: res.context.trim(),
        metadata: {},
        createdAt: new Date().toISOString(),
      });
    }
    return records;
  }

  async write(
    scope: MemoryScope,
    entries: { content: string; kind?: string; metadata?: Record<string, unknown>; runId?: string }[],
  ): Promise<void> {
    const uid = userId(scope);
    for (const e of entries) {
      if (!e.content?.trim()) continue;
      // Viking extracts memories from conversation turns; frame the fact as a
      // short user statement the extractor can turn into an event memory.
      await this.client.addSession({
        userId: uid,
        assistantId: scope.agentId,
        messages: [
          { role: 'user', content: e.content.trim() },
          { role: 'assistant', content: 'Understood, I will remember that.' },
        ],
      });
    }
  }
}
