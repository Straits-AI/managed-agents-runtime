import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig, requireConfig } from '../src/config.js';
import { reserveEvidenceRecord } from '../src/providers/byteplus/provisioningEvidence.js';
import { BytePlusApiError } from '../src/providers/byteplus/signer.js';
import { VefaasClient, type VefaasResponseMetadata } from '../src/providers/byteplus/vefaas.js';
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
const functionId = option('--function-id');
const runId = option('--run-id');
const evidenceFile = option('--evidence-file');
for (const [name, value] of [['function ID', functionId], ['run ID', runId]] as const) {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(value)) {
    throw new Error(`Runtime sandbox ${name} is invalid`);
  }
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
const cfg = loadConfig({
  ...process.env,
  VEFAAS_SANDBOX_FUNCTION_ID: functionId,
  SANDBOX_TRANSPORT: 'private-webshell',
});
const required = requireConfig(cfg, [
  'BYTEPLUS_ACCESS_KEY_ID',
  'BYTEPLUS_SECRET_ACCESS_KEY',
]);
const responseMetadata: VefaasResponseMetadata[] = [];
const client = new VefaasClient({
  host: cfg.BYTEPLUS_OPENAPI_HOST,
  region: cfg.BYTEPLUS_REGION,
  accessKeyId: required.BYTEPLUS_ACCESS_KEY_ID,
  secretAccessKey: required.BYTEPLUS_SECRET_ACCESS_KEY,
  sessionToken: cfg.BYTEPLUS_SESSION_TOKEN,
  onResponseMetadata: (metadata) => {
    if (responseMetadata.length < 200) responseMetadata.push(metadata);
  },
});
const provider = new VefaasSandboxProvider(cfg, { lifecycle: client });
const bpVersion = execFileSync('bp', ['version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
const baseRecord = {
  schemaVersion: 1,
  evidenceId: `byteplus-runtime-sandbox-${runId}`,
  source: {
    repository: 'https://github.com/Straits-AI/managed-agents-runtime',
    commit: source.commit,
    commitOrigin: source.commitOrigin,
  },
  provider: 'byteplus-vefaas-private-sandbox-runtime',
  region: cfg.BYTEPLUS_REGION,
  retrievedAt: new Date().toISOString(),
  toolchain: {
    runtime: `node ${process.version}`,
    bpVersion,
    controlPlaneApiVersion: '2024-06-06',
    dataPlane: 'ticketed-private-webshell',
    publicRouteUsed: false,
    maximumInstanceLifetimeMinutes: 10,
  },
  application: { functionId },
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
  conformanceStage = 'final-inventory';
  const finalInventory = await client.listSandboxes(functionId, {
    pageNumber: 1,
    pageSize: 100,
  });
  const inventorySummary = summarizeExactSandboxInventory(finalInventory, {
    functionId,
    metadata: { runId },
  });
  if (inventorySummary.liveInstances !== 0) {
    throw new Error('Runtime sandbox final instance inventory was not empty');
  }
  conformanceStage = 'request-metadata';
  for (const action of [
    'CreateSandbox',
    'DescribeSandbox',
    'GenWebshellEndpoint',
    'KillSandbox',
    'ListSandboxes',
  ]) {
    if (!responseMetadata.some((metadata) => metadata.action === action && metadata.requestId)) {
      throw new Error(`Runtime sandbox did not preserve ${action} request metadata`);
    }
  }
  conformanceStage = 'source-verification';
  assertSourceUnchanged();
  const record = {
    ...baseRecord,
    status: 'succeeded',
    successfulRequestMetadata: responseMetadata,
    evidence,
    finalInventory: inventorySummary,
  };
  conformanceStage = 'evidence-commit';
  receipt.commit(record);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
} catch (error) {
  let liveInstances: number | null = null;
  try {
    const finalInventory = await client.listSandboxes(functionId, {
      pageNumber: 1,
      pageSize: 100,
      metadata: { runId },
    });
    liveInstances = summarizeExactSandboxInventory(finalInventory, {
      functionId,
      metadata: { runId },
    }).liveInstances;
  } catch {
    // The failure receipt must still survive an unavailable final inventory read.
  }
  const record = {
    ...baseRecord,
    status: 'failed',
    successfulRequestMetadata: responseMetadata,
    failure: {
      code: error instanceof BytePlusApiError ? error.code : 'RuntimeConformanceFailed',
      requestId: error instanceof BytePlusApiError ? error.requestId : null,
      reason: safeRuntimeFailureReason(error),
      stage: conformanceStage,
      sourceUnchanged: readGit(['rev-parse', 'HEAD']) === source.commit
        && !readGit(['status', '--porcelain']),
    },
    finalInventory: { liveInstances },
  };
  receipt.commit(record);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  throw new Error('Runtime sandbox conformance failed; sanitized evidence was retained');
}

function assertSourceUnchanged(): void {
  if (readGit(['rev-parse', 'HEAD']) !== source.commit || readGit(['status', '--porcelain'])) {
    throw new Error('Runtime sandbox source revision changed during the live run');
  }
}

function safeRuntimeFailureReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return /^Sandbox conformance (startup failed|startup timed out|execution failed|file roundtrip failed|(execution|file write|file read) request failed)$/.test(error.message)
    ? error.message
    : null;
}
