import { createHash, createHmac } from 'node:crypto';

/**
 * Volcengine/BytePlus top-gateway HMAC-SHA256 request signing (SigV4-like).
 * Algorithm verified against @agent-infra/sandbox's published implementation
 * (dist/esm/providers/sign.mjs), with two deliberate differences: the host
 * and region are configurable (the SDK hardcodes open.volcengineapi.com /
 * cn-beijing), and errors are surfaced instead of swallowed.
 */
export interface SignRequestInput {
  host: string;
  region: string;
  service: string;
  action: string;
  version: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Injectable for deterministic tests. */
  date?: Date;
}

export interface SignedRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | undefined;
}

const SIGNED_HEADERS = 'content-type;host;x-content-sha256;x-date';

function hmac(key: Buffer | string, content: string): Buffer {
  return createHmac('sha256', key).update(content, 'utf8').digest();
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Sorted, RFC3986-style query normalization (matches the SDK). */
function normQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join('&')
    .replace(/\+/g, '%20');
}

export function buildSignedRequest(input: SignRequestInput): SignedRequest {
  const method = input.method ?? 'POST';
  const body = input.body ?? '';
  const contentType =
    method === 'POST' ? 'application/json' : 'application/x-www-form-urlencoded';
  const query = { Action: input.action, Version: input.version, ...input.query };

  const date = input.date ?? new Date();
  const xDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const shortDate = xDate.slice(0, 8);
  const xContentSha256 = sha256Hex(body);

  const canonicalRequest = [
    method,
    '/',
    normQuery(query),
    `content-type:${contentType}`,
    `host:${input.host}`,
    `x-content-sha256:${xContentSha256}`,
    `x-date:${xDate}`,
    '',
    SIGNED_HEADERS,
    xContentSha256,
  ].join('\n');

  const credentialScope = [shortDate, input.region, input.service, 'request'].join('/');
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(Buffer.from(input.secretAccessKey, 'utf8'), shortDate);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const headers: Record<string, string> = {
    Host: input.host,
    'Content-Type': contentType,
    'X-Content-Sha256': xContentSha256,
    'X-Date': xDate,
    Authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
  };
  if (input.sessionToken) headers['X-Security-Token'] = input.sessionToken;

  const url = new URL(`https://${input.host}/`);
  for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v);

  return { url: url.toString(), method, headers, body: body || undefined };
}

export class BytePlusApiError extends Error {
  constructor(
    public readonly action: string,
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
    public readonly requestId?: string,
  ) {
    super(`${action} failed (${code}): ${message}`);
    this.name = 'BytePlusApiError';
  }
}

interface OpenApiResponse {
  ResponseMetadata?: {
    RequestId?: string;
    Error?: { Code?: string; CodeN?: number; Message?: string };
  };
  Result?: unknown;
}

export interface SignedCallMetadata<T> {
  result: T;
  requestId: string | null;
}

export function boundedRequestId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
    ? value
    : null;
}

/** Sign, send, and preserve bounded successful response metadata. */
export async function signedCallWithMetadata<T = unknown>(
  input: SignRequestInput,
): Promise<SignedCallMetadata<T>> {
  const req = buildSignedRequest(input);
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  let parsed: OpenApiResponse;
  const text = await res.text();
  try {
    parsed = JSON.parse(text) as OpenApiResponse;
  } catch {
    throw new BytePlusApiError(
      input.action,
      'InvalidResponse',
      `non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`,
      res.status,
    );
  }

  const err = parsed.ResponseMetadata?.Error;
  if (err || !res.ok) {
    throw new BytePlusApiError(
      input.action,
      err?.Code ?? `HTTP${res.status}`,
      err?.Message ?? text.slice(0, 500),
      res.status,
      parsed.ResponseMetadata?.RequestId,
    );
  }
  return {
    result: parsed.Result as T,
    requestId: boundedRequestId(parsed.ResponseMetadata?.RequestId),
  };
}

/** Sign, send, and unwrap a top-gateway OpenAPI call. Throws on any error. */
export async function signedCall<T = unknown>(input: SignRequestInput): Promise<T> {
  return (await signedCallWithMetadata<T>(input)).result;
}
