/**
 * Idempotently create the dev TOS bucket and verify it with a put/get/delete
 * roundtrip. Reads credentials from the environment (use --env-file=.env).
 *
 *   node --env-file=.env --import tsx scripts/provision-tos.ts
 */
import { TosClient, TosServerError } from '@volcengine/tos-sdk';
import { loadConfig, requireConfig } from '../src/config.js';

const cfg = loadConfig();
const required = requireConfig(cfg, [
  'BYTEPLUS_ACCESS_KEY_ID',
  'BYTEPLUS_SECRET_ACCESS_KEY',
  'TOS_BUCKET',
]);

const client = new TosClient({
  accessKeyId: required.BYTEPLUS_ACCESS_KEY_ID,
  accessKeySecret: required.BYTEPLUS_SECRET_ACCESS_KEY,
  stsToken: cfg.BYTEPLUS_SESSION_TOKEN,
  region: cfg.TOS_REGION,
  endpoint: cfg.TOS_ENDPOINT,
});
const bucket = required.TOS_BUCKET;

async function bucketExists(): Promise<boolean> {
  try {
    await client.headBucket(bucket);
    return true;
  } catch (err) {
    if (err instanceof TosServerError && err.statusCode === 404) return false;
    throw err;
  }
}

if (await bucketExists()) {
  console.log(`bucket ${bucket} already exists — reusing`);
} else {
  await client.createBucket({ bucket }); // private ACL by default
  console.log(`bucket ${bucket} created (private, ${cfg.TOS_REGION})`);
}

// Fresh-read verification: control plane + data plane roundtrip.
await client.headBucket(bucket);
const key = '_smoke/roundtrip.txt';
const payload = `smoke ${new Date().toISOString()}`;
await client.putObject({ bucket, key, body: Buffer.from(payload) });
const got = await client.getObjectV2({ bucket, key, dataType: 'buffer' });
const roundtrip = (got.data.content as Buffer).toString('utf8');
if (roundtrip !== payload) {
  throw new Error(`roundtrip mismatch: ${roundtrip}`);
}
await client.deleteObject({ bucket, key });
console.log('verified: head + put/get/delete roundtrip OK');
