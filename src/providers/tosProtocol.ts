import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'TOS4-HMAC-SHA256';
const PAYLOAD_HASH = 'UNSIGNED-PAYLOAD';
const SERVICE = 'tos';
const TERMINATOR = 'request';

export interface TosSigningInput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint: string;
  region: string;
  bucket: string;
  key?: string;
  method: 'DELETE' | 'GET' | 'HEAD' | 'PUT';
  date?: Date;
}

export interface TosSignedRequest {
  method: 'DELETE' | 'GET' | 'HEAD' | 'PUT';
  url: string;
  headers: Record<string, string>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${encode(key)}=${encode(query[key]!)}`)
    .join('&');
}

function requestPath(key?: string): string {
  return key === undefined ? '/' : `/${encodeURIComponent(key)}`;
}

function publicPath(key: string): string {
  return `/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function canonicalPath(path: string): string {
  return path
    .replaceAll('%2F', '/')
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('!', '%21')
    .replaceAll('*', '%2A')
    .replaceAll("'", '%27');
}

function xDate(date: Date): string {
  if (!Number.isFinite(date.valueOf())) throw new Error('TOS signing date is invalid');
  return `${date.toISOString().replace(/\..+/, '').replaceAll('-', '').replaceAll(':', '')}Z`;
}

function validate(input: TosSigningInput): void {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket)) {
    throw new Error('TOS bucket must be 3-63 lowercase letters, digits, or hyphens');
  }
  if (input.key !== undefined && !input.key) {
    throw new Error('TOS object key must be non-empty');
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(input.endpoint)) {
    throw new Error('TOS endpoint must be a hostname without a scheme, path, or port');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.region)) {
    throw new Error('TOS region is invalid');
  }
  if (!input.accessKeyId || !input.secretAccessKey) {
    throw new Error('TOS credentials must be non-empty');
  }
}

function signedHeaders(headers: Record<string, string>): string[] {
  return Object.keys(headers)
    .filter((key) => key === 'host' || key.startsWith('x-tos-'))
    .sort();
}

function signature(input: {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  datetime: string;
  credentialRegion: string;
  secretAccessKey: string;
}): { signedHeaderNames: string; value: string } {
  const headerNames = signedHeaders(input.headers);
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${input.headers[name]!.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  const signedHeaderNames = headerNames.join(';');
  const canonicalRequest = [
    input.method,
    canonicalPath(input.path),
    canonicalQuery(input.query),
    canonicalHeaders,
    '',
    signedHeaderNames,
    PAYLOAD_HASH,
  ].join('\n');
  const shortDate = input.datetime.slice(0, 8);
  const scope = `${shortDate}/${input.credentialRegion}/${SERVICE}/${TERMINATOR}`;
  const stringToSign = [ALGORITHM, input.datetime, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(input.secretAccessKey, shortDate);
  const regionKey = hmac(dateKey, input.credentialRegion);
  const serviceKey = hmac(regionKey, SERVICE);
  const signingKey = hmac(serviceKey, TERMINATOR);
  return {
    signedHeaderNames,
    value: hmac(signingKey, stringToSign).toString('hex'),
  };
}

/** Build the authenticated request used by direct TOS object operations. */
export function buildTosSignedRequest(input: TosSigningInput): TosSignedRequest {
  validate(input);
  const datetime = xDate(input.date ?? new Date());
  const host = `${input.bucket}.${input.endpoint}`;
  const path = requestPath(input.key);
  const headers: Record<string, string> = {
    host,
    'x-tos-date': datetime,
    'x-tos-content-sha256': PAYLOAD_HASH,
  };
  if (input.sessionToken) headers['x-tos-security-token'] = input.sessionToken;
  const signed = signature({
    method: input.method,
    path,
    query: {},
    headers,
    datetime,
    credentialRegion: input.region,
    secretAccessKey: input.secretAccessKey,
  });
  const scope = `${datetime.slice(0, 8)}/${input.region}/${SERVICE}/${TERMINATOR}`;
  headers.authorization =
    `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signed.signedHeaderNames}, Signature=${signed.value}`;
  return {
    method: input.method,
    url: `https://${host}${path}`,
    headers,
  };
}

/** Build a query-authenticated URL compatible with the official 2.9.1 SDK. */
export function buildTosPresignedUrl(
  input: Omit<TosSigningInput, 'method' | 'key'> & {
    key: string;
    method: 'GET' | 'PUT';
    expires: number;
  },
): string {
  validate(input);
  if (!Number.isInteger(input.expires) || input.expires < 1 || input.expires > 604_800) {
    throw new Error('TOS presigned URL expiry must be an integer from 1 to 604800 seconds');
  }
  const datetime = xDate(input.date ?? new Date());
  const host = `${input.bucket}.${input.endpoint}`;
  const path = requestPath(input.key);
  // The official SDK uses the endpoint in the credential scope for presigned
  // URLs (while header-authenticated calls use TOS_REGION). Preserve that wire
  // contract so replacing the SDK does not invalidate existing behavior.
  const credentialRegion = input.endpoint;
  const scope = `${datetime.slice(0, 8)}/${credentialRegion}/${SERVICE}/${TERMINATOR}`;
  const query: Record<string, string> = {
    'X-Tos-Algorithm': ALGORITHM,
    'X-Tos-Content-Sha256': PAYLOAD_HASH,
    'X-Tos-Credential': `${input.accessKeyId}/${scope}`,
    'X-Tos-Date': datetime,
    'X-Tos-Expires': String(input.expires),
    'X-Tos-SignedHeaders': 'host',
  };
  if (input.sessionToken) query['X-Tos-Security-Token'] = input.sessionToken;
  const signed = signature({
    method: input.method,
    path,
    query,
    headers: { host },
    datetime,
    credentialRegion,
    secretAccessKey: input.secretAccessKey,
  });
  query['X-Tos-Signature'] = signed.value;
  const encodedQuery = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `https://${host}${publicPath(input.key)}?${encodedQuery}`;
}
