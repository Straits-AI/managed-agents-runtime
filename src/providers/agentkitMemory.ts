import type { MemoryProvider, MemoryRecord, MemoryScope } from './types.js';

/**
 * AgentKit Memory adapter (memo §9.3). Implements the same MemoryProvider
 * interface as PgMemoryProvider, so selecting it is a one-line swap in the
 * worker — the kernel is unchanged.
 *
 * BINDING STATUS (2026-07-17): not yet bound to live AgentKit. AgentKit is not
 * exposed through the `bp` CLI and its dedicated CLI/OpenAPI is not provisioned
 * in this environment. To bind:
 *
 *   1. Install the official AgentKit CLI and confirm create-entitlement with
 *      read-only ListRuntimes/ListTools (see the byteplus-cloud skill's
 *      agentkit reference — create actions return InvalidActionOrVersion when
 *      the account is not activated).
 *   2. Retrieve the current Memory API contract (search/write endpoints, the
 *      memory-space/collection model, auth) from the live AgentKit OpenAPI.
 *   3. Implement search()/write() below against that contract, signing with the
 *      credential-isolating flow (clicreds.CliProvider), never printing keys.
 *   4. Map AgentKit's memory-space identity to MemoryScope {tenantId, agentId}.
 *
 * Until then, constructing this provider throws, so a misconfigured deployment
 * fails fast rather than silently losing memory.
 */
export class AgentKitMemoryProvider implements MemoryProvider {
  constructor(_config: { endpoint?: string; memorySpace?: string } = {}) {
    throw new Error(
      'AgentKitMemoryProvider is not bound yet — see the binding steps in ' +
        'src/providers/agentkitMemory.ts. Use PgMemoryProvider (MEMORY_PROVIDER=pg) meanwhile.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_scope: MemoryScope, _query: string, _limit: number): Promise<MemoryRecord[]> {
    throw new Error('AgentKitMemoryProvider.search not implemented');
  }

  async write(): Promise<void> {
    throw new Error('AgentKitMemoryProvider.write not implemented');
  }
}
