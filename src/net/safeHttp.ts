import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface EgressPolicy {
  /** Empty means no hostname allowlist. Production configuration forbids that. */
  allowedOrigins: string[];
  /** Controlled proxy endpoint. The target is still resolved and policy-checked. */
  proxyUrl: string | null;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxRedirects: number;
  maxResponseBytes: number;
}

export interface SafeHttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /** Exact origins explicitly authorized to reach non-public address space. */
  privateOrigins?: string[];
  signal?: AbortSignal;
}

export interface SafeHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  redirects: number;
}

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback, and deprecated IPv4-compatible forms
  ['::ffff:0:0', 96], // mapped IPv4 alternate encodings
  ['64:ff9b:1::', 48], // local-use IPv4/IPv6 translation
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments, not ordinary destinations
  ['2002::', 16], // 6to4 embeds an IPv4 destination
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment-routing SIDs
  ['fc00::', 7], // unique-local, including fd00:ec2::254 metadata
  ['fe80::', 10],
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

// Exact-origin grants may authorize ordinary internal networks, but a hostname
// grant must never become an implicit metadata/link-local/reserved grant after
// DNS changes. Those restricted ranges require the origin itself to name the
// literal address.
const privateIpv4 = new BlockList();
for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  privateIpv4.addSubnet(network, prefix, 'ipv4');
}
const privateIpv6 = new BlockList();
privateIpv6.addSubnet('fc00::', 7, 'ipv6');

const knownMetadataAddresses = new BlockList();
knownMetadataAddresses.addAddress('169.254.169.254', 'ipv4');
knownMetadataAddresses.addAddress('100.100.100.200', 'ipv4');
knownMetadataAddresses.addAddress('fd00:ec2::254', 'ipv6');

const loopbackIpv4 = new BlockList();
loopbackIpv4.addSubnet('127.0.0.0', 8, 'ipv4');

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? loopbackIpv4.check(address, 'ipv4')
    : family === 6 && address === '::1';
}

export function assertPublicAddress(rawAddress: string): void {
  const address = rawAddress.startsWith('[') && rawAddress.endsWith(']')
    ? rawAddress.slice(1, -1)
    : rawAddress;
  const family = isIP(address);
  if (family === 0) throw new Error(`resolved address is invalid: ${rawAddress}`);
  const denied = family === 4
    ? blockedIpv4.check(address, 'ipv4')
    : blockedIpv6.check(address, 'ipv6');
  if (denied) {
    throw new Error(`destination address ${rawAddress} is not permitted by egress policy`);
  }
}

function isOrdinaryPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? privateIpv4.check(address, 'ipv4')
    : family === 6 && privateIpv6.check(address, 'ipv6');
}

function assertAddressAllowed(url: URL, address: string, allowPrivate: boolean): void {
  try {
    assertPublicAddress(address);
    return;
  } catch (error) {
    if (!allowPrivate) throw error;
  }
  const hostname = normalizedHostname(url);
  const literalAddressGrant = isIP(hostname) !== 0 &&
    hostname.toLowerCase() === address.toLowerCase();
  const family = isIP(address);
  const knownMetadata = family !== 0 && knownMetadataAddresses.check(
    address,
    family === 4 ? 'ipv4' : 'ipv6',
  );
  if (!knownMetadata && isOrdinaryPrivateAddress(address)) return;
  if (literalAddressGrant) return;
  throw new Error(
    `restricted destination address ${address} requires an exact literal-address origin grant`,
  );
}

const defaultResolver: AddressResolver = async (hostname) => {
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    return [{ address: hostname, family: literalFamily as 4 | 6 }];
  }
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family as 4 | 6,
  }));
};

function matchesOrigin(pattern: string, url: URL): boolean {
  if (pattern === url.origin) return true;
  try {
    const allowed = new URL(pattern.replace('://*.', '://wildcard.'));
    if (!pattern.includes('://*.')) return false;
    const suffix = allowed.hostname.slice('wildcard'.length);
    return allowed.protocol === url.protocol &&
      (allowed.port || '') === (url.port || '') &&
      url.hostname.endsWith(suffix) &&
      url.hostname.length > suffix.length;
  } catch {
    return false;
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

function responseHeaders(
  headers: import('node:http').IncomingHttpHeaders,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

function redirectHeaders(headers: Record<string, string>, crossOrigin: boolean) {
  if (!crossOrigin) return headers;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (['accept', 'content-type', 'idempotency-key', 'user-agent'].includes(name.toLowerCase())) {
      kept[name] = value;
    }
  }
  return kept;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  }
  headers[name] = value;
}

export class SafeHttpClient {
  private readonly resolver: AddressResolver;

  constructor(
    private readonly policy: EgressPolicy,
    dependencies: { resolver?: AddressResolver } = {},
  ) {
    this.resolver = dependencies.resolver ?? defaultResolver;
  }

  async request(input: SafeHttpRequest): Promise<SafeHttpResponse> {
    if (input.signal?.aborted) throw cancellationError(input.signal);
    const deadline = Date.now() + this.policy.totalTimeoutMs;
    let target = this.parseTarget(input.url);
    let method = input.method.toUpperCase();
    let body = input.body;
    let headers = { ...(input.headers ?? {}) };
    let redirects = 0;
    const privateOrigins = new Set(input.privateOrigins ?? []);

    for (;;) {
      const targetAddress = await this.resolveTarget(
        target,
        privateOrigins.has(target.origin),
        deadline,
        true,
        false,
        input.signal,
      );
      if (input.signal?.aborted) throw cancellationError(input.signal);
      let transportUrl = target;
      let transportAddress = targetAddress;
      if (this.policy.proxyUrl) {
        transportUrl = this.parseTarget(this.policy.proxyUrl, false);
        // A configured proxy is itself a narrow operator authorization and may
        // live on private infrastructure.
        transportAddress = await this.resolveTarget(
          transportUrl,
          true,
          deadline,
          false,
          transportUrl.protocol === 'http:',
          input.signal,
        );
        // The controlled proxy MUST connect to this already-validated address
        // while preserving target URL host/SNI. Re-resolving the hostname at
        // the proxy would reopen DNS-rebinding attacks.
        setHeader(headers, 'x-managed-agents-target-url', target.toString());
        setHeader(headers, 'x-managed-agents-target-address', targetAddress.address);
        setHeader(headers, 'x-managed-agents-target-family', String(targetAddress.family));
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('HTTP total deadline exceeded');
      const response = await this.requestOnce({
        url: transportUrl,
        address: transportAddress,
        method,
        headers,
        body,
        totalTimeoutMs: remaining,
        signal: input.signal,
      });
      const location = response.headers.location;
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        return { ...response, redirects };
      }
      if (redirects >= this.policy.maxRedirects) {
        throw new Error(`HTTP redirect limit exceeded (${this.policy.maxRedirects})`);
      }
      const next = this.parseTarget(new URL(location, target).toString());
      headers = redirectHeaders(headers, next.origin !== target.origin);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === 'content-type') delete headers[name];
        }
      }
      target = next;
      redirects += 1;
    }
  }

  private parseTarget(raw: string, enforceAllowlist = true): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('invalid HTTP destination URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`URL scheme ${url.protocol} is not allowed`);
    }
    if (url.username || url.password) throw new Error('URL userinfo is not allowed');
    if (enforceAllowlist && this.policy.allowedOrigins.length > 0 &&
      !this.policy.allowedOrigins.some((pattern) => matchesOrigin(pattern, url))) {
      throw new Error(`origin ${url.origin} is not present in the egress allowlist`);
    }
    return url;
  }

  private async resolveTarget(
    url: URL,
    allowPrivate: boolean,
    deadline: number,
    enforceAllowlist = true,
    requireLoopback = false,
    signal?: AbortSignal,
  ): Promise<ResolvedAddress> {
    if (enforceAllowlist && this.policy.allowedOrigins.length > 0 &&
      !this.policy.allowedOrigins.some((pattern) => matchesOrigin(pattern, url))) {
      throw new Error(`origin ${url.origin} is not present in the egress allowlist`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('HTTP total deadline exceeded');
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const abort = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(cancellationError(signal!));
      signal?.addEventListener('abort', abortListener, { once: true });
      if (signal?.aborted) abortListener();
    });
    const answers = await Promise.race([
      this.resolver(normalizedHostname(url)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('HTTP total deadline exceeded while resolving DNS')),
          remaining,
        );
      }),
      abort,
    ]).finally(() => {
      clearTimeout(timer);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
    });
    if (answers.length === 0) throw new Error(`DNS returned no addresses for ${url.hostname}`);
    for (const answer of answers) {
      if (isIP(answer.address) !== answer.family) {
        throw new Error(`DNS returned an invalid address family for ${url.hostname}`);
      }
      if (requireLoopback) {
        if (!isLoopbackAddress(answer.address)) {
          throw new Error(
            `plaintext HTTP proxy address ${answer.address} is not loopback`,
          );
        }
        continue;
      }
      assertAddressAllowed(url, answer.address, allowPrivate);
    }
    return answers[0]!;
  }

  private requestOnce(input: {
    url: URL;
    address: ResolvedAddress;
    method: string;
    headers: Record<string, string>;
    body?: string;
    totalTimeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Omit<SafeHttpResponse, 'redirects'>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let request: ReturnType<typeof httpRequest>;
      const abort = () => request?.destroy(cancellationError(input.signal!));
      const finish = <T>(fn: (value: T) => void, value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        clearTimeout(connectTimer);
        input.signal?.removeEventListener('abort', abort);
        fn(value);
      };
      const fail = (error: Error) => finish(reject, error);
      const totalTimer = setTimeout(() => {
        request.destroy(new Error('HTTP total deadline exceeded'));
      }, input.totalTimeoutMs);
      const connectTimer = setTimeout(() => {
        request.destroy(new Error('HTTP connect deadline exceeded'));
      }, Math.min(this.policy.connectTimeoutMs, input.totalTimeoutMs));
      const options: RequestOptions = {
        protocol: input.url.protocol,
        hostname: normalizedHostname(input.url),
        port: input.url.port || undefined,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: input.headers,
        lookup: (_hostname, _options, callback) => {
          callback(null, input.address.address, input.address.family);
        },
      };
      request = (input.url.protocol === 'https:' ? httpsRequest : httpRequest)(
        options,
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer | string) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += data.length;
            if (bytes > this.policy.maxResponseBytes) {
              response.destroy(new Error(
                `HTTP response byte limit exceeded (${this.policy.maxResponseBytes})`,
              ));
              return;
            }
            chunks.push(data);
          });
          response.once('error', fail);
          response.once('end', () => {
            finish(resolve, {
              status: response.statusCode ?? 0,
              headers: responseHeaders(response.headers),
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      request.once('socket', (socket) => {
        const connectedEvent = input.url.protocol === 'https:' ? 'secureConnect' : 'connect';
        socket.once(connectedEvent, () => clearTimeout(connectTimer));
      });
      request.once('error', fail);
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) {
        abort();
        return;
      }
      if (input.body !== undefined) request.write(input.body);
      request.end();
    });
  }
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('HTTP request cancelled');
}
