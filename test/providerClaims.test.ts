import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertProviderMatrix,
  assertNoUnversionedProviderClaims,
  loadProviderManifest,
  renderProviderMatrix,
} from '../scripts/provider-claims.js';

const root = resolve(import.meta.dirname, '..');
const manifest = loadProviderManifest(resolve(root, 'provider-conformance/byteplus.v1.json'));

describe('versioned BytePlus provider claims', () => {
  it('retains complete provenance and five-plane evidence for every verified surface', () => {
    expect(manifest.surfaces.filter((surface) => surface.classification === 'verified').map((surface) => surface.id)).toEqual([
      'tos',
      'modelark',
      'vefaas-private-sandbox',
    ]);
  });

  it.each(['README.md', 'docs/BYTEPLUS-PROVIDER-CONFORMANCE.md'])(
    'checks %s against the conformance manifest',
    (relative) => {
      expect(() => assertProviderMatrix(
        readFileSync(resolve(root, relative), 'utf8'),
        renderProviderMatrix(manifest),
        relative,
      )).not.toThrow();
    },
  );

  it.each(['README.md', 'docs/GUIDE.md'])(
    'rejects unversioned blanket provider claims in %s',
    (relative) => {
      expect(() => assertNoUnversionedProviderClaims(
        readFileSync(resolve(root, relative), 'utf8'),
        relative,
      )).not.toThrow();
    },
  );

  it('binds the manifest release candidate to package.json', () => {
    const fixture = createFixture({ releaseCandidate: '9.9.9' });
    expect(() => loadProviderManifest(fixture.manifestPath, { root: fixture.root }))
      .toThrow('provider manifest release candidate does not match package.json');
  });

  it('verifies retained evidence bytes instead of trusting a hash-shaped claim', () => {
    const fixture = createFixture({ recordSha256: '0'.repeat(64) });
    expect(() => loadProviderManifest(fixture.manifestPath, { root: fixture.root }))
      .toThrow('provider evidence receipt hash mismatch');
  });

  it('rejects claim-bearing blanket prose outside the generated matrix', () => {
    expect(() => assertNoUnversionedProviderClaims(
      'Every BytePlus resource in this project was provisioned and verified live.',
      'fixture.md',
    )).toThrow('fixture.md contains an unversioned blanket BytePlus claim');
  });
});

function createFixture(overrides: { releaseCandidate?: string; recordSha256?: string }) {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'provider-claims-'));
  const evidencePath = 'provider-conformance/evidence/fixture.json';
  const record = {
    schemaVersion: 1,
    evidenceId: 'fixture-evidence',
    source: { commit: '1'.repeat(40), unchangedFiles: [] },
    provider: 'byteplus-fixture',
    region: 'ap-southeast-1',
    retrievedAt: '2026-07-22T00:00:00.000Z',
  };
  const serialized = `${JSON.stringify(record)}\n`;
  writeFileSync(resolve(fixtureRoot, 'package.json'), '{"version":"0.1.0"}\n');
  mkdirSync(resolve(fixtureRoot, 'provider-conformance/evidence'), { recursive: true });
  writeFileSync(resolve(fixtureRoot, evidencePath), serialized);
  const manifest = {
    schemaVersion: 1,
    provider: 'byteplus',
    releaseCandidate: overrides.releaseCandidate ?? '0.1.0',
    surfaces: [{
      id: 'fixture',
      capability: 'Fixture capability',
      implementation: 'Fixture implementation',
      classification: 'verified',
      sharedDeploymentClaim: 'Fixture only',
      evidence: [{
        evidenceId: record.evidenceId,
        sourceCommit: record.source.commit,
        region: record.region,
        retrievedAt: record.retrievedAt,
        toolchain: 'fixture',
        recordPath: evidencePath,
        recordSha256: overrides.recordSha256
          ?? createHash('sha256').update(serialized).digest('hex'),
        controlPlane: ['fixture'],
        dataPlane: ['fixture'],
        failure: ['fixture'],
        redaction: ['fixture'],
        cleanup: ['fixture'],
      }],
      limitations: [],
    }],
  };
  const manifestPath = resolve(fixtureRoot, 'provider-conformance.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { root: fixtureRoot, manifestPath };
}
