import { execFileSync } from 'node:child_process';
import { createBpProvisioningApi } from '../src/providers/byteplus/bpProvisioningApi.js';
import { reserveEvidenceRecord } from '../src/providers/byteplus/provisioningEvidence.js';
import { deletePrivateSandboxApplication } from '../src/providers/byteplus/sandboxApplication.js';
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
const name = option('--name');
const evidenceFile = option('--evidence-file');
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
const baseRecord = {
  schemaVersion: 1,
  evidenceId: `byteplus-sandbox-cleanup-${name}`,
  source: {
    repository: 'https://github.com/Straits-AI/managed-agents-runtime',
    commit: source.commit,
    commitOrigin: source.commitOrigin,
  },
  provider: 'byteplus-vefaas',
  region,
  retrievedAt: new Date().toISOString(),
};
const evidence = reserveEvidenceRecord(evidenceFile, {
  ...baseRecord,
  status: 'pending',
  cleanup: { functionId, name, completion: 'unknown' },
});
const api = createBpProvisioningApi({ profile, region });
let cleanup: Awaited<ReturnType<typeof deletePrivateSandboxApplication>> | null = null;
try {
  cleanup = await deletePrivateSandboxApplication({ functionId, name }, api);
  if (readGit(['rev-parse', 'HEAD']) !== source.commit || readGit(['status', '--porcelain'])) {
    throw new Error('Sandbox cleanup source revision changed during the live run');
  }
  const record = { ...baseRecord, status: 'succeeded', cleanup };
  evidence.commit(record);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
} catch {
  const record = {
    ...baseRecord,
    status: 'failed',
    cleanup: cleanup ?? { functionId, absent: false },
    failure: {
      reason: 'Private sandbox application cleanup failed',
      sourceUnchanged: readGit(['rev-parse', 'HEAD']) === source.commit
        && !readGit(['status', '--porcelain']),
    },
  };
  evidence.commit(record);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  throw new Error('Private sandbox application cleanup failed; sanitized evidence was retained');
}
