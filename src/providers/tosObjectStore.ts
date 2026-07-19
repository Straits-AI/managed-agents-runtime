import type { Config } from '../config.js';
import { requireConfig } from '../config.js';
import type { ObjectStore } from './types.js';
import {
  buildTosPresignedUrl,
  buildTosSignedRequest,
  type TosSigningInput,
} from './tosProtocol.js';

const MAX_ERROR_BYTES = 64 * 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface TosObjectStoreDependencies {
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class TosObjectStoreError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'TosObjectStoreError';
  }
}

/**
 * Minimal TOS object adapter for workspace snapshots, transcripts, and
 * artifacts. It intentionally uses native fetch plus a small reviewed SigV4
 * implementation instead of the official SDK's vulnerable Axios 0.x chain.
 */
export class TosObjectStore implements ObjectStore {
  private readonly signing: Omit<TosSigningInput, 'key' | 'method' | 'date'>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxObjectBytes: number;

  constructor(cfg: Config, dependencies: TosObjectStoreDependencies = {}) {
    const required = requireConfig(cfg, [
      'BYTEPLUS_ACCESS_KEY_ID',
      'BYTEPLUS_SECRET_ACCESS_KEY',
      'TOS_BUCKET',
    ]);
    this.signing = {
      accessKeyId: required.BYTEPLUS_ACCESS_KEY_ID,
      secretAccessKey: required.BYTEPLUS_SECRET_ACCESS_KEY,
      sessionToken: cfg.BYTEPLUS_SESSION_TOKEN,
      region: cfg.TOS_REGION,
      endpoint: cfg.TOS_ENDPOINT,
      bucket: required.TOS_BUCKET,
    };
    // Validate configuration before the first network operation.
    buildTosSignedRequest({ ...this.signing, key: '.configuration-check', method: 'HEAD' });
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.sleep = dependencies.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))
    );
    this.requestTimeoutMs = cfg.TOS_REQUEST_TIMEOUT_MS;
    this.maxAttempts = cfg.TOS_MAX_ATTEMPTS;
    this.maxObjectBytes = cfg.TOS_MAX_OBJECT_BYTES;
  }

  async put(key: string, body: Buffer): Promise<{ etag: string | null }> {
    const response = await this.request('PUT', key, body);
    await response.body?.cancel();
    return { etag: response.headers.get('etag') };
  }

  async get(key: string): Promise<Buffer> {
    return readBounded(await this.request('GET', key), this.maxObjectBytes);
  }

  async exists(key: string): Promise<boolean> {
    try {
      const response = await this.request('HEAD', key);
      await response.body?.cancel();
      return true;
    } catch (error) {
      if (error instanceof TosObjectStoreError && error.statusCode === 404) return false;
      throw error;
    }
  }

  async presignPut(key: string, ttlSec: number): Promise<string> {
    return buildTosPresignedUrl({
      ...this.signing,
      key,
      method: 'PUT',
      expires: ttlSec,
      date: this.now(),
    });
  }

  async presignGet(key: string, ttlSec: number): Promise<string> {
    return buildTosPresignedUrl({
      ...this.signing,
      key,
      method: 'GET',
      expires: ttlSec,
      date: this.now(),
    });
  }

  /** Administrative helpers used only by the idempotent provisioning script. */
  async bucketExists(): Promise<boolean> {
    try {
      const response = await this.request('HEAD');
      await response.body?.cancel();
      return true;
    } catch (error) {
      if (error instanceof TosObjectStoreError && error.statusCode === 404) return false;
      throw error;
    }
  }

  async createBucket(): Promise<void> {
    const response = await this.request('PUT');
    await response.body?.cancel();
  }

  async delete(key: string): Promise<void> {
    const response = await this.request('DELETE', key);
    await response.body?.cancel();
  }

  private async request(
    method: 'DELETE' | 'GET' | 'HEAD' | 'PUT',
    key?: string,
    body?: Buffer,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const signed = buildTosSignedRequest({
        ...this.signing,
        key,
        method,
        date: this.now(),
      });
      try {
        const response = await this.fetchImpl(signed.url, {
          method,
          headers: {
            ...signed.headers,
            ...(body ? {
              'content-type': 'application/octet-stream',
              'content-length': String(body.byteLength),
            } : {}),
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (response.ok) return response;
        if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
          await response.body?.cancel();
          await this.sleep(100 * 2 ** (attempt - 1));
          continue;
        }
        throw await responseError(response, method, key ?? '(bucket)');
      } catch (error) {
        lastError = error;
        if (error instanceof TosObjectStoreError || attempt === this.maxAttempts) throw error;
        await this.sleep(100 * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 ||
    status === 502 || status === 503 || status === 504;
}

async function responseError(
  response: Response,
  method: string,
  key: string,
): Promise<TosObjectStoreError> {
  const body = (await readBounded(response, MAX_ERROR_BYTES)).toString('utf8');
  let parsed: { Code?: unknown; Message?: unknown; RequestId?: unknown } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    // TOS may return an empty/non-JSON proxy error. The bounded preview remains useful.
  }
  const code = typeof parsed.Code === 'string' ? parsed.Code : `HTTP${response.status}`;
  const message = typeof parsed.Message === 'string'
    ? parsed.Message
    : body.slice(0, 500) || response.statusText || 'request failed';
  const requestId = response.headers.get('x-tos-request-id') ??
    (typeof parsed.RequestId === 'string' ? parsed.RequestId : undefined);
  return new TosObjectStoreError(
    `TOS ${method} ${key} failed (${code}): ${message}`,
    response.status,
    code,
    requestId,
  );
}

async function readBounded(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw new TosObjectStoreError(
      `TOS response exceeds ${maximumBytes} bytes`,
      response.status,
      'ResponseTooLarge',
      response.headers.get('x-tos-request-id') ?? undefined,
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new TosObjectStoreError(
        `TOS response exceeds ${maximumBytes} bytes`,
        response.status,
        'ResponseTooLarge',
        response.headers.get('x-tos-request-id') ?? undefined,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}
