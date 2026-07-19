import { createHash } from 'node:crypto';

export const CONTROLLED_ALPHA_GATE_ID = 'controlled-multitenant-alpha-v1';
export const CONTROLLED_ALPHA_MANIFEST_SHA256 =
  '58585c84eea1afeeabbe9bfd7f0d8609b442cb0d49ed7e3ba87d50fc131d24c6';
export const CONTROLLED_ALPHA_ASSERTION_COUNT = 30;
export const CONTROLLED_ALPHA_MINIMUM_TEST_COUNT = 286;

export interface ReleaseGateAssertion {
  id: string;
  riskIds: string[];
  dimensions: string[];
  file: string;
  fullName: string;
}

export interface ReleaseGateManifest {
  schemaVersion: number;
  gateId: string;
  requiredRiskIds: string[];
  requiredDimensions: string[];
  providerSurfaces: {
    id: string;
    sharedMode: string;
    guardAssertionId: string;
  }[];
  limitations: string[];
  criticalAssertions: ReleaseGateAssertion[];
}

interface VitestAssertion {
  fullName?: unknown;
  status?: unknown;
}

interface VitestTestResult {
  name?: unknown;
  assertionResults?: unknown;
}

interface VitestReport {
  success?: unknown;
  testResults?: unknown;
  numTotalTests?: unknown;
  numPassedTests?: unknown;
  numFailedTests?: unknown;
  numPendingTests?: unknown;
  numTodoTests?: unknown;
}

export interface CriticalAssertionResult extends ReleaseGateAssertion {
  status: 'passed' | 'failed' | 'missing';
}

export interface ReleaseGateEvaluation {
  passed: boolean;
  errors: string[];
  criticalAssertions: CriticalAssertionResult[];
  vitest: {
    success: boolean;
    total: number | null;
    passed: number | null;
    failed: number | null;
  };
}

export interface ReleaseSourceIdentity {
  commit: string | null;
  detectedCommit: string | null;
  assertedCommit: string | null;
  workingTreeDirty: boolean | null;
}

export function validateReleaseSource(
  source: ReleaseSourceIdentity,
  allowDirty: boolean,
): string[] {
  const errors: string[] = [];
  if (!source.detectedCommit) {
    errors.push('the checked-out Git revision could not be inspected');
  }
  if (source.workingTreeDirty === null) {
    errors.push('source cleanliness could not be inspected');
  } else if (source.workingTreeDirty && !allowDirty) {
    errors.push(
      'source changes are present; commit them or use --allow-dirty for a non-release dry run',
    );
  }
  if (!source.commit) {
    errors.push('source commit is unavailable');
  } else if (!/^[0-9a-f]{40,64}$/i.test(source.commit)) {
    errors.push('source commit is not a full hexadecimal object id');
  }
  if (
    source.assertedCommit && source.detectedCommit &&
    source.assertedCommit !== source.detectedCommit
  ) {
    errors.push('RELEASE_GATE_COMMIT does not match the checked-out source revision');
  }
  return errors;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function parseReleaseGateManifest(value: unknown): ReleaseGateManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('release gate manifest must be an object');
  }
  const input = value as Partial<ReleaseGateManifest>;
  if (
    input.schemaVersion !== 1 ||
    typeof input.gateId !== 'string' ||
    !isStringArray(input.requiredRiskIds) ||
    !isStringArray(input.requiredDimensions) ||
    !Array.isArray(input.providerSurfaces) ||
    !isStringArray(input.limitations) ||
    !Array.isArray(input.criticalAssertions)
  ) {
    throw new Error('release gate manifest is malformed');
  }
  const criticalAssertions = input.criticalAssertions.map((candidate) => {
    if (
      !candidate || typeof candidate !== 'object' ||
      typeof candidate.id !== 'string' ||
      !isStringArray(candidate.riskIds) ||
      !isStringArray(candidate.dimensions) ||
      typeof candidate.file !== 'string' ||
      typeof candidate.fullName !== 'string'
    ) {
      throw new Error('release gate critical assertion is malformed');
    }
    return candidate;
  });
  const providerSurfaces = input.providerSurfaces.map((candidate) => {
    if (
      !candidate || typeof candidate !== 'object' ||
      typeof candidate.id !== 'string' ||
      typeof candidate.sharedMode !== 'string' ||
      typeof candidate.guardAssertionId !== 'string'
    ) {
      throw new Error('release gate provider surface is malformed');
    }
    return candidate;
  });
  return { ...input, criticalAssertions, providerSurfaces } as ReleaseGateManifest;
}

function reportAssertions(report: VitestReport): Map<string, Map<string, string>> {
  const byFile = new Map<string, Map<string, string>>();
  if (!Array.isArray(report.testResults)) return byFile;
  for (const rawResult of report.testResults) {
    const result = rawResult as VitestTestResult;
    if (typeof result.name !== 'string' || !Array.isArray(result.assertionResults)) continue;
    const normalizedFile = result.name.replaceAll('\\', '/');
    const assertions = new Map<string, string>();
    for (const rawAssertion of result.assertionResults) {
      const assertion = rawAssertion as VitestAssertion;
      if (typeof assertion.fullName === 'string' && typeof assertion.status === 'string') {
        assertions.set(assertion.fullName, assertion.status);
      }
    }
    byFile.set(normalizedFile, assertions);
  }
  return byFile;
}

function reportAssertionCount(report: VitestReport): number {
  if (!Array.isArray(report.testResults)) return 0;
  return report.testResults.reduce((total, rawResult) => {
    const result = rawResult as VitestTestResult;
    return total + (Array.isArray(result.assertionResults) ? result.assertionResults.length : 0);
  }, 0);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function evaluateReleaseGate(
  manifest: ReleaseGateManifest,
  rawReport: unknown,
  manifestSha256: string,
): ReleaseGateEvaluation {
  const report = rawReport && typeof rawReport === 'object'
    ? rawReport as VitestReport
    : {};
  const errors = validateReleaseGateManifestBaseline(manifest, manifestSha256);
  if (report.success !== true) errors.push('the full Vitest suite did not pass');
  const totalTests = numberOrNull(report.numTotalTests);
  const passedTests = numberOrNull(report.numPassedTests);
  const failedTests = numberOrNull(report.numFailedTests);
  const pendingTests = numberOrNull(report.numPendingTests);
  const todoTests = numberOrNull(report.numTodoTests);
  if (totalTests === null || totalTests < CONTROLLED_ALPHA_MINIMUM_TEST_COUNT) {
    errors.push(
      `full suite must retain at least ${CONTROLLED_ALPHA_MINIMUM_TEST_COUNT} tests`,
    );
  }
  if (totalTests !== reportAssertionCount(report)) {
    errors.push('reported test total does not match emitted assertion evidence');
  }
  if (
    totalTests === null || passedTests !== totalTests || failedTests !== 0 ||
    pendingTests !== 0 || todoTests !== 0
  ) {
    errors.push('full suite contains failed, pending, skipped, or todo tests');
  }

  const ids = new Set<string>();
  const risks = new Set<string>();
  const dimensions = new Set<string>();
  for (const assertion of manifest.criticalAssertions) {
    if (ids.has(assertion.id)) errors.push(`duplicate assertion id: ${assertion.id}`);
    ids.add(assertion.id);
    assertion.riskIds.forEach((risk) => risks.add(risk));
    assertion.dimensions.forEach((dimension) => dimensions.add(dimension));
  }
  for (const risk of manifest.requiredRiskIds) {
    if (!risks.has(risk)) errors.push(`required risk has no critical assertion: ${risk}`);
  }
  for (const dimension of manifest.requiredDimensions) {
    if (!dimensions.has(dimension)) {
      errors.push(`required dimension has no critical assertion: ${dimension}`);
    }
  }
  for (const surface of manifest.providerSurfaces) {
    if (!ids.has(surface.guardAssertionId)) {
      errors.push(`provider surface ${surface.id} has no guard assertion`);
    }
  }

  const byFile = reportAssertions(report);
  const criticalAssertions = manifest.criticalAssertions.map((assertion) => {
    const file = [...byFile.keys()].find((candidate) => candidate.endsWith(`/${assertion.file}`));
    const status = file ? byFile.get(file)?.get(assertion.fullName) : undefined;
    const normalizedStatus: CriticalAssertionResult['status'] =
      status === 'passed' ? 'passed' : status ? 'failed' : 'missing';
    if (normalizedStatus !== 'passed') {
      errors.push(`critical assertion ${assertion.id} is ${normalizedStatus}`);
    }
    return { ...assertion, status: normalizedStatus };
  });

  return {
    passed: errors.length === 0,
    errors,
    criticalAssertions,
    vitest: {
      success: report.success === true,
      total: totalTests,
      passed: passedTests,
      failed: failedTests,
    },
  };
}

export function validateReleaseGateManifestBaseline(
  manifest: ReleaseGateManifest,
  manifestSha256: string,
): string[] {
  const errors: string[] = [];
  if (manifest.gateId !== CONTROLLED_ALPHA_GATE_ID) {
    errors.push(`unexpected release gate id: ${manifest.gateId}`);
  }
  if (manifestSha256 !== CONTROLLED_ALPHA_MANIFEST_SHA256) {
    errors.push('release gate manifest does not match the reviewed v1 baseline');
  }
  if (manifest.criticalAssertions.length !== CONTROLLED_ALPHA_ASSERTION_COUNT) {
    errors.push(
      `release gate manifest must contain ${CONTROLLED_ALPHA_ASSERTION_COUNT} critical assertions`,
    );
  }
  return errors;
}

export function releaseGateManifestSha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}
