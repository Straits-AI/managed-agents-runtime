import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const image = process.env.CONTAINER_IMAGE?.trim();
if (!image) {
  throw new Error('CONTAINER_IMAGE is required');
}
const postgresImage = 'postgres:16@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20';

const suffix = `${process.pid}-${Date.now()}`;
const network = `managed-agents-smoke-${suffix}`;
const postgres = `managed-agents-postgres-${suffix}`;
const api = `managed-agents-api-${suffix}`;
const worker = `managed-agents-worker-${suffix}`;
const relay = `managed-agents-relay-${suffix}`;
const containers = [relay, worker, api, postgres];
const authToken = 'container-smoke-auth-token-00000000000000000000000000000000';
const databaseUrl = `postgres://postgres@${postgres}:5432/postgres`;

async function docker(args: string[], allowFailure = false): Promise<string> {
  try {
    const result = await exec('docker', args, { maxBuffer: 10 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    if (allowFailure) return '';
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `docker ${args.join(' ')} failed\n${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      { cause: error },
    );
  }
}

function environment(): string[] {
  return [
    '-e', `DATABASE_URL=${databaseUrl}`,
    '-e', 'NODE_ENV=production',
    '-e', 'API_HOST=0.0.0.0',
    '-e', `API_AUTH_TOKEN=${authToken}`,
    '-e', 'HTTP_EGRESS_MODE=allowlist',
    '-e', 'HTTP_EGRESS_ALLOWLIST=https://example.com',
  ];
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = await docker(
      ['exec', postgres, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      true,
    );
    if (ready.includes('accepting connections')) return;
    await delay(500);
  }
  throw new Error('PostgreSQL did not become ready');
}

async function waitForContainerUrl(
  container: string,
  path: string,
  expected: unknown,
): Promise<void> {
  const url = `http://127.0.0.1:8080${path}`;
  const probe = [
    'const response = await fetch(process.argv[1]);',
    'const body = await response.json();',
    'process.stdout.write(JSON.stringify({ ok: response.ok, body }));',
  ].join('');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const output = await docker(
        ['exec', container, 'node', '--input-type=module', '-e', probe, url],
        true,
      );
      const result = JSON.parse(output) as { ok?: boolean; body?: unknown };
      if (result.ok && JSON.stringify(result.body) === JSON.stringify(expected)) return;
    } catch {
      // The API container may still be starting.
    }
    await delay(250);
  }
  throw new Error(`${url} did not return ${JSON.stringify(expected)}`);
}

async function assertRunning(name: string): Promise<void> {
  await delay(750);
  const running = await docker(['inspect', '--format', '{{.State.Running}}', name]);
  if (running !== 'true') {
    throw new Error(`${name} did not remain running`);
  }
}

try {
  await docker(['image', 'inspect', image]);
  const user = await docker(['image', 'inspect', '--format', '{{.Config.User}}', image]);
  if (!user || user === '0' || user === 'root') {
    throw new Error(`runtime image must use a named non-root user; got ${JSON.stringify(user)}`);
  }

  await docker(['network', 'create', network]);
  await docker([
    'run', '-d', '--name', postgres, '--network', network,
    '-e', 'POSTGRES_USER=postgres',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e', 'POSTGRES_DB=postgres',
    postgresImage,
  ]);
  await waitForPostgres();

  const firstMigration = await docker([
    'run', '--rm', '--network', network, ...environment(), image, 'migrate',
  ]);
  if (!firstMigration.startsWith('Applied:')) {
    throw new Error(`first migration did not apply schema: ${firstMigration}`);
  }
  const secondMigration = await docker([
    'run', '--rm', '--network', network, ...environment(), image, 'migrate',
  ]);
  if (secondMigration !== 'Already up to date.') {
    throw new Error(`migration was not idempotent: ${secondMigration}`);
  }

  const tenants = await docker([
    'run', '--rm', '--network', network, ...environment(), image,
    'admin', 'tenant', 'list',
  ]);
  if (!Array.isArray(JSON.parse(tenants))) {
    throw new Error('admin tenant list did not return a JSON array');
  }

  await docker([
    'run', '-d', '--name', api, '--network', network,
    ...environment(), image, 'api',
  ]);
  await waitForContainerUrl(api, '/healthz', { status: 'ok' });
  await waitForContainerUrl(api, '/readyz', { status: 'ready' });

  await docker([
    'run', '-d', '--name', worker, '--network', network,
    ...environment(), '-e', 'WORKER_EPOCH=scripted', image, 'worker',
  ]);
  await assertRunning(worker);

  await docker([
    'run', '-d', '--name', relay, '--network', network,
    ...environment(), image, 'relay',
  ]);
  await assertRunning(relay);

  let unknownRejected = false;
  try {
    await docker(['run', '--rm', image, 'unknown-command']);
  } catch (error) {
    unknownRejected = String(error).includes('unknown runtime command');
  }
  if (!unknownRejected) {
    throw new Error('image did not reject an unknown runtime command');
  }

  process.stdout.write('PASS container release contract\n');
} finally {
  for (const name of containers) {
    await docker(['rm', '-f', '-v', name], true);
  }
  await docker(['network', 'rm', network], true);
}

const conformanceEnvironment = { ...process.env };
const releaseCommit = process.env.RELEASE_COMMIT?.trim();
if (releaseCommit) {
  conformanceEnvironment.KERTAS_SERVER_COMMIT = releaseCommit;
  conformanceEnvironment.KERTAS_CLIENT_COMMIT = releaseCommit;
}
conformanceEnvironment.KERTAS_CONFORMANCE_EVIDENCE_DIR =
  process.env.KERTAS_CONFORMANCE_EVIDENCE_DIR
  ?? 'release-evidence/kertas-conformance';

const conformance = await exec(
  join(process.cwd(), 'node_modules', '.bin', 'tsx'),
  ['scripts/conformance-kertas-client.ts'],
  {
    env: conformanceEnvironment,
    maxBuffer: 20 * 1024 * 1024,
  },
);
process.stdout.write(conformance.stdout);
