/**
 * End-to-end sandbox smoke test through the real APIG gateway:
 * create instance -> wait Ready -> exec a marker command -> write+read a
 * file -> terminate. Proves lifecycle + gateway auth + AIO data plane.
 *
 *   node --env-file=.env --import tsx scripts/smoke-sandbox.ts
 */
import { loadConfig, requireConfig } from '../src/config.js';
import { VefaasSandboxProvider } from '../src/providers/vefaasSandbox.js';

const cfg = loadConfig();
requireConfig(cfg, [
  'VEFAAS_SANDBOX_FUNCTION_ID',
  'SANDBOX_GATEWAY_DOMAIN',
  'SANDBOX_GATEWAY_API_KEY',
]);

const provider = new VefaasSandboxProvider(cfg);
const marker = `marker-${Math.floor(Date.now() / 1000)}`;

const handle = await provider.create({ runId: 'smoke', timeoutMinutes: 10 });
console.log(`created sandbox ${handle.sandboxId}`);
try {
  // Poll to Ready.
  for (let i = 0; i < 40; i++) {
    const { status } = await provider.describe(handle);
    if (status === 'Ready') break;
    if (status === 'Failed') throw new Error('sandbox failed to start');
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log('sandbox Ready');

  const exec = await provider.exec(handle, `echo ${marker}`);
  if (exec.exitCode !== 0 || !exec.stdout.includes(marker)) {
    throw new Error(`exec marker mismatch: code=${exec.exitCode} out=${exec.stdout.slice(0, 80)}`);
  }
  console.log(`exec OK (exit ${exec.exitCode}, marker echoed)`);

  await provider.writeFile(handle, '/tmp/smoke.txt', marker);
  const read = await provider.readFile(handle, '/tmp/smoke.txt');
  if (read.trim() !== marker) throw new Error(`file roundtrip mismatch: ${read.slice(0, 80)}`);
  console.log('file write/read roundtrip OK');

  console.log('SANDBOX SMOKE TEST PASSED');
} finally {
  await provider.terminate(handle);
  console.log(`terminated sandbox ${handle.sandboxId}`);
}
