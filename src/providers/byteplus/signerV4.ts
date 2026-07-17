import { createHash, createHmac } from 'node:crypto';

/**
 * Volcengine/BytePlus SignerV4 for PATH-based REST APIs (as opposed to the
 * top-gateway `Action=`/`Version=` style in signer.ts). Needed for the Viking
 * Memory data plane (`api-knowledgebase.mlp.cn-hongkong.bytepluses.com`,
 * service `air`, region `cn-north-1`), which signs the real request path and
 * body rather than a canonical "/". Algorithm follows the volcengine SDK's
 * SignerV4.
 */
export interface SignV4Input {
  host: string;
  region: string;
  service: string;
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  date?: Date; // injectable for tests
}

const SIGNED_HEADERS = 'content-type;host;x-content-sha256;x-date';

function hmac(key: Buffer | string, content: string): Buffer {
  return createHmac('sha256', key).update(content, 'utf8').digest();
}
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
function normQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join('&')
    .replace(/\+/g, '%20');
}

export function buildSignedRequestV4(input: SignV4Input): {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | undefined;
} {
  const method = input.method ?? 'POST';
  const body = input.body ?? '';
  const query = input.query ?? {};
  const date = input.date ?? new Date();
  const xDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const shortDate = xDate.slice(0, 8);
  const xContentSha256 = sha256Hex(body);
  const contentType = 'application/json';

  const canonicalRequest = [
    method,
    input.path, // real path, signed as-is
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

  const url = new URL(`https://${input.host}${input.path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v);

  return { url: url.toString(), method, headers, body: body || undefined };
}

export class VikingApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(`${path} failed (${code}): ${message}`);
    this.name = 'VikingApiError';
  }
}

/** Sign, send, and unwrap a Viking Memory REST call. */
export async function signedCallV4<T = unknown>(input: SignV4Input): Promise<T> {
  const req = buildSignedRequestV4(input);
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  let parsed: { code?: number; message?: string; data?: unknown } & Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VikingApiError(input.path, `HTTP${res.status}`, text.slice(0, 400), res.status);
  }
  // Viking/knowledgebase APIs return { code, message, data } — code 0 = OK.
  if (!res.ok || (typeof parsed.code === 'number' && parsed.code !== 0)) {
    throw new VikingApiError(
      input.path,
      String(parsed.code ?? `HTTP${res.status}`),
      String(parsed.message ?? text.slice(0, 400)),
      res.status,
    );
  }
  return (parsed.data ?? parsed) as T;
}
