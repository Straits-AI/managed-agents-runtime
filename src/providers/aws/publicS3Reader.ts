import type { ReadableObjectStore } from '../types.js';

const DEFAULT_MAX_OBJECT_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface AwsPublicS3ReaderOptions {
  bucket: string;
  region: string;
  maxObjectBytes?: number;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface AwsPublicS3Metadata {
  status: number;
  requestId: string | null;
  etag: string | null;
  contentLength: number | null;
}

export class AwsPublicS3Error extends Error {
  constructor(
    public readonly operation: 'HEAD' | 'GET',
    public readonly status: number | null,
    public readonly requestId: string | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AwsPublicS3Error';
  }
}

/**
 * Anonymous, read-only Amazon S3 capability adapter. It intentionally does not
 * implement ObjectStore writes or presigning, so capability selection cannot
 * accidentally use a public-data profile for runtime checkpoints.
 */
export class AwsPublicS3Reader implements ReadableObjectStore {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly maxObjectBytes: number;
  private readonly requestTimeoutMs: number;

  constructor(options: AwsPublicS3ReaderOptions) {
    if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new Error('AWS public S3 bucket name is invalid');
    }
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(options.region)) {
      throw new Error('AWS public S3 region is invalid');
    }
    this.maxObjectBytes = boundedPositiveInteger(
      options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES,
      'AWS public S3 maxObjectBytes',
    );
    this.requestTimeoutMs = boundedPositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      'AWS public S3 requestTimeoutMs',
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = `https://${options.bucket}.s3.${options.region}.amazonaws.com`;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.inspect(key)).exists;
  }

  async inspect(key: string): Promise<{ exists: boolean; metadata: AwsPublicS3Metadata }> {
    return this.withResponse('HEAD', key, async (response) => {
      const metadata = responseMetadata(response);
      if (response.status === 200) return { exists: true, metadata };
      if (response.status === 404) return { exists: false, metadata };
      await response.body?.cancel().catch(() => {});
      throw providerError('HEAD', response, 'AWS public S3 HEAD failed');
    });
  }

  async get(key: string): Promise<Buffer> {
    return (await this.getWithMetadata(key)).body;
  }

  async getWithMetadata(key: string): Promise<{ body: Buffer; metadata: AwsPublicS3Metadata }> {
    return this.withResponse('GET', key, async (response) => {
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw providerError('GET', response, 'AWS public S3 GET failed');
      }
      const metadata = responseMetadata(response);
      if (metadata.contentLength !== null && metadata.contentLength > this.maxObjectBytes) {
        await response.body?.cancel().catch(() => {});
        throw providerError('GET', response, 'AWS public S3 object exceeds configured byte limit');
      }
      return { body: await readBounded(response, this.maxObjectBytes), metadata };
    });
  }

  private async withResponse<T>(
    method: 'HEAD' | 'GET',
    key: string,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const encodedKey = encodeObjectKey(key);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/${encodedKey}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'application/octet-stream' },
      });
      return await consume(response);
    } catch (error) {
      if (error instanceof AwsPublicS3Error) throw error;
      const reason = controller.signal.aborted ? 'request timed out' : 'transport failed';
      throw new AwsPublicS3Error(method, null, null, `AWS public S3 ${method} ${reason}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw providerError('GET', response, 'AWS public S3 object exceeds configured byte limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function responseMetadata(response: Response): AwsPublicS3Metadata {
  const rawLength = response.headers.get('content-length');
  const contentLength = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
  return {
    status: response.status,
    requestId: boundedHeader(response.headers.get('x-amz-request-id')),
    etag: boundedHeader(response.headers.get('etag')),
    contentLength: Number.isSafeInteger(contentLength) ? contentLength : null,
  };
}

function providerError(
  operation: 'HEAD' | 'GET',
  response: Response,
  message: string,
): AwsPublicS3Error {
  return new AwsPublicS3Error(
    operation,
    response.status,
    boundedHeader(response.headers.get('x-amz-request-id')),
    message,
  );
}

function encodeObjectKey(key: string): string {
  if (!key || key.length > 1_024 || key.includes('\0')) throw new Error('AWS public S3 object key is invalid');
  const parts = key.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('AWS public S3 object key is invalid');
  }
  return parts.map((part) => encodeURIComponent(part)).join('/');
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function boundedHeader(value: string | null): string | null {
  return value === null ? null : value.slice(0, 256);
}
