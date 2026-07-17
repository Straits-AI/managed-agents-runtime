import { signedCall } from './signer.js';

/**
 * AgentKit OpenAPI client (control plane). Contract confirmed live against this
 * account on 2026-07-17: service `agentkit`, version `2025-10-30`, signed with
 * the same BytePlus top-gateway HMAC as veFaaS — no separate AgentKit CLI is
 * required. Read + create entitlement verified (ListRuntimes / ListTools /
 * ListMemoryCollections returned 200; CreateMemoryCollection is a valid action).
 *
 * AgentKit Memory is backed by VikingDB (`VIKINGDB_MEMORY`); a memory collection
 * is the VikingDB-backed resource that memory entries are written to and
 * searched within.
 */
export interface AgentKitClientOptions {
  host?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const VERSION = '2025-10-30';

export interface MemoryCollection {
  MemoryId?: string;
  Name?: string;
  Description?: string;
  [k: string]: unknown;
}

export class AgentKitClient {
  private readonly host: string;
  private readonly region: string;

  constructor(private readonly opts: AgentKitClientOptions) {
    this.host = opts.host ?? 'open.byteplusapi.com';
    this.region = opts.region ?? 'ap-southeast-1';
  }

  private call<T>(action: string, body: Record<string, unknown>): Promise<T> {
    return signedCall<T>({
      host: this.host,
      region: this.region,
      service: 'agentkit',
      action,
      version: VERSION,
      body: JSON.stringify(body),
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      sessionToken: this.opts.sessionToken,
    });
  }

  listMemoryCollections(pageSize = 50): Promise<{ Memories?: MemoryCollection[]; TotalCount?: number }> {
    return this.call('ListMemoryCollections', { PageNumber: 1, PageSize: pageSize });
  }

  getMemoryCollection(memoryId: string): Promise<MemoryCollection> {
    return this.call('GetMemoryCollection', { MemoryId: memoryId });
  }

  /** Create a VikingDB-backed memory collection. Billable (VikingDB). */
  createMemoryCollection(input: { name: string; description?: string }): Promise<MemoryCollection> {
    return this.call('CreateMemoryCollection', {
      Name: input.name,
      Description: input.description,
    });
  }

  /** Escape hatch for actions not yet wrapped (e.g. memory add/search once
   *  their exact names are confirmed against a live collection). */
  raw<T = unknown>(action: string, body: Record<string, unknown>): Promise<T> {
    return this.call<T>(action, body);
  }
}
