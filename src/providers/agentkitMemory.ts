import { AgentKitClient } from './byteplus/agentkit.js';
import type { MemoryProvider, MemoryRecord, MemoryScope } from './types.js';

/**
 * AgentKit Memory adapter (memo §9.3), implementing the same MemoryProvider
 * interface as PgMemoryProvider — selecting it is a one-line swap in the worker.
 *
 * VERIFIED LIVE (2026-07-17, this account): AgentKit is fully enabled and the
 * OpenAPI is directly callable with our BytePlus signer (service `agentkit`,
 * version `2025-10-30`) — no separate CLI. Confirmed valid actions:
 * ListRuntimes, ListTools, ListMemoryCollections, GetMemoryCollection(MemoryId),
 * CreateMemoryCollection(Name). AgentKit Memory is backed by VikingDB.
 *
 * FULL CONTRACT DISCOVERED (2026-07-17). AgentKit Memory is backed by "Viking
 * Memory", which has its OWN data-plane API distinct from the AgentKit
 * top-gateway OpenAPI:
 *
 *   - Control plane (manage collections): service `agentkit`, version
 *     `2025-10-30`, top-gateway (`open.byteplusapi.com`) — our existing signer.
 *     CreateMemoryCollection needs {Name, Description, ProviderType:
 *     'VIKINGDB_MEMORY', Strategies:[event+profile extraction rules]}. Easier to
 *     create via the console/Viking Memory (free; billing starts on data upload).
 *   - Data plane (read/write memory): host
 *     `api-knowledgebase.mlp.cn-hongkong.bytepluses.com`, **Volcengine SignerV4,
 *     service `air`, region `cn-north-1`** (path-based REST — NOT the top-gateway
 *     Action= style, so it needs a second signer we don't have yet).
 *       search:  POST /api/memory/get_context
 *         { collection_name, project_name, conversation_id, query,
 *           event_search_config:{ filter:{ user_id, memory_type:['event_v1'] },
 *             limit, time_decay_config:{ weight, no_decay_period } },
 *           profile_search_config:{ filter:{ user_id, memory_type:['profile_v1'] }, limit } }
 *       write:   POST /api/memory/... (session/conversation data → AI extracts
 *         event + profile memories; exact path via the console "Write data" flow)
 *   - Model is conversation/session-based (not plain key-value): writes are
 *     messages under a conversation_id/user_id, memories are AI-extracted.
 *
 * Live collection provisioned for binding: `mem-3a9e24de` (name
 * `managed_agents_mem`, cn-hongkong, Standard/shared-compute).
 *
 * REMAINING BUILD to make search()/write() live:
 *   1. Add a path-based SignerV4 signer (service `air`, region `cn-north-1`).
 *   2. Implement get_context (search) + the session-add call (write), mapping
 *      our MemoryRecord {content} to a conversation message and back.
 *   3. Point at collection_name `managed_agents_mem`, scoped by user_id =
 *      `${tenantId}:${agentId}`.
 */
export interface AgentKitMemoryConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
  /** The AgentKit memory collection (VikingDB-backed) to read/write. */
  memoryId: string;
}

export class AgentKitMemoryProvider implements MemoryProvider {
  private readonly client: AgentKitClient;
  private readonly memoryId: string;

  constructor(cfg: AgentKitMemoryConfig) {
    if (!cfg.memoryId) {
      throw new Error(
        'AgentKitMemoryProvider needs a memoryId (a provisioned VikingDB memory ' +
          'collection). Create one with CreateMemoryCollection, then set it. Until ' +
          'then use PgMemoryProvider (MEMORY_PROVIDER=pg).',
      );
    }
    this.client = new AgentKitClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      sessionToken: cfg.sessionToken,
      region: cfg.region,
    });
    this.memoryId = cfg.memoryId;
  }

  async search(_scope: MemoryScope, _query: string, _limit: number): Promise<MemoryRecord[]> {
    // TODO(agentkit-memory): call the confirmed memory-search action against
    // this.memoryId and map results to MemoryRecord. Action name pending
    // discovery on a live collection (see class doc).
    throw new Error('AgentKitMemoryProvider.search: memory-search action not yet confirmed');
  }

  async write(): Promise<void> {
    // TODO(agentkit-memory): call the confirmed memory-add action against
    // this.memoryId. Action name pending discovery on a live collection.
    throw new Error('AgentKitMemoryProvider.write: memory-add action not yet confirmed');
  }
}
