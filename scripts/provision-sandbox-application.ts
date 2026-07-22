import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createBpProvisioningApi } from '../src/providers/byteplus/bpProvisioningApi.js';
import { BpCliError } from '../src/providers/byteplus/privateWebshell.js';
import { reserveEvidenceRecord } from '../src/providers/byteplus/provisioningEvidence.js';
import {
  defaultPrivateSandboxApplicationPlan,
  PrivateSandboxConfigurationError,
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

const provisioningAttemptId = randomUUID();
const rawApi = createBpProvisioningApi({ profile, region });
const requestObservations: Array<{
  action: string;
  status: 'success' | 'failed';
  requestId: string | null;
  errorCode?: string | null;
}> = [];
let createdFunctionId: string | null = null;
const api: typeof rawApi = async (action, body) => {
  try {
    const response = await rawApi(action, body);
    requestObservations.push({
      action,
      status: 'success',
      requestId: response.requestId,
    });
    if (action === 'CreateFunction'
      && typeof response.result.Id === 'string'
      && /^[A-Za-z0-9._:-]{1,160}$/.test(response.result.Id)) {
      createdFunctionId = response.result.Id;
    }
    return response;
  } catch (error) {
    requestObservations.push({
      action,
      status: 'failed',
      requestId: error instanceof BpCliError ? error.requestId : null,
      errorCode: error instanceof BpCliError ? error.code : null,
    });
    throw error;
  }
};
const plan = defaultPrivateSandboxApplicationPlan(name);
const baseRecord = {
  schemaVersion: 1,
  evidenceId: `byteplus-sandbox-application-${name}`,
  source: {
    repository: 'https://github.com/Straits-AI/managed-agents-runtime',
    commit: source.commit,
    commitOrigin: source.commitOrigin,
  },
  provider: 'byteplus-vefaas',
  provisioningAttemptId,
  region,
  retrievedAt: new Date().toISOString(),
  toolchain: { bpVersion, apiVersion: '2024-06-06' },
  plannedApplication: {
    name: plan.name,
    functionType: 'sandbox',
    runtime: 'native/v1',
    image: plan.image,
    command: plan.command,
    port: plan.port,
    cpuMilli: plan.cpuMilli,
    memoryMB: plan.memoryMB,
    maxConcurrency: plan.maxConcurrency,
    requestTimeoutSeconds: plan.requestTimeoutSeconds,
    initializerSeconds: plan.initializerSeconds,
    instanceType: 'cpu-empty',
    tags: plan.tags,
    vpcEnabled: false,
    sharedInternetEnabled: false,
    logsEnabled: false,
    nasEnabled: false,
    tosMountEnabled: false,
  },
  redaction: {
    credentialsSerialized: false,
    signedUrlsSerialized: false,
    responseBodiesSerialized: false,
  },
};
const evidence = reserveEvidenceRecord(evidenceFile, {
  ...baseRecord,
  status: 'pending',
  application: { functionId: null },
  requests: [],
});

let successRecord: Record<string, unknown>;
try {
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
  const receipt = await provisionPrivateSandboxApplication(plan, api, {
    attemptId: provisioningAttemptId,
  });
  assertSourceUnchanged();
  successRecord = {
    ...baseRecord,
    status: 'succeeded',
    application: {
      functionId: receipt.functionId,
      disposition: receipt.disposition,
      stableRevisionNumber: receipt.stableRevisionNumber,
      releaseRecordId: receipt.releaseRecordId,
      configurationVerified: true,
    },
    requests: requestObservations,
  };
} catch (error) {
  const failureRecord = {
    ...baseRecord,
    status: 'failed',
    application: { functionId: createdFunctionId },
    requests: requestObservations,
    failure: {
      code: error instanceof BpCliError
        ? error.code
        : error instanceof PrivateSandboxConfigurationError
          ? 'ConfigurationMismatch'
          : 'ProvisioningFailed',
      requestId: error instanceof BpCliError ? error.requestId : null,
      invariantFields: error instanceof PrivateSandboxConfigurationError
        ? error.fields
        : undefined,
      sourceUnchanged: readGit(['rev-parse', 'HEAD']) === source.commit
        && !readGit(['status', '--porcelain']),
    },
  };
  evidence.commit(failureRecord);
  process.stdout.write(`${JSON.stringify(failureRecord, null, 2)}\n`);
  throw new Error('Private sandbox provisioning failed; sanitized evidence was retained');
}
evidence.commit(successRecord);
process.stdout.write(`${JSON.stringify(successRecord, null, 2)}\n`);

function assertSourceUnchanged(): void {
  if (readGit(['rev-parse', 'HEAD']) !== source.commit || readGit(['status', '--porcelain'])) {
    throw new Error('Sandbox provisioning source revision changed during the live run');
  }
}
