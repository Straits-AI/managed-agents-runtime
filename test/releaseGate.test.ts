import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_ALPHA_MINIMUM_TEST_COUNT,
  evaluateReleaseGate,
  parseReleaseGateManifest,
  releaseGateManifestSha256,
  type ReleaseGateManifest,
  validateReleaseSource,
} from '../src/releaseGate.js';

function reportFor(manifest: ReleaseGateManifest, status = 'passed') {
  const byFile = new Map<string, { fullName: string; status: string }[]>();
  for (const assertion of manifest.criticalAssertions) {
    const assertions = byFile.get(assertion.file) ?? [];
    assertions.push({ fullName: assertion.fullName, status });
    byFile.set(assertion.file, assertions);
  }
  const testResults = [...byFile].map(([file, assertionResults]) => ({
    name: `/checkout/${file}`,
    assertionResults,
  }));
  const minimumTests = CONTROLLED_ALPHA_MINIMUM_TEST_COUNT;
  const fillerCount = minimumTests - manifest.criticalAssertions.length;
  if (fillerCount > 0) {
    testResults.push({
      name: '/checkout/test/nonCriticalRegression.test.ts',
      assertionResults: Array.from({ length: fillerCount }, (_, index) => ({
        fullName: `non-critical regression ${index + 1}`,
        status,
      })),
    });
  }
  const totalTests = testResults.reduce(
    (total, result) => total + result.assertionResults.length,
    0,
  );
  return {
    success: status === 'passed',
    numTotalTests: totalTests,
    numPassedTests: status === 'passed' ? totalTests : 0,
    numFailedTests: status === 'passed' ? 0 : totalTests,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults,
  };
}

describe('controlled multi-tenant release gate contract', () => {
  const manifestSource = readFileSync(
    join(process.cwd(), 'release-gate', 'controlled-multitenant-alpha.v1.json'),
    'utf8',
  );
  const manifestSha256 = releaseGateManifestSha256(manifestSource);
  const manifest = parseReleaseGateManifest(JSON.parse(manifestSource) as unknown);

  it('maps every required P0 risk, dimension, and provider guard to passing evidence', () => {
    const evaluation = evaluateReleaseGate(manifest, reportFor(manifest), manifestSha256);
    expect(evaluation.errors).toEqual([]);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.criticalAssertions.every((assertion) => assertion.status === 'passed'))
      .toBe(true);
  });

  it('fails when a named critical assertion disappears from an otherwise green suite', () => {
    const report = reportFor(manifest);
    const firstFile = report.testResults[0]!;
    firstFile.assertionResults = firstFile.assertionResults.slice(1);
    const evaluation = evaluateReleaseGate(manifest, report, manifestSha256);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.errors).toContain(
      `critical assertion ${manifest.criticalAssertions[0]!.id} is missing`,
    );
  });

  it('fails malformed manifests and provider surfaces without an executable guard', () => {
    expect(() => parseReleaseGateManifest({ schemaVersion: 1 })).toThrow(/malformed/);
    const invalid = structuredClone(manifest);
    invalid.providerSurfaces[0]!.guardAssertionId = 'missing-guard';
    const evaluation = evaluateReleaseGate(invalid, reportFor(invalid), manifestSha256);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.errors).toContain(
      `provider surface ${invalid.providerSurfaces[0]!.id} has no guard assertion`,
    );
  });

  it('rejects a reduced self-attesting manifest even when its listed test passes', () => {
    const reduced = structuredClone(manifest);
    reduced.criticalAssertions = [reduced.criticalAssertions[0]!];
    reduced.criticalAssertions[0]!.riskIds = [...reduced.requiredRiskIds];
    reduced.criticalAssertions[0]!.dimensions = [...reduced.requiredDimensions];
    for (const surface of reduced.providerSurfaces) {
      surface.guardAssertionId = reduced.criticalAssertions[0]!.id;
    }
    const evaluation = evaluateReleaseGate(
      reduced,
      reportFor(reduced),
      releaseGateManifestSha256(JSON.stringify(reduced)),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.errors).toContain(
      'release gate manifest does not match the reviewed v1 baseline',
    );
    expect(evaluation.errors).toContain(
      'release gate manifest must contain 30 critical assertions',
    );
  });

  it('rejects pending or skipped coverage in an otherwise successful report', () => {
    const report = reportFor(manifest);
    report.numPassedTests -= 1;
    report.numPendingTests = 1;
    report.testResults.at(-1)!.assertionResults.at(-1)!.status = 'pending';
    const evaluation = evaluateReleaseGate(manifest, report, manifestSha256);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.errors).toContain(
      'full suite contains failed, pending, skipped, or todo tests',
    );
  });

  it('fails closed when Git identity or cleanliness cannot be inspected', () => {
    expect(validateReleaseSource({
      commit: 'a'.repeat(40),
      detectedCommit: null,
      assertedCommit: 'a'.repeat(40),
      workingTreeDirty: null,
    }, false)).toEqual([
      'the checked-out Git revision could not be inspected',
      'source cleanliness could not be inspected',
    ]);
  });

  it('rejects dirty release evidence and an asserted commit that differs from HEAD', () => {
    expect(validateReleaseSource({
      commit: 'b'.repeat(40),
      detectedCommit: 'a'.repeat(40),
      assertedCommit: 'b'.repeat(40),
      workingTreeDirty: true,
    }, false)).toEqual([
      'source changes are present; commit them or use --allow-dirty for a non-release dry run',
      'RELEASE_GATE_COMMIT does not match the checked-out source revision',
    ]);
  });
});
