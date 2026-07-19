import { randomUUID } from 'node:crypto';

export interface TosConformanceStore {
  bucketExists(): Promise<boolean>;
  createBucket(): Promise<void>;
  put(key: string, body: Buffer): Promise<{ etag: string | null }>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  presignGet(key: string, ttlSec: number): Promise<string>;
  presignPut(key: string, ttlSec: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface TosConformanceEvidence {
  schemaVersion: 1;
  runId: string;
  controlPlane: {
    bucketExisted: boolean;
    bucketCreated: boolean;
    bucketHeadSucceeded: boolean;
  };
  dataPlane: {
    directPutGet: true;
    directHead: true;
    presignedGet: true;
    presignedPut: true;
  };
  failurePath: {
    operation: 'GET deleted object';
    statusCode: 404;
    code: string;
    requestId: string | null;
  };
  redaction: {
    credentialFieldsIncluded: false;
    payloadIncluded: false;
    presignedUrlsIncluded: false;
  };
  cleanup: {
    objectsDeleted: true;
    objectsVerifiedAbsent: number;
    configuredBucketRetained: true;
  };
}

export interface TosConformanceRecordMetadata {
  sourceRepository: string;
  sourceCommit: string;
  sourceCommitOrigin:
    | 'environment'
    | 'environment-verified-clean-worktree'
    | 'git-clean-worktree';
  adapterName: string;
  adapterSourcePath: string;
  packageVersion: string;
  runtime: string;
  transport: string;
  apiVersion: string;
  provider: string;
  region: string;
  endpoint: string;
  bucket: string;
  credentialBoundary: {
    source: 'process-environment';
    mode: 'temporary-session' | 'long-lived-access-key';
    valuesSerialized: false;
  };
  retrievedAt: Date;
  capabilities: readonly string[];
  untestedSemantics: readonly string[];
  unsupportedSemantics: readonly string[];
}

export interface TosConformanceRecord {
  schemaVersion: 1;
  evidenceId: string;
  source: {
    repository: string;
    commit: string;
    commitOrigin:
      | 'environment'
      | 'environment-verified-clean-worktree'
      | 'git-clean-worktree';
  };
  adapter: {
    name: string;
    sourcePath: string;
    packageVersion: string;
  };
  toolchain: {
    runtime: string;
    transport: string;
    apiVersion: string;
  };
  provider: string;
  region: string;
  endpoint: string;
  bucket: string;
  credentialBoundary: TosConformanceRecordMetadata['credentialBoundary'];
  retrievedAt: string;
  capabilities: string[];
  untestedSemantics: string[];
  unsupportedSemantics: string[];
  evidence: TosConformanceEvidence;
}

export interface TosConformanceSourceInput {
  explicitCommit?: string;
  gitCommit: string | null;
  gitStatus: string | null;
}

export interface TosConformanceSource {
  commit: string;
  commitOrigin: TosConformanceRecordMetadata['sourceCommitOrigin'];
}

interface TosConformanceDependencies {
  fetch?: typeof globalThis.fetch;
  runId?: string;
  payload?: Buffer;
}

const DEFAULT_PAYLOAD = Buffer.from('managed-agents-runtime TOS conformance v1');
const PRESIGN_TTL_SECONDS = 60;

export function resolveTosConformanceSource(
  input: TosConformanceSourceInput,
): TosConformanceSource {
  const explicitCommit = input.explicitCommit?.trim();
  if (explicitCommit && !isFullGitSha(explicitCommit)) {
    throw new Error('CONFORMANCE_SOURCE_COMMIT must be a full Git SHA');
  }
  if (input.gitCommit !== null) {
    if (!isFullGitSha(input.gitCommit)) {
      throw new Error('TOS conformance Git HEAD must be a full Git SHA');
    }
    if (input.gitStatus === null || input.gitStatus.trim()) {
      throw new Error('TOS conformance requires a clean worktree');
    }
    if (explicitCommit && explicitCommit !== input.gitCommit) {
      throw new Error('CONFORMANCE_SOURCE_COMMIT does not match Git HEAD');
    }
    return {
      commit: explicitCommit ?? input.gitCommit,
      commitOrigin: explicitCommit
        ? 'environment-verified-clean-worktree'
        : 'git-clean-worktree',
    };
  }
  if (!explicitCommit) {
    throw new Error(
      'TOS conformance requires CONFORMANCE_SOURCE_COMMIT when Git metadata is unavailable',
    );
  }
  return { commit: explicitCommit, commitOrigin: 'environment' };
}

export function buildTosConformanceRecord(
  evidence: TosConformanceEvidence,
  metadata: TosConformanceRecordMetadata,
): TosConformanceRecord {
  if (!isFullGitSha(metadata.sourceCommit)) {
    throw new Error('TOS conformance source commit must be a full Git SHA');
  }
  if (Number.isNaN(metadata.retrievedAt.getTime())) {
    throw new Error('TOS conformance retrieval time must be valid');
  }
  if (metadata.capabilities.length === 0) {
    throw new Error('TOS conformance record must name at least one capability');
  }
  return {
    schemaVersion: 1,
    evidenceId: `${metadata.provider}-${evidence.runId}`,
    source: {
      repository: metadata.sourceRepository,
      commit: metadata.sourceCommit,
      commitOrigin: metadata.sourceCommitOrigin,
    },
    adapter: {
      name: metadata.adapterName,
      sourcePath: metadata.adapterSourcePath,
      packageVersion: metadata.packageVersion,
    },
    toolchain: {
      runtime: metadata.runtime,
      transport: metadata.transport,
      apiVersion: metadata.apiVersion,
    },
    provider: metadata.provider,
    region: metadata.region,
    endpoint: metadata.endpoint,
    bucket: metadata.bucket,
    credentialBoundary: metadata.credentialBoundary,
    retrievedAt: metadata.retrievedAt.toISOString(),
    capabilities: [...metadata.capabilities],
    untestedSemantics: [...metadata.untestedSemantics],
    unsupportedSemantics: [...metadata.unsupportedSemantics],
    evidence,
  };
}

export async function runTosConformance(
  store: TosConformanceStore,
  dependencies: TosConformanceDependencies = {},
): Promise<TosConformanceEvidence> {
  try {
    return await executeTosConformance(store, dependencies);
  } catch (error) {
    if (error instanceof TosConformanceFailure) throw error;
    throw sanitizedFailure(error);
  }
}

async function executeTosConformance(
  store: TosConformanceStore,
  dependencies: TosConformanceDependencies,
): Promise<TosConformanceEvidence> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const runId = dependencies.runId ?? randomUUID();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(runId)) {
    throw new Error('TOS conformance run ID contains unsafe characters');
  }
  const payload = dependencies.payload ?? DEFAULT_PAYLOAD;
  const directKey = `_conformance/${runId}/direct.bin`;
  const presignedPutKey = `_conformance/${runId}/presigned-put.bin`;
  const keys = [directKey, presignedPutKey];

  const bucketExisted = await store.bucketExists();
  if (!bucketExisted) await store.createBucket();
  if (!await store.bucketExists()) throw new Error('TOS bucket HEAD failed after provisioning');

  let primaryError: unknown;
  try {
    await store.put(directKey, payload);
    assertPayload(await store.get(directKey), payload, 'direct PUT/GET');
    if (!await store.exists(directKey)) throw new Error('TOS direct object HEAD failed');

    const presignedGetUrl = await store.presignGet(directKey, PRESIGN_TTL_SECONDS);
    const presignedGet = await fetchPresigned(fetchImpl, presignedGetUrl, 'GET', {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!presignedGet.ok) {
      await presignedGet.body?.cancel();
      throw new TosConformanceFailure(
        `TOS presigned GET failed with HTTP ${presignedGet.status}`,
      );
    }
    assertPayload(
      await readExpectedPayload(presignedGet, payload.byteLength, 'presigned GET'),
      payload,
      'presigned GET',
    );

    const presignedPutUrl = await store.presignPut(presignedPutKey, PRESIGN_TTL_SECONDS);
    const presignedPut = await fetchPresigned(fetchImpl, presignedPutUrl, 'PUT', {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!presignedPut.ok) {
      await presignedPut.body?.cancel();
      throw new TosConformanceFailure(
        `TOS presigned PUT failed with HTTP ${presignedPut.status}`,
      );
    }
    await presignedPut.body?.cancel();
    assertPayload(await store.get(presignedPutKey), payload, 'presigned PUT/direct GET');
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new TosConformanceFailure(
      `TOS conformance cleanup failed for ${cleanupErrors.length} object(s)`,
    );
  }
  for (const key of keys) {
    if (await store.exists(key)) {
      throw new TosConformanceFailure('TOS cleanup left a conformance object behind');
    }
  }
  if (primaryError) throw primaryError;

  let notFound: ProviderErrorMetadata;
  try {
    await store.get(directKey);
    throw new TosConformanceFailure('TOS deleted object remained readable');
  } catch (error) {
    notFound = providerErrorMetadata(error);
    if (notFound.statusCode !== 404) throw error;
  }

  return {
    schemaVersion: 1,
    runId,
    controlPlane: {
      bucketExisted,
      bucketCreated: !bucketExisted,
      bucketHeadSucceeded: true,
    },
    dataPlane: {
      directPutGet: true,
      directHead: true,
      presignedGet: true,
      presignedPut: true,
    },
    failurePath: {
      operation: 'GET deleted object',
      statusCode: 404,
      code: notFound.code,
      requestId: notFound.requestId,
    },
    redaction: {
      credentialFieldsIncluded: false,
      payloadIncluded: false,
      presignedUrlsIncluded: false,
    },
    cleanup: {
      objectsDeleted: true,
      objectsVerifiedAbsent: keys.length,
      configuredBucketRetained: true,
    },
  };
}

function assertPayload(actual: Buffer, expected: Buffer, operation: string): void {
  if (!actual.equals(expected)) throw new Error(`TOS ${operation} payload mismatch`);
}

class TosConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TosConformanceFailure';
  }
}

interface ProviderErrorMetadata {
  statusCode: number | null;
  code: string;
  requestId: string | null;
}

function providerErrorMetadata(error: unknown): ProviderErrorMetadata {
  if (typeof error !== 'object' || error === null) {
    return { statusCode: null, code: 'Unknown', requestId: null };
  }
  const statusCode = 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : null;
  const code = 'code' in error && safeEvidenceToken(error.code)
    ? error.code
    : 'Unknown';
  const requestId = 'requestId' in error && safeEvidenceToken(error.requestId)
    ? error.requestId
    : null;
  return { statusCode, code, requestId };
}

function safeEvidenceToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

function isFullGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function sanitizedFailure(error: unknown): TosConformanceFailure {
  const metadata = providerErrorMetadata(error);
  const qualifiers = [
    metadata.statusCode === null ? null : `HTTP ${metadata.statusCode}`,
    metadata.code === 'Unknown' ? null : metadata.code,
    metadata.requestId ? `request ${metadata.requestId}` : null,
  ].filter((value): value is string => value !== null);
  return new TosConformanceFailure(
    `TOS conformance failed${qualifiers.length > 0 ? ` (${qualifiers.join(', ')})` : ''}`,
  );
}

async function fetchPresigned(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  operation: 'GET' | 'PUT',
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw new TosConformanceFailure(`TOS presigned ${operation} transport failed`);
  }
}

async function readExpectedPayload(
  response: Response,
  maximumBytes: number,
  operation: string,
): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel();
    throw new TosConformanceFailure(
      `TOS ${operation} exceeded expected payload size`,
    );
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new TosConformanceFailure(
        `TOS ${operation} exceeded expected payload size`,
      );
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, totalBytes);
}
