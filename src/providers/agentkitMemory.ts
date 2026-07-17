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
 * REMAINING TO COMPLETE search()/write(): a VikingDB-backed memory collection
 * must exist (CreateMemoryCollection — a billable VikingDB resource that may
 * require VikingDB activation), and the exact memory-data add/search action
 * names/schemas must be confirmed against that live collection (the guessed
 * AddMemory/SearchMemory names returned InvalidActionOrVersion — the real ones
 * are captured via the console once a collection exists). Run
 * `scripts/probe-agentkit-memory.ts` after provisioning to discover them, then
 * fill in the two calls below.
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
