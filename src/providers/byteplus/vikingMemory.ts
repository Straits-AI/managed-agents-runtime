import { signedCallV4 } from './signerV4.js';

/**
 * Viking Memory data-plane client (backs AgentKit Memory). Contract confirmed
 * live 2026-07-17 against collection `managed_agents_mem`:
 *
 *   host    api-knowledgebase.mlp.cn-hongkong.bytepluses.com
 *   sign    SignerV4, service `air`, region `cn-north-1`
 *   write   POST /api/memory/session/add
 *           { collection_name, session_id, metadata:{ default_user_id,
 *             default_assistant_id, time(ms) }, messages:[{role, content}] }
 *   search  POST /api/memory/get_context
 *           { collection_name, query, event_search_config:{ filter:{ user_id,
 *             memory_type:['event_v1'] }, limit } }
 *
 * Memory is AI-EXTRACTED asynchronously from written session messages, so a
 * memory may not be searchable immediately after a write.
 */
const HOST = 'api-knowledgebase.mlp.cn-hongkong.bytepluses.com';
const SERVICE = 'air';
const SIGN_REGION = 'cn-north-1';

export interface VikingMemoryOptions {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  collectionName: string;
}

export interface GetContextResult {
  context?: string;
  context_parts?: { content?: string; memory_type?: string; [k: string]: unknown }[];
  token_usage?: number;
}

export class VikingMemoryClient {
  constructor(private readonly opts: VikingMemoryOptions) {}

  private call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return signedCallV4<T>({
      host: HOST,
      region: SIGN_REGION,
      service: SERVICE,
      path,
      body: JSON.stringify(body),
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      sessionToken: this.opts.sessionToken,
    });
  }

  /** Write conversation turns; Viking extracts event/profile memories from them. */
  addSession(input: {
    userId: string;
    assistantId: string;
    messages: { role: string; content: string }[];
    sessionId?: string;
    timeMs?: number;
  }): Promise<{ session_id: string }> {
    return this.call('/api/memory/session/add', {
      collection_name: this.opts.collectionName,
      session_id: input.sessionId ?? `sess-${input.timeMs ?? Date.now()}`,
      metadata: {
        default_user_id: input.userId,
        default_assistant_id: input.assistantId,
        time: input.timeMs ?? Date.now(),
      },
      messages: input.messages,
    });
  }

  /** Retrieve extracted memories relevant to `query` for a user scope. */
  getContext(input: {
    userId: string;
    query: string;
    limit?: number;
    memoryType?: string[];
  }): Promise<GetContextResult> {
    return this.call('/api/memory/get_context', {
      collection_name: this.opts.collectionName,
      query: input.query,
      event_search_config: {
        filter: { user_id: input.userId, memory_type: input.memoryType ?? ['event_v1'] },
        limit: input.limit ?? 10,
      },
    });
  }
}
