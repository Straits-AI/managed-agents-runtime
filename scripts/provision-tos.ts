/**
 * Idempotently create the dev TOS bucket and verify it with a put/get/delete
 * roundtrip. Reads credentials from the environment (use --env-file=.env).
 *
 *   node --env-file=.env --import tsx scripts/provision-tos.ts
 */
import { loadConfig, requireConfig } from '../src/config.js';
import { TosObjectStore } from '../src/providers/tosObjectStore.js';

const cfg = loadConfig();
const required = requireConfig(cfg, [
  'BYTEPLUS_ACCESS_KEY_ID',
  'BYTEPLUS_SECRET_ACCESS_KEY',
  'TOS_BUCKET',
]);
const store = new TosObjectStore(cfg);

if (await store.bucketExists()) {
  console.log(`bucket ${required.TOS_BUCKET} already exists — reusing`);
} else {
  await store.createBucket(); // private ACL by default
  console.log(`bucket ${required.TOS_BUCKET} created (private, ${cfg.TOS_REGION})`);
}

// Fresh-read verification: control plane + data plane roundtrip.
if (!await store.bucketExists()) throw new Error('bucket was not visible after creation');
const key = '_smoke/roundtrip.txt';
const payload = Buffer.from(`smoke ${new Date().toISOString()}`);
await store.put(key, payload);
const roundtrip = await store.get(key);
if (!roundtrip.equals(payload)) {
  throw new Error(`roundtrip mismatch: ${roundtrip.toString('utf8')}`);
}
await store.delete(key);
console.log('verified: head + put/get/delete roundtrip OK');
