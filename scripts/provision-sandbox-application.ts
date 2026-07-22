import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBpProvisioningApi } from '../src/providers/byteplus/bpProvisioningApi.js';
import {
  defaultPrivateSandboxApplicationPlan,
  provisionPrivateSandboxApplication,
} from '../src/providers/byteplus/sandboxApplication.js';
import { resolveTosConformanceSource } from '../src/providers/tosConformance.js';

const option = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};
const profile = option('--profile');
const region = option('--region');
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
const bpVersion = execFileSync('bp', ['version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
if (!/^[A-Za-z0-9._-]{1,80}$/.test(bpVersion)) {
  throw new Error('BytePlus CLI version was invalid');
}

const api = createBpProvisioningApi({ profile, region });
const plan = defaultPrivateSandboxApplicationPlan(name);
const images = await api('ListSandboxImages', {
  ImageType: 'public',
  PageNumber: 1,
  PageSize: 100,
});
const imageItems = Array.isArray(images.result.Images) ? images.result.Images : [];
const selectedImage = imageItems.find((item) => typeof item === 'object'
  && item !== null
  && (item as Record<string, unknown>).ImageGroup === 'Code'
  && (item as Record<string, unknown>).ImageUrl === plan.image
  && (item as Record<string, unknown>).PrecacheStatus === 'success');
if (!selectedImage) {
  throw new Error('The planned BytePlus Code image is not currently pre-cached');
}
const receipt = await provisionPrivateSandboxApplication(plan, api);
if (readGit(['rev-parse', 'HEAD']) !== source.commit || readGit(['status', '--porcelain'])) {
  throw new Error('Sandbox provisioning source revision changed during the live run');
}
const record = {
  schemaVersion: 1,
  evidenceId: `byteplus-sandbox-application-${name}`,
  source: {
    repository: 'https://github.com/Straits-AI/managed-agents-runtime',
    commit: source.commit,
    commitOrigin: source.commitOrigin,
  },
  provider: 'byteplus-vefaas',
  region,
  retrievedAt: new Date().toISOString(),
  toolchain: { bpVersion, apiVersion: '2024-06-06' },
  application: {
    name: plan.name,
    functionId: receipt.functionId,
    disposition: receipt.disposition,
    functionType: 'sandbox',
    runtime: 'native/v1',
    image: plan.image,
    command: plan.command,
    port: plan.port,
    cpuMilli: plan.cpuMilli,
    memoryMB: plan.memoryMB,
    maxConcurrency: plan.maxConcurrency,
    requestTimeoutSeconds: plan.requestTimeoutSeconds,
    instanceType: 'cpu-empty',
    stableRevisionNumber: receipt.stableRevisionNumber,
    releaseRecordId: receipt.releaseRecordId,
    vpcEnabled: false,
    sharedInternetEnabled: false,
    logsEnabled: false,
    nasEnabled: false,
    tosMountEnabled: false,
  },
  requestIds: [
    { action: 'ListSandboxImages', requestId: images.requestId },
    ...receipt.requestIds,
  ],
  redaction: {
    credentialsSerialized: false,
    signedUrlsSerialized: false,
    responseBodiesSerialized: false,
  },
};
const serialized = `${JSON.stringify(record, null, 2)}\n`;
writeFileSync(resolve(evidenceFile), serialized, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
process.stdout.write(serialized);
