import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AwsPublicS3Reader, AwsPublicS3Error } from '../src/providers/aws/publicS3Reader.js';

const root = resolve(import.meta.dirname, '..');
const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (status) throw new Error('AWS public S3 conformance requires a clean source worktree');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const retrievedAt = new Date().toISOString();
const store = new AwsPublicS3Reader({
  bucket: 'noaa-goes16',
  region: 'us-east-1',
  maxObjectBytes: 64 * 1024,
  requestTimeoutMs: 20_000,
});
const positiveKey = 'index.html';
const missingKey = `managed-agents-portability-missing-${commit.slice(0, 12)}`;
const positiveHead = await store.inspect(positiveKey);
if (!positiveHead.exists) throw new Error('AWS public S3 positive object is absent');
const positiveGet = await store.getWithMetadata(positiveKey);
const negativeHead = await store.inspect(missingKey);
if (negativeHead.exists || negativeHead.metadata.status !== 404) {
  throw new Error('AWS public S3 negative HEAD did not return absence');
}
let negativeGet: { status: number | null; requestId: string | null } | null = null;
try {
  await store.get(missingKey);
  throw new Error('AWS public S3 negative GET unexpectedly succeeded');
} catch (error) {
  if (!(error instanceof AwsPublicS3Error) || error.status !== 404) throw error;
  negativeGet = { status: error.status, requestId: error.requestId };
}

const unchangedFiles = [
  'src/providers/aws/publicS3Reader.ts',
  'scripts/conformance-aws-public-s3.ts',
  'test/awsPublicS3Reader.test.ts',
].map((path) => ({
  path,
  sha256: createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
}));

const record = {
  schemaVersion: 1,
  evidenceId: `aws-public-s3-${commit.slice(0, 12)}`,
  source: {
    repository: 'https://github.com/Straits-AI/managed-agents-runtime',
    commit,
    commitOrigin: 'git-clean-worktree',
    unchangedFiles,
  },
  provider: 'aws-s3-public',
  region: 'us-east-1',
  retrievedAt,
  target: {
    registry: 'AWS Registry of Open Data',
    bucket: 'noaa-goes16',
    access: 'anonymous-read-only',
  },
  controlPlane: {
    credentialsUsed: false,
    resourcesCreated: false,
  },
  dataPlane: {
    positive: {
      key: positiveKey,
      head: positiveHead.metadata,
      get: positiveGet.metadata,
      bodyBytes: positiveGet.body.length,
      bodySha256: createHash('sha256').update(positiveGet.body).digest('hex'),
    },
    negative: {
      key: missingKey,
      head: negativeHead.metadata,
      get: negativeGet,
    },
  },
  redaction: {
    responseBodySerialized: false,
    responseHeadersAllowlisted: ['status', 'x-amz-request-id', 'etag', 'content-length'],
    credentialsSerialized: false,
    signedUrlsSerialized: false,
  },
  cleanup: {
    required: false,
    reason: 'read-only public dataset; no resource or object was created',
  },
  limitations: [
    'anonymous object GET and HEAD only',
    'no write, delete, list, version, presign, encryption, availability, or performance claim',
  ],
};

process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
