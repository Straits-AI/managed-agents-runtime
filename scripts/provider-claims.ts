import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const START = '<!-- byteplus-conformance-matrix:start -->';
const END = '<!-- byteplus-conformance-matrix:end -->';
const CLASSIFICATIONS = new Set(['verified', 'local-only', 'unavailable']);

interface EvidenceRecord {
  evidenceId: string;
  sourceCommit: string;
  region: string;
  retrievedAt: string;
  toolchain: string;
  recordPath: string;
  recordSha256: string;
  relatedRecords?: Array<{
    evidenceId: string;
    recordPath: string;
    recordSha256: string;
  }>;
  controlPlane: string[];
  dataPlane: string[];
  failure: string[];
  redaction: string[];
  cleanup: string[];
}

interface SurfaceRecord {
  id: string;
  capability: string;
  implementation: string;
  classification: string;
  sharedDeploymentClaim: string;
  evidence: EvidenceRecord[];
  limitations: string[];
}

interface Manifest {
  schemaVersion: number;
  provider: string;
  releaseCandidate: string;
  surfaces: SurfaceRecord[];
}

const safeCell = (value: string): string => {
  if (!value || value.includes('|') || value.includes('\n')) {
    throw new Error('provider claim contains an unsafe Markdown table value');
  }
  return value;
};

export function loadProviderManifest(
  path: string,
  options: { root?: string } = {},
): Manifest {
  const root = options.root ?? resolve(dirname(path), '..');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.provider !== 'byteplus') {
    throw new Error('unsupported BytePlus conformance manifest');
  }
  const packageMetadata = JSON.parse(
    readFileSync(resolve(root, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  if (manifest.releaseCandidate !== packageMetadata.version) {
    throw new Error('provider manifest release candidate does not match package.json');
  }
  const ids = new Set<string>();
  for (const surface of manifest.surfaces) {
    if (ids.has(surface.id)) throw new Error(`duplicate provider surface ${surface.id}`);
    ids.add(surface.id);
    if (!CLASSIFICATIONS.has(surface.classification)) {
      throw new Error(`invalid provider classification for ${surface.id}`);
    }
    safeCell(surface.capability);
    safeCell(surface.implementation);
    safeCell(surface.sharedDeploymentClaim);
    if (surface.classification === 'verified' && surface.evidence.length === 0) {
      throw new Error(`verified provider surface ${surface.id} lacks evidence`);
    }
    if (surface.classification !== 'verified' && surface.evidence.length !== 0) {
      throw new Error(`unverified provider surface ${surface.id} must not carry live evidence`);
    }
    for (const evidence of surface.evidence) {
      if (!/^[0-9a-f]{40}$/.test(evidence.sourceCommit)
        || !/^[0-9a-f]{64}$/.test(evidence.recordSha256)
        || Number.isNaN(Date.parse(evidence.retrievedAt))) {
        throw new Error(`invalid evidence provenance for ${surface.id}`);
      }
      assertEvidenceReceipt(root, surface.id, evidence);
      for (const dimension of ['controlPlane', 'dataPlane', 'failure', 'redaction', 'cleanup'] as const) {
        if (evidence[dimension].length === 0) {
          throw new Error(`provider evidence ${surface.id} lacks ${dimension}`);
        }
      }
    }
  }
  return manifest;
}

function assertEvidenceReceipt(
  root: string,
  surfaceId: string,
  evidence: EvidenceRecord,
): void {
  assertReceipt(root, surfaceId, {
    evidenceId: evidence.evidenceId,
    recordPath: evidence.recordPath,
    recordSha256: evidence.recordSha256,
  }, {
    sourceCommit: evidence.sourceCommit,
    region: evidence.region,
    retrievedAt: evidence.retrievedAt,
  });
  for (const related of evidence.relatedRecords ?? []) {
    assertReceipt(root, surfaceId, related, {
      sourceCommit: evidence.sourceCommit,
      region: evidence.region,
    });
  }
}

function assertReceipt(
  root: string,
  surfaceId: string,
  receiptReference: { evidenceId: string; recordPath: string; recordSha256: string },
  expected: { sourceCommit: string; region: string; retrievedAt?: string },
): void {
  if (!/^provider-conformance\/evidence\/[A-Za-z0-9._-]+\.json$/.test(
    receiptReference.recordPath,
  ) || !/^[0-9a-f]{64}$/.test(receiptReference.recordSha256)) {
    throw new Error(`invalid provider evidence receipt reference for ${surfaceId}`);
  }
  const absolute = resolve(root, receiptReference.recordPath);
  if (relative(root, absolute).startsWith('..')) {
    throw new Error(`provider evidence receipt escaped repository root for ${surfaceId}`);
  }
  const serialized = readFileSync(absolute);
  const actualSha = createHash('sha256').update(serialized).digest('hex');
  if (actualSha !== receiptReference.recordSha256) {
    throw new Error(`provider evidence receipt hash mismatch for ${surfaceId}`);
  }
  const receipt = JSON.parse(serialized.toString('utf8')) as {
    evidenceId?: unknown;
    source?: {
      commit?: unknown;
      unchangedFiles?: Array<{ path?: unknown; sha256?: unknown }>;
    };
    provider?: unknown;
    region?: unknown;
    retrievedAt?: unknown;
  };
  if (receipt.evidenceId !== receiptReference.evidenceId
    || receipt.source?.commit !== expected.sourceCommit
    || receipt.region !== expected.region
    || (expected.retrievedAt !== undefined && receipt.retrievedAt !== expected.retrievedAt)
    || typeof receipt.provider !== 'string') {
    throw new Error(`provider evidence receipt metadata mismatch for ${surfaceId}`);
  }
  for (const file of receipt.source?.unchangedFiles ?? []) {
    if (typeof file.path !== 'string'
      || !/^[0-9a-f]{64}$/.test(typeof file.sha256 === 'string' ? file.sha256 : '')) {
      throw new Error(`provider evidence continuity metadata is invalid for ${surfaceId}`);
    }
    const sourcePath = resolve(root, file.path);
    if (relative(root, sourcePath).startsWith('..')) {
      throw new Error(`provider evidence continuity path escaped repository root for ${surfaceId}`);
    }
    const currentSha = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
    if (currentSha !== file.sha256) {
      throw new Error(`provider evidence source continuity failed for ${surfaceId}`);
    }
  }
}

export function renderProviderMatrix(manifest: Manifest): string {
  const rows = manifest.surfaces.map((surface) => {
    const evidence = surface.evidence.length === 0
      ? 'No release-current live record'
      : surface.evidence.map((record) => `${record.evidenceId} at \`${record.sourceCommit.slice(0, 12)}\``).join('; ');
    return `| ${safeCell(surface.capability)} | \`${surface.classification}\` | ${safeCell(evidence)} | ${safeCell(surface.sharedDeploymentClaim)} |`;
  });
  return [
    '| Capability | Classification | Current evidence | Shared-deployment claim |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export function assertProviderMatrix(document: string, expected: string, name: string): void {
  const start = document.indexOf(START);
  const end = document.indexOf(END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`${name} has no BytePlus conformance matrix markers`);
  }
  const actual = document.slice(start + START.length, end).trim();
  if (actual !== expected.trim()) {
    throw new Error(`${name} BytePlus claims do not match the versioned conformance manifest`);
  }
}

export function assertNoUnversionedProviderClaims(document: string, name: string): void {
  const blanketPatterns = [
    /Every BytePlus resource[\s\S]{0,320}(?:provisioned|verified)[\s\S]{0,120}(?:live|operating contract)/i,
    /adapter proven live/i,
  ];
  if (blanketPatterns.some((pattern) => pattern.test(document))) {
    throw new Error(`${name} contains an unversioned blanket BytePlus claim`);
  }
}

export const providerMatrixMarkers = { start: START, end: END } as const;
