import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BpPrivateSandboxConformanceProvider } from '../src/providers/byteplus/bpPrivateSandboxConformance.js';
import { runSandboxConformance } from '../src/providers/sandboxConformance.js';
import { resolveTosConformanceSource } from '../src/providers/tosConformance.js';

const option = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};

const profile = option('--profile');
const region = option('--region');
const functionId = option('--function-id');
const runId = option('--run-id');
const evidenceFile = option('--evidence-file');
const timeoutMinutes = 10;

const bpVersion = execFileSync('bp', ['version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
if (!/^[A-Za-z0-9._-]{1,80}$/.test(bpVersion)) {
  throw new Error('Sandbox conformance bp version was invalid');
}

const readGit = (args: string[]): string | null => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

const gitCommit = readGit(['rev-parse', 'HEAD']);
const source = resolveTosConformanceSource({
  explicitCommit: process.env.CONFORMANCE_SOURCE_COMMIT?.trim(),
  gitCommit,
  gitStatus: gitCommit === null ? null : readGit(['status', '--porcelain']),
});

const provider = new BpPrivateSandboxConformanceProvider({
  functionId,
  profile,
  region,
});
const marker = `marker-${randomUUID()}`;
const evidence = await runSandboxConformance(provider, {
  runId,
  timeoutMinutes,
  marker,
});
const instance = provider.instanceEvidence();
if (!instance) throw new Error('Sandbox conformance instance evidence is unavailable');

const sourceAfter = readGit(['rev-parse', 'HEAD']);
if (sourceAfter !== source.commit || readGit(['status', '--porcelain'])) {
  throw new Error('Sandbox conformance source revision changed during the live run');
}

const record = {
  schemaVersion: 1,
  evidenceId: `byteplus-sandbox-${runId}`,
  source: {
    repository: 'https://github.com/Straits-AI/managed-agents-runtime',
    commit: source.commit,
    commitOrigin: source.commitOrigin,
  },
  provider: 'byteplus-vefaas-private-sandbox',
  region,
  retrievedAt: new Date().toISOString(),
  toolchain: {
    runtime: `node ${process.version}`,
    bpVersion,
    controlPlane: 'bp vefaas',
    controlPlaneApiVersion: '2024-06-06',
    dataPlane: 'private-webshell-tested-live-revalidate',
    maximumLifetimeMinutes: timeoutMinutes,
  },
  providerRequestIds: provider.requestIds(),
  instance,
  evidence,
};

writeFileSync(resolve(evidenceFile), `${JSON.stringify(record, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
