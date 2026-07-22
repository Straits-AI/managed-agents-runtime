import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createBpProvisioningApi } from '../src/providers/byteplus/bpProvisioningApi.js';
import { BpVefaasLifecycle } from '../src/providers/byteplus/bpVefaasLifecycle.js';
import { BpCliError } from '../src/providers/byteplus/privateWebshell.js';
import { reserveEvidenceRecord } from '../src/providers/byteplus/provisioningEvidence.js';
import {
  deletePrivateSandboxApplication,
  type PrivateSandboxCleanupReceipt,
  type VefaasProvisioningApi,
} from '../src/providers/byteplus/sandboxApplication.js';
import { summarizeExactSandboxInventory } from '../src/providers/byteplus/sandboxInventory.js';
import { runSandboxConformance } from '../src/providers/sandboxConformance.js';
import { resolveTosConformanceSource } from '../src/providers/tosConformance.js';
import { VefaasSandboxProvider } from '../src/providers/vefaasSandbox.js';

const option = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};
const profile = option('--profile');
const region = option('--region');
const functionId = option('--function-id');
const applicationName = option('--application-name');
const runId = option('--run-id');
const evidenceFile = option('--evidence-file');
for (const [name, value, pattern] of [
  ['profile', profile, /^[A-Za-z0-9._-]{1,80}$/],
  ['region', region, /^[A-Za-z0-9._-]{1,80}$/],
  ['function ID', functionId, /^[A-Za-z0-9._-]{1,160}$/],
  ['application name', applicationName, /^[a-z][a-z0-9-]{2,62}$/],
  ['run ID', runId, /^[A-Za-z0-9._-]{1,160}$/],
] as const) {
  if (!pattern.test(value)) throw new Error(`Runtime sandbox ${name} is invalid`);
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
const bpVersion = execFileSync('bp', ['version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
if (!/^[A-Za-z0-9._-]{1,80}$/.test(bpVersion)) {
  throw new Error('Runtime sandbox bp version was invalid');
}

const baseRecord = {
  schemaVersion: 1,
  evidenceId: `byteplus-runtime-sandbox-${runId}`,
  source: {
    repository: 'https://github.com/Straits-AI/managed-agents-runtime',
    commit: source.commit,
    commitOrigin: source.commitOrigin,
  },
  provider: 'byteplus-vefaas-private-sandbox-runtime',
  region,
  retrievedAt: new Date().toISOString(),
  toolchain: {
    runtime: `node ${process.version}`,
    bpVersion,
    controlPlane: 'credential-isolating bp profile',
    controlPlaneApiVersion: '2024-06-06',
    dataPlane: 'ticketed-private-webshell',
    publicRouteUsed: false,
    maximumInstanceLifetimeMinutes: 10,
  },
  application: { functionId, name: applicationName, disposable: true },
  redaction: {
    credentialsSerialized: false,
    signedEndpointSerialized: false,
    ticketSerialized: false,
    commandPayloadSerialized: false,
    fileContentSerialized: false,
  },
};
const receipt = reserveEvidenceRecord(evidenceFile, {
  ...baseRecord,
  status: 'pending',
  successfulRequestMetadata: [],
});
const provisioningRequestMetadata: Array<{ action: string; requestId: string }> = [];
const rawApi = createBpProvisioningApi({ profile, region });
const api: VefaasProvisioningApi = async (action, body) => {
  const response = await rawApi(action, body);
  if (response.requestId && provisioningRequestMetadata.length < 200) {
    provisioningRequestMetadata.push({ action, requestId: response.requestId });
  }
  return response;
};
let applicationCleanup: PrivateSandboxCleanupReceipt | null = null;
const lifecycleRequestMetadata: Array<{ action: string; requestId: string }> = [];
const lifecycle = new BpVefaasLifecycle({
  profile,
  region,
  onResponseMetadata: (metadata) => {
    if (metadata.requestId && lifecycleRequestMetadata.length < 200) {
      lifecycleRequestMetadata.push({ action: metadata.action, requestId: metadata.requestId });
    }
  },
});
const provider = new VefaasSandboxProvider(loadConfig({
  ...process.env,
  VEFAAS_SANDBOX_FUNCTION_ID: functionId,
  BYTEPLUS_REGION: region,
  SANDBOX_TRANSPORT: 'private-webshell',
}), {
  lifecycle,
  afterKill: async () => {
    applicationCleanup = await ensureDisposableApplicationAbsent();
  },
});
let conformanceStage = 'provider-conformance';

try {
  const evidence = await runSandboxConformance({
    create: provider.create.bind(provider),
    describe: provider.describe.bind(provider),
    exec: provider.exec.bind(provider),
    writeFile: provider.writeFile.bind(provider),
    readFile: provider.readFile.bind(provider),
    terminate: provider.terminate.bind(provider),
    sleep: async (milliseconds) => {
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
    },
  }, {
    runId,
    timeoutMinutes: 10,
    marker: `runtime-${randomUUID()}`,
  });
  conformanceStage = 'application-cleanup';
  const verifiedCleanup = applicationCleanup as PrivateSandboxCleanupReceipt | null;
  if (verifiedCleanup === null || !verifiedCleanup.absent) {
    throw new Error('Runtime sandbox disposable application cleanup was not verified');
  }
  conformanceStage = 'request-metadata';
  const successfulRequestMetadata = [
    ...lifecycleRequestMetadata,
    ...provisioningRequestMetadata,
  ];
  for (const action of [
    'CreateSandbox',
    'DescribeSandbox',
    'GenWebshellEndpoint',
    'KillSandbox',
    'ListSandboxes',
    'DeleteFunction',
    'ListFunctions',
  ]) {
    if (!successfulRequestMetadata.some((metadata) => metadata.action === action)) {
      throw new Error(`Runtime sandbox did not preserve ${action} request metadata`);
    }
  }
  conformanceStage = 'source-verification';
  assertSourceUnchanged();
  const record = {
    ...baseRecord,
    status: 'succeeded',
    successfulRequestMetadata,
    evidence,
    finalInventory: {
      liveInstances: 0,
      terminatingTombstones: 0,
      applicationAbsent: true,
    },
    applicationCleanup: verifiedCleanup,
  };
  conformanceStage = 'evidence-commit';
  receipt.commit(record);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
} catch (error) {
  conformanceStage = applicationCleanup === null ? 'failure-cleanup' : conformanceStage;
  try {
    applicationCleanup ??= await ensureDisposableApplicationAbsent();
  } catch {
    // The failure receipt remains explicit about unverified cleanup.
  }
  const record = {
    ...baseRecord,
    status: 'failed',
    successfulRequestMetadata: [
      ...lifecycleRequestMetadata,
      ...provisioningRequestMetadata,
    ],
    failure: {
      code: error instanceof BpCliError ? error.code : 'RuntimeConformanceFailed',
      requestId: error instanceof BpCliError ? error.requestId : null,
      reason: safeRuntimeFailureReason(error),
      stage: conformanceStage,
      sourceUnchanged: readGit(['rev-parse', 'HEAD']) === source.commit
        && !readGit(['status', '--porcelain']),
    },
    finalInventory: {
      liveInstances: applicationCleanup?.absent ? 0 : null,
      applicationAbsent: applicationCleanup?.absent ?? false,
    },
    applicationCleanup,
  };
  receipt.commit(record);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  throw new Error('Runtime sandbox conformance failed; sanitized evidence was retained');
}

async function ensureDisposableApplicationAbsent(): Promise<PrivateSandboxCleanupReceipt> {
  if (await applicationIsAbsent()) {
    return { functionId, absent: true, requestIds: [] };
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inventory = await api('ListSandboxes', {
      FunctionId: functionId,
      PageNumber: 1,
      PageSize: 100,
    });
    const summary = summarizeExactSandboxInventory(inventory.result, { functionId });
    if (summary.liveInstances === summary.terminatingTombstones) {
      return await deletePrivateSandboxApplication({ functionId, name: applicationName }, api);
    }
    if (attempt < 19) {
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 1_000));
    }
  }
  throw new Error('Runtime sandbox disposable application did not become cleanup-safe');
}

async function applicationIsAbsent(): Promise<boolean> {
  try {
    await api('GetFunction', { Id: functionId });
    return false;
  } catch (error) {
    if (error instanceof BpCliError && error.code === 'ResourceNotFound') return true;
    throw error;
  }
}

function assertSourceUnchanged(): void {
  if (readGit(['rev-parse', 'HEAD']) !== source.commit || readGit(['status', '--porcelain'])) {
    throw new Error('Runtime sandbox source revision changed during the live run');
  }
}

function safeRuntimeFailureReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return /^Sandbox conformance (startup failed|startup timed out|execution failed|file roundtrip failed|(execution|file write|file read) request failed|cleanup could not be verified)$/.test(error.message)
    ? error.message
    : null;
}
