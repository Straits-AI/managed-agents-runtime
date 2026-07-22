import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const postgresImage = 'postgres:16@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20';
const clientImage = 'node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2';
const image = required('CONTAINER_IMAGE');
const headCommit = await git(['rev-parse', 'HEAD']);
const serverCommit = process.env.KERTAS_SERVER_COMMIT?.trim() || await git(['rev-parse', 'HEAD']);
const clientCommit = process.env.KERTAS_CLIENT_COMMIT?.trim() || await git(['rev-parse', 'HEAD']);
const evidenceDir = resolve(process.env.KERTAS_CONFORMANCE_EVIDENCE_DIR
  ?? 'release-evidence/kertas-conformance');
const suffix = `${process.pid}-${Date.now()}`;
const network = `kertas-conformance-${suffix}`;
const postgres = `kertas-postgres-${suffix}`;
const api = `kertas-api-${suffix}`;
const worker = `kertas-worker-${suffix}`;
const databaseVolume = `kertas-database-${suffix}`;
const artifactVolume = `kertas-artifacts-${suffix}`;
const operatorToken = 'kertas-conformance-operator-token-000000000000000000000';
const databaseUrl = `postgres://postgres@${postgres}:5432/postgres`;
const containers = [worker, api, postgres];
const volumes = [artifactVolume, databaseVolume];
const compiledClient = await mkdtemp(join(tmpdir(), 'kertas-runtime-client-'));
let clientReceipt: Record<string, unknown> | null = null;
let failure: string | null = null;
const cleanup = {
  containersRemoved: false,
  networkRemoved: false,
  volumesRemoved: false,
  clientFilesRemoved: false,
};
let imageDigest = '';
let imageConfigDigest = '';
let imageManifestDigest: string | null = null;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function redact(value: string): string {
  return value
    .replace(/mak_[A-Za-z0-9_-]+/g, 'mak_[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

async function git(args: string[]): Promise<string> {
  return (await exec('git', args)).stdout.trim();
}

async function docker(
  args: string[],
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  try {
    return (await exec('docker', args, {
      env: options.env ?? process.env,
      maxBuffer: 20 * 1024 * 1024,
    })).stdout.trim();
  } catch (error) {
    if (options.allowFailure) return '';
    const details = error as Error & { stdout?: string; stderr?: string };
    throw new Error(redact(`${details.stdout ?? ''}${details.stderr ?? ''}`.trim()) || 'docker command failed');
  }
}

function runtimeEnvironment(): string[] {
  return [
    '-e', `DATABASE_URL=${databaseUrl}`,
    '-e', 'NODE_ENV=production',
    '-e', 'API_HOST=0.0.0.0',
    '-e', 'API_AUTH_TOKEN',
    '-e', 'HTTP_EGRESS_MODE=allowlist',
    '-e', 'HTTP_EGRESS_ALLOWLIST=https://example.com',
    '-e', 'POLL_MS=100',
    '-e', 'LOCAL_OBJECT_STORE_DIR=/var/lib/managed-agents/artifacts',
  ];
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await docker(
      ['exec', postgres, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      { allowFailure: true },
    );
    if (result.includes('accepting connections')) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('PostgreSQL did not become ready');
}

async function waitForApi(): Promise<void> {
  const probe = [
    "const r=await fetch('http://127.0.0.1:8080/readyz');",
    'if(!r.ok)process.exit(1);',
  ].join('');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await docker(['exec', api, 'node', '--input-type=module', '-e', probe], {
      allowFailure: true,
    });
    const state = await docker(['inspect', '--format', '{{.State.Running}}', api], {
      allowFailure: true,
    });
    if (state === 'true') {
      const ready = await docker([
        'exec', api, 'node', '--input-type=module', '-e',
        "const r=await fetch('http://127.0.0.1:8080/readyz');if(!r.ok)process.exit(1);process.stdout.write('ready')",
      ], { allowFailure: true });
      if (ready === 'ready') return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('runtime API did not become ready');
}

function apiKey(output: string): string {
  const match = output.match(/\bmak_[A-Za-z0-9_-]+\b/);
  if (!match) throw new Error('admin did not return a tenant API key');
  return match[0];
}

async function compileStandaloneClient(): Promise<void> {
  await exec(join('node_modules', '.bin', 'tsc'), [
    '--ignoreConfig',
    '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--strict', '--skipLibCheck', '--types', 'node', '--rootDir', 'clients/kertas-runtime/src',
    '--outDir', compiledClient,
    'clients/kertas-runtime/src/contractDiscovery.ts',
    'clients/kertas-runtime/src/runtimeClient.ts',
    'clients/kertas-runtime/src/index.ts',
    'clients/kertas-runtime/src/conformance.ts',
  ]);
  await writeFile(join(compiledClient, 'package.json'), '{"type":"module"}\n');
}

try {
  if (
    !/^[0-9a-f]{40}$/.test(serverCommit)
    || !/^[0-9a-f]{40}$/.test(clientCommit)
    || serverCommit !== headCommit
    || clientCommit !== headCommit
  ) {
    throw new Error('server and client commits must equal the exact checked-out commit');
  }
  if ((await git(['status', '--porcelain'])).length > 0) {
    throw new Error('Kertas conformance requires a clean working tree');
  }
  const inspected = JSON.parse(await docker(['image', 'inspect', image])) as Array<{
    Id: string;
    RepoDigests?: string[];
    Config?: { Labels?: Record<string, string> };
  }>;
  const descriptor = inspected[0];
  if (!descriptor || !/^sha256:[0-9a-f]{64}$/.test(descriptor.Id)) {
    throw new Error('runtime image has no content digest');
  }
  imageConfigDigest = descriptor.Id;
  const referenceDigest = image.match(/@(sha256:[0-9a-f]{64})$/)?.[1] ?? null;
  const repositoryDigest = descriptor.RepoDigests
    ?.map((reference) => reference.match(/@(sha256:[0-9a-f]{64})$/)?.[1] ?? null)
    .find((digest): digest is string => digest !== null) ?? null;
  imageManifestDigest = referenceDigest ?? repositoryDigest;
  imageDigest = imageManifestDigest ?? imageConfigDigest;
  if (descriptor.Config?.Labels?.['org.opencontainers.image.revision'] !== serverCommit) {
    throw new Error('runtime image revision label does not match server commit');
  }
  await compileStandaloneClient();
  await docker(['pull', clientImage]);
  await docker(['network', 'create', network]);
  for (const volume of volumes) await docker(['volume', 'create', volume]);
  await docker([
    'run', '--rm', '--mount', `type=volume,source=${artifactVolume},target=/artifacts`,
    clientImage, 'sh', '-c', 'chown 1000:1000 /artifacts',
  ]);
  await docker([
    'run', '-d', '--name', postgres, '--network', network,
    '--mount', `type=volume,source=${databaseVolume},target=/var/lib/postgresql/data`,
    '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e', 'POSTGRES_DB=postgres', postgresImage,
  ]);
  await waitForPostgres();
  const runtimeEnv = { ...process.env, API_AUTH_TOKEN: operatorToken };
  await docker(['run', '--rm', '--network', network, ...runtimeEnvironment(), image, 'migrate'], {
    env: runtimeEnv,
  });
  for (const [id, name] of [
    ['kertas-a', 'Kertas A'],
    ['kertas-b', 'Kertas B'],
  ] as const) {
    await docker([
      'run', '--rm', '--network', network, ...runtimeEnvironment(), image,
      'admin', 'tenant', 'create', name, '--id', id,
    ], { env: runtimeEnv });
  }
  const tenantToken = apiKey(await docker([
    'run', '--rm', '--network', network, ...runtimeEnvironment(), image,
    'admin', 'key', 'create', 'kertas-a', '--name', 'conformance',
  ], { env: runtimeEnv }));
  const otherTenantToken = apiKey(await docker([
    'run', '--rm', '--network', network, ...runtimeEnvironment(), image,
    'admin', 'key', 'create', 'kertas-b', '--name', 'isolation-probe',
  ], { env: runtimeEnv }));
  await docker([
    'run', '-d', '--name', api, '--network', network,
    '--mount', `type=volume,source=${artifactVolume},target=/var/lib/managed-agents/artifacts`,
    ...runtimeEnvironment(), image, 'api',
  ], { env: runtimeEnv });
  await waitForApi();
  await docker([
    'run', '-d', '--name', worker, '--network', network,
    '--mount', `type=volume,source=${artifactVolume},target=/var/lib/managed-agents/artifacts`,
    ...runtimeEnvironment(), '-e', 'WORKER_EPOCH=scripted', image, 'worker',
  ], { env: runtimeEnv });
  const clientEnvironment = {
    ...process.env,
    KERTAS_TENANT_TOKEN: tenantToken,
    KERTAS_OTHER_TENANT_TOKEN: otherTenantToken,
    KERTAS_RUNTIME_URL: `http://${api}:8080`,
    KERTAS_SERVER_COMMIT: serverCommit,
    KERTAS_CLIENT_COMMIT: clientCommit,
    KERTAS_IMAGE_DIGEST: imageDigest,
  };
  const output = await docker([
    'run', '--rm', '--network', network,
    '-e', 'KERTAS_TENANT_TOKEN', '-e', 'KERTAS_OTHER_TENANT_TOKEN',
    '-e', 'KERTAS_RUNTIME_URL', '-e', 'KERTAS_SERVER_COMMIT',
    '-e', 'KERTAS_CLIENT_COMMIT', '-e', 'KERTAS_IMAGE_DIGEST',
    '--mount', `type=bind,source=${compiledClient},target=/client,readonly`,
    '--workdir', '/client', clientImage, 'node', 'conformance.js',
  ], { env: clientEnvironment });
  clientReceipt = JSON.parse(output) as Record<string, unknown>;
  if (clientReceipt.status !== 'passed' || clientReceipt.endpointIsLoopback !== false) {
    throw new Error('standalone client did not pass the non-loopback conformance scenario');
  }
} catch (error) {
  failure = redact(error instanceof Error ? error.message : String(error));
} finally {
  for (const name of containers) await docker(['rm', '-f', '-v', name], { allowFailure: true });
  await docker(['network', 'rm', network], { allowFailure: true });
  for (const volume of volumes) await docker(['volume', 'rm', volume], { allowFailure: true });
  try {
    const remainingContainers = (await docker([
      'container', 'ls', '-a', '--format', '{{.Names}}',
    ])).split('\n').filter(Boolean);
    cleanup.containersRemoved = containers.every((name) => !remainingContainers.includes(name));
    const remainingNetworks = (await docker([
      'network', 'ls', '--format', '{{.Name}}',
    ])).split('\n').filter(Boolean);
    cleanup.networkRemoved = !remainingNetworks.includes(network);
    const remainingVolumes = (await docker([
      'volume', 'ls', '--format', '{{.Name}}',
    ])).split('\n').filter(Boolean);
    cleanup.volumesRemoved = volumes.every((name) => !remainingVolumes.includes(name));
  } catch (error) {
    failure ??= redact(error instanceof Error ? error.message : String(error));
  }
  await rm(compiledClient, { recursive: true, force: true });
  cleanup.clientFilesRemoved = true;

  const receipt = {
    schemaVersion: 1,
    status: failure === null && Object.values(cleanup).every(Boolean) ? 'passed' : 'failed',
    source: {
      serverCommit,
      clientCommit,
      testedImageReference: image,
      imageConfigDigest,
      imageManifestDigest,
      effectiveImageDigest: imageDigest,
    },
    deployment: {
      topology: 'isolated Docker network with separate API, worker, database, and client containers',
      clientEndpoint: `http://${api}:8080`,
      endpointIsLoopback: false,
      authentication: 'two tenant-scoped API keys',
    },
    conformance: clientReceipt,
    cleanup,
    redaction: { credentialsRetained: false, signedUrlsRetained: false },
    error: failure,
  };
  const receiptSource = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptSha256 = createHash('sha256').update(receiptSource).digest('hex');
  const summary = {
    schemaVersion: 1,
    status: receipt.status,
    receipt: { path: 'kertas-conformance-receipt.json', sha256: receiptSha256 },
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, 'kertas-conformance-receipt.json'), receiptSource);
  await writeFile(
    join(evidenceDir, 'kertas-conformance-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

if (failure || !Object.values(cleanup).every(Boolean)) {
  throw new Error(failure ?? 'Kertas conformance cleanup failed');
}
process.stdout.write(`PASS standalone Kertas runtime conformance ${imageDigest}\n`);
