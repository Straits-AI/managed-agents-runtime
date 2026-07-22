const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

export interface GhcrDigestReference {
  repository: string;
  digest: string;
}

export interface PublicRegistryReceipt extends GhcrDigestReference {
  manifestUrl: string;
}

export class PublicRegistryVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicRegistryVerificationError';
  }
}

export function parseGhcrDigestReference(value: string): GhcrDigestReference {
  const match = /^ghcr\.io\/([a-z0-9._/-]+)@(sha256:[0-9a-f]{64})$/.exec(value.trim());
  if (!match || !DIGEST.test(match[2]!)) {
    throw new PublicRegistryVerificationError(
      'registry image must be an immutable lowercase ghcr.io sha256 digest reference',
    );
  }
  return { repository: match[1]!, digest: match[2]! };
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_TOKEN_RESPONSE_BYTES) {
    throw new PublicRegistryVerificationError('anonymous registry token response is too large');
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PublicRegistryVerificationError(
          'anonymous registry token response is too large',
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return text;
}

/**
 * Prove public GHCR visibility without Docker credentials or daemon cache.
 * The anonymous token exchange and digest-addressed manifest response must both
 * succeed, and the registry must echo the exact requested content digest.
 */
export async function verifyPublicGhcrImage(
  reference: string,
  request: typeof fetch = fetch,
): Promise<PublicRegistryReceipt> {
  const parsed = parseGhcrDigestReference(reference);
  const tokenUrl = new URL('https://ghcr.io/token');
  tokenUrl.searchParams.set('service', 'ghcr.io');
  tokenUrl.searchParams.set('scope', `repository:${parsed.repository}:pull`);
  const signal = AbortSignal.timeout(30_000);
  const tokenResponse = await request(tokenUrl, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal,
  });
  if (!tokenResponse.ok) {
    throw new PublicRegistryVerificationError(
      `anonymous GHCR token request failed with HTTP ${tokenResponse.status}`,
    );
  }
  let tokenPayload: unknown;
  try {
    tokenPayload = JSON.parse(await boundedText(tokenResponse)) as unknown;
  } catch (error) {
    if (error instanceof PublicRegistryVerificationError) throw error;
    throw new PublicRegistryVerificationError('anonymous GHCR token response is not JSON');
  }
  const token = tokenPayload && typeof tokenPayload === 'object'
    ? (tokenPayload as { token?: unknown }).token
    : undefined;
  if (typeof token !== 'string' || token.length < 20) {
    throw new PublicRegistryVerificationError(
      'anonymous GHCR token response did not contain a pull token',
    );
  }

  const manifestUrl = `https://ghcr.io/v2/${parsed.repository}/manifests/${parsed.digest}`;
  const manifestResponse = await request(manifestUrl, {
    headers: {
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
      authorization: `Bearer ${token}`,
    },
    redirect: 'error',
    signal,
  });
  if (!manifestResponse.ok) {
    throw new PublicRegistryVerificationError(
      `anonymous GHCR manifest request failed with HTTP ${manifestResponse.status}`,
    );
  }
  const returnedDigest = manifestResponse.headers.get('docker-content-digest');
  if (returnedDigest !== parsed.digest) {
    throw new PublicRegistryVerificationError(
      'anonymous GHCR manifest response did not match the requested digest',
    );
  }
  await manifestResponse.body?.cancel();
  return { ...parsed, manifestUrl };
}
