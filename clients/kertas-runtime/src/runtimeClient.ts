import {
  parseRuntimeContractDiscovery,
  selectCompatibleContract,
  type RuntimeContractDiscovery,
  type SelectedRuntimeContract,
} from './contractDiscovery.js';

export interface ClientOptions {
  baseUrl: string;
  bearerToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class RuntimeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message = `runtime request failed with HTTP ${status}`,
  ) {
    super(message);
    this.name = 'RuntimeHttpError';
  }
}

export interface ManagedSessionResource {
  apiVersion: 'kertas.runtime/v1alpha1';
  kind: 'ManagedSession';
  id: string;
  tenantId: string;
  version: number;
  state: string;
  currentTopLevelRunId: string | null;
  [key: string]: unknown;
}

export interface ManagedSessionEventResource {
  apiVersion: 'kertas.runtime/v1alpha1';
  kind: 'ManagedSessionEvent';
  id: string;
  sessionId: string;
  eventId: string;
  receivedSequence: number;
  status: string;
  runId: string | null;
  [key: string]: unknown;
}

export interface RunSummary {
  id: string;
  status: string;
  [key: string]: unknown;
}

export class KertasRuntimeClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('timeoutMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new Error('maxResponseBytes must be a positive safe integer');
    }
  }

  async discover(): Promise<SelectedRuntimeContract> {
    return selectCompatibleContract(await this.getContractCatalog());
  }

  async getContractCatalog(): Promise<RuntimeContractDiscovery> {
    return parseRuntimeContractDiscovery(await this.request('/v1/contracts'));
  }

  getContractDocument(
    contractId: 'run-as-session/v1' | 'kertas.runtime/v1alpha1',
  ): Promise<Record<string, unknown>> {
    const path = contractId === 'run-as-session/v1'
      ? '/v1/contracts/run-as-session/v1'
      : '/v1/contracts/kertas.runtime/v1alpha1';
    return this.request(path);
  }

  createAgent(input: { name: string; description?: string }): Promise<Record<string, unknown>> {
    return this.request('/v1/agents', { method: 'POST', body: input });
  }

  createAgentVersion(
    agentId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(`/v1/agents/${encodeURIComponent(agentId)}/versions`, {
      method: 'POST', body: input,
    });
  }

  createManagedSession(
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ManagedSessionResource> {
    return this.request('/v1alpha1/sessions', {
      method: 'POST', body: input, idempotencyKey,
    });
  }

  getManagedSession(sessionId: string): Promise<ManagedSessionResource> {
    return this.request(`/v1alpha1/sessions/${encodeURIComponent(sessionId)}`);
  }

  deliverManagedSessionEvent(
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<ManagedSessionEventResource> {
    return this.request(`/v1alpha1/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST', body: input,
    });
  }

  listManagedSessionEvents(
    sessionId: string,
    input: { after?: string; limit?: number } = {},
  ): Promise<{ events: ManagedSessionEventResource[]; nextCursor: string | null }> {
    const query = new URLSearchParams();
    if (input.after !== undefined) query.set('after', input.after);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request(
      `/v1alpha1/sessions/${encodeURIComponent(sessionId)}/events${suffix}`,
    );
  }

  listManagedSessionRuns(sessionId: string): Promise<{ runs: RunSummary[] }> {
    return this.request(`/v1alpha1/sessions/${encodeURIComponent(sessionId)}/runs`);
  }

  createCompatibilityRun(input: Record<string, unknown>): Promise<RunSummary> {
    return this.request('/v1/runs', { method: 'POST', body: input });
  }

  getRun(runId: string): Promise<RunSummary> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  listRunEvents(
    runId: string,
    afterSequence = '0',
  ): Promise<{ events: Array<{ seq: string | number; type: string; [key: string]: unknown }> }> {
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/events?afterSeq=${encodeURIComponent(afterSequence)}`,
    );
  }

  listRunArtifacts(runId: string): Promise<{ artifacts: Array<Record<string, unknown>> }> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/artifacts`);
  }

  getChildResults(runId: string): Promise<{
    schemaVersion: number;
    parentRunId: string;
    children: Array<Record<string, unknown>>;
    selected: Array<Record<string, unknown>>;
  }> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/children`);
  }

  async getArtifactContent(
    runId: string,
    artifactId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}`
        + `/artifacts/${encodeURIComponent(artifactId)}/content`,
      {
        headers: { authorization: `Bearer ${this.bearerToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    const bytes = await this.readBounded(response);
    if (!response.ok) {
      throw new RuntimeHttpError(response.status, new TextDecoder().decode(bytes));
    }
    return { bytes, contentType: response.headers.get('content-type') };
  }

  private async request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      body?: Record<string, unknown>;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.bearerToken}`,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey !== undefined) {
      headers['idempotency-key'] = options.idempotencyKey;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const bytes = await this.readBounded(response);
    const text = new TextDecoder().decode(bytes);
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!response.ok) throw new RuntimeHttpError(response.status, body);
    return body as T;
  }

  private async readBounded(response: Response): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > this.maxResponseBytes) {
      await response.body?.cancel();
      throw new RuntimeHttpError(502, { error: 'runtime_response_too_large' });
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > this.maxResponseBytes) {
        await reader.cancel();
        throw new RuntimeHttpError(502, { error: 'runtime_response_too_large' });
      }
      chunks.push(next.value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}
