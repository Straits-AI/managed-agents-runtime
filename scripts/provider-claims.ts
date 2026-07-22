import { readFileSync } from 'node:fs';

const START = '<!-- byteplus-conformance-matrix:start -->';
const END = '<!-- byteplus-conformance-matrix:end -->';
const CLASSIFICATIONS = new Set(['verified', 'historical-only', 'local-only', 'unavailable']);

interface EvidenceRecord {
  evidenceId: string;
  sourceCommit: string;
  region: string;
  retrievedAt: string;
  toolchain: string;
  recordSha256: string;
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

export function loadProviderManifest(path: string): Manifest {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.provider !== 'byteplus') {
    throw new Error('unsupported BytePlus conformance manifest');
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
      for (const dimension of ['controlPlane', 'dataPlane', 'failure', 'redaction', 'cleanup'] as const) {
        if (evidence[dimension].length === 0) {
          throw new Error(`provider evidence ${surface.id} lacks ${dimension}`);
        }
      }
    }
  }
  return manifest;
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

export const providerMatrixMarkers = { start: START, end: END } as const;
