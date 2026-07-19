/**
 * Idempotently provision the configured private TOS bucket and emit bounded,
 * secret-free live conformance evidence. The run covers bucket HEAD/create,
 * direct PUT/GET/HEAD, presigned GET/PUT, a post-delete 404, and cleanup.
 *
 *   node --env-file=.env --import tsx scripts/provision-tos.ts \
 *     --evidence-file /tmp/tos-conformance.json
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, requireConfig } from '../src/config.js';
import {
  buildTosConformanceRecord,
  resolveTosConformanceSource,
  runTosConformance,
} from '../src/providers/tosConformance.js';
import { TosObjectStore } from '../src/providers/tosObjectStore.js';

const cfg = loadConfig();
const required = requireConfig(cfg, [
  'BYTEPLUS_ACCESS_KEY_ID',
  'BYTEPLUS_SECRET_ACCESS_KEY',
  'TOS_BUCKET',
]);
const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version?: unknown };
const packageVersion = typeof packageMetadata.version === 'string'
  ? packageMetadata.version
  : 'unknown';
const explicitCommit = process.env.CONFORMANCE_SOURCE_COMMIT?.trim();
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
const readSource = () => {
  const gitCommit = readGit(['rev-parse', 'HEAD']);
  return resolveTosConformanceSource({
    explicitCommit,
    gitCommit,
    gitStatus: gitCommit === null ? null : readGit(['status', '--porcelain']),
  });
};
const source = readSource();
const store = new TosObjectStore(cfg);
const evidence = await runTosConformance(store);
const sourceAfterRun = readSource();
if (
  sourceAfterRun.commit !== source.commit ||
  sourceAfterRun.commitOrigin !== source.commitOrigin
) {
  throw new Error('TOS conformance source revision changed during the live run');
}
const record = buildTosConformanceRecord(evidence, {
  sourceRepository: 'https://github.com/Straits-AI/managed-agents-runtime',
  sourceCommit: source.commit,
  sourceCommitOrigin: source.commitOrigin,
  adapterName: 'TosObjectStore',
  adapterSourcePath: 'src/providers/tosObjectStore.ts',
  packageVersion,
  runtime: `node ${process.version}`,
  transport: 'native-fetch',
  apiVersion: 'TOS4-HMAC-SHA256',
  provider: 'byteplus-tos',
  region: cfg.TOS_REGION,
  endpoint: cfg.TOS_ENDPOINT,
  bucket: required.TOS_BUCKET,
  credentialBoundary: {
    source: 'process-environment',
    mode: cfg.BYTEPLUS_SESSION_TOKEN
      ? 'temporary-session'
      : 'long-lived-access-key',
    valuesSerialized: false,
  },
  retrievedAt: new Date(),
  capabilities: [
    'bucket.head',
    ...(evidence.controlPlane.bucketCreated ? ['bucket.create-if-missing'] : []),
    'object.put',
    'object.get',
    'object.head',
    'object.delete',
    'object.presign-get',
    'object.presign-put',
  ],
  untestedSemantics: evidence.controlPlane.bucketCreated
    ? []
    : ['bucket.create-if-missing'],
  unsupportedSemantics: [
    'bucket-delete',
    'multipart-upload',
    'object-versioning',
    'bucket-policy-and-acl',
    'server-side-encryption-attestation',
  ],
});
const serialized = `${JSON.stringify(record, null, 2)}\n`;
const evidenceFlag = process.argv.indexOf('--evidence-file');
if (evidenceFlag >= 0) {
  const requestedPath = process.argv[evidenceFlag + 1];
  if (!requestedPath || requestedPath.startsWith('--')) {
    throw new Error('--evidence-file requires a path');
  }
  writeFileSync(resolve(requestedPath), serialized, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}
process.stdout.write(serialized);
