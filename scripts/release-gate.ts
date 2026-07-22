import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateReleaseGate,
  parseReleaseGateManifest,
  releaseGateManifestSha256,
  type ReleaseGateEvaluation,
  validateReleaseGateManifestBaseline,
  validateReleaseSource,
} from '../src/releaseGate.js';
import {
  dependencyAuditExceptionsSha256,
  evaluateDependencyAudit,
  parseDependencyAuditExceptions,
  type DependencyAuditEvaluation,
} from '../src/dependencyAudit.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'release-gate', 'controlled-multitenant-alpha.v1.json');
const dependencyExceptionsPath = join(
  root,
  'release-gate',
  'dependency-audit-exceptions.v1.json',
);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function timestampPath(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

const evidenceDir = resolve(
  root,
  argument('--evidence-dir') ?? join('release-evidence', timestampPath()),
);
const allowDirty = process.argv.includes('--allow-dirty');
mkdirSync(evidenceDir, { recursive: true });

interface StepResult {
  name: string;
  command: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

function runStep(name: string, command: string, args: string[]): StepResult {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: root,
    env: childEnvironment(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = redactEvidence(result.stdout ?? '');
  const stderr = redactEvidence(
    [result.stderr ?? '', result.error?.message ?? ''].filter(Boolean).join('\n'),
  );
  writeFileSync(join(evidenceDir, `${name}.stdout.log`), stdout);
  writeFileSync(join(evidenceDir, `${name}.stderr.log`), stderr);
  return {
    name,
    command: [command, ...args],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    stdout: `${name}.stdout.log`,
    stderr: `${name}.stderr.log`,
  };
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CI: process.env.CI ?? '1',
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    NO_COLOR: '1',
  };
  for (const key of [
    'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR',
    'TEST_DATABASE_URL',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function redactEvidence(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^@\s"']+@/gi, 'postgres://[REDACTED]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)[^\s"',;]+/gi,
      '$1[REDACTED]',
    );
}

function sanitizeJson(value: unknown): unknown {
  if (typeof value === 'string') return redactEvidence(value);
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sanitizeJson(nested)]),
    );
  }
  return value;
}

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function sha256(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const startedAt = new Date().toISOString();
const workingTreeStatus = gitOutput(['status', '--porcelain']);
const detectedCommit = gitOutput(['rev-parse', 'HEAD']);
const assertedCommit = process.env.RELEASE_GATE_COMMIT?.trim() || null;
const source = {
  commit: assertedCommit ?? detectedCommit,
  detectedCommit,
  assertedCommit,
  branch: gitOutput(['branch', '--show-current']),
  workingTreeDirty: workingTreeStatus === null ? null : workingTreeStatus.length > 0,
};

function failInitialization(messages: string[]): never {
  const summary = {
    schemaVersion: 1,
    gateId: 'controlled-multitenant-alpha-v1',
    status: 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    source,
    steps: [],
    evaluation: null,
    errors: messages,
    artifacts: {},
  };
  writeFileSync(join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write('FAIL controlled-multitenant-alpha-v1\n');
  for (const message of messages) process.stderr.write(`- ${message}\n`);
  process.stderr.write(`Evidence: ${evidenceDir}\n`);
  process.exit(1);
}

const sourceErrors = validateReleaseSource(source, allowDirty);
if (sourceErrors.length > 0) failInitialization(sourceErrors);

let manifestSource: string;
let manifest;
let dependencyExceptionsSource: string;
let dependencyExceptions;
try {
  manifestSource = readFileSync(manifestPath, 'utf8');
  manifest = parseReleaseGateManifest(JSON.parse(manifestSource) as unknown);
  dependencyExceptionsSource = readFileSync(dependencyExceptionsPath, 'utf8');
  dependencyExceptions = parseDependencyAuditExceptions(
    JSON.parse(dependencyExceptionsSource) as unknown,
  );
} catch (error) {
  failInitialization([
    `release gate policy could not be loaded: ${error instanceof Error ? error.message : 'unknown error'}`,
  ]);
}
const manifestSha256 = releaseGateManifestSha256(manifestSource);
const manifestErrors = validateReleaseGateManifestBaseline(manifest, manifestSha256);
if (manifestErrors.length > 0) failInitialization(manifestErrors);
writeFileSync(
  join(evidenceDir, 'manifest.snapshot.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
writeFileSync(
  join(evidenceDir, 'dependency-audit-exceptions.snapshot.json'),
  `${JSON.stringify(dependencyExceptions, null, 2)}\n`,
);

const dependencyAudit = runStep(
  'dependency-audit',
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['audit', '--omit=dev', '--audit-level=high', '--json'],
);
const providerPortability = runStep(
  'provider-portability',
  join(root, 'node_modules', '.bin', 'tsx'),
  ['scripts/check-provider-portability.ts'],
);
const kertasClientBoundary = runStep(
  'kertas-client-boundary',
  join(root, 'node_modules', '.bin', 'tsx'),
  ['scripts/check-kertas-client-boundary.ts'],
);
const typecheck = runStep('typecheck', join(root, 'node_modules', '.bin', 'tsc'), ['--noEmit']);
const vitestPath = join(evidenceDir, 'vitest.json');
const vitestRawPath = join(
  tmpdir(),
  `managed-agents-release-vitest-${process.pid}-${Date.now()}.json`,
);
const tests = runStep('vitest', join(root, 'node_modules', '.bin', 'vitest'), [
  'run',
  '--reporter=json',
  `--outputFile=${vitestRawPath}`,
]);

let evaluation: ReleaseGateEvaluation | null = null;
let dependencyEvaluation: DependencyAuditEvaluation | null = null;
const errors: string[] = [];
try {
  const auditReport = sanitizeJson(
    JSON.parse(readFileSync(join(evidenceDir, dependencyAudit.stdout), 'utf8')) as unknown,
  );
  writeFileSync(
    join(evidenceDir, 'dependency-audit.json'),
    `${JSON.stringify(auditReport)}\n`,
  );
  dependencyEvaluation = evaluateDependencyAudit(
    auditReport,
    dependencyExceptions,
    dependencyAuditExceptionsSha256(dependencyExceptionsSource),
    new Date(),
    dependencyAudit.exitCode,
  );
  errors.push(...dependencyEvaluation.errors);
} catch (error) {
  errors.push(
    `could not evaluate dependency audit evidence: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
}
if (providerPortability.exitCode !== 0) errors.push('provider portability failed');
if (kertasClientBoundary.exitCode !== 0) errors.push('Kertas client boundary failed');
if (typecheck.exitCode !== 0) errors.push('typecheck failed');
if (tests.exitCode !== 0) errors.push('Vitest failed');
if (!existsSync(vitestRawPath)) {
  errors.push('Vitest did not produce machine-readable evidence');
} else {
  try {
    const sanitizedReport = sanitizeJson(
      JSON.parse(readFileSync(vitestRawPath, 'utf8')) as unknown,
    );
    writeFileSync(vitestPath, `${JSON.stringify(sanitizedReport)}\n`);
    evaluation = evaluateReleaseGate(
      manifest,
      sanitizedReport,
      manifestSha256,
    );
    errors.push(...evaluation.errors);
  } catch (error) {
    errors.push(`could not evaluate Vitest evidence: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    rmSync(vitestRawPath, { force: true });
  }
}

const status = errors.length > 0
  ? 'failed'
  : allowDirty
    ? 'dry-run-passed'
    : 'passed';
const summary = {
  schemaVersion: 1,
  gateId: manifest.gateId,
  status,
  startedAt,
  finishedAt: new Date().toISOString(),
  source,
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    databaseTarget: process.env.TEST_DATABASE_URL ? 'TEST_DATABASE_URL' : 'local-default',
  },
  steps: [dependencyAudit, providerPortability, kertasClientBoundary, typecheck, tests],
  dependencyEvaluation,
  evaluation,
  providerSurfaces: manifest.providerSurfaces,
  limitations: manifest.limitations,
  errors,
  artifacts: {
    manifest: {
      path: 'manifest.snapshot.json',
      sha256: sha256(join(evidenceDir, 'manifest.snapshot.json')),
    },
    dependencyAuditExceptions: {
      path: 'dependency-audit-exceptions.snapshot.json',
      sha256: sha256(join(evidenceDir, 'dependency-audit-exceptions.snapshot.json')),
    },
    dependencyAudit: {
      path: 'dependency-audit.json',
      sha256: sha256(join(evidenceDir, 'dependency-audit.json')),
    },
    vitest: {
      path: 'vitest.json',
      sha256: sha256(vitestPath),
    },
  },
};
writeFileSync(join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const label = summary.status === 'passed'
  ? 'PASS'
  : summary.status === 'dry-run-passed'
    ? 'DRY-RUN PASS'
    : 'FAIL';
process.stdout.write(`${label} ${manifest.gateId}\nEvidence: ${evidenceDir}\n`);
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
}
