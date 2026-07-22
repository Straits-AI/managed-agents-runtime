/**
 * End-to-end sandbox smoke test through the configured runtime transport:
 * create instance -> wait Ready -> exec a marker command -> write+read a
 * file -> terminate. Private WebShell is the default; APIG is explicit.
 *
 *   node --env-file=.env --import tsx scripts/smoke-sandbox.ts
 */
import { loadConfig, requireConfig } from '../src/config.js';
import { VefaasSandboxProvider } from '../src/providers/vefaasSandbox.js';

const cfg = loadConfig();
requireConfig(cfg, [
  'VEFAAS_SANDBOX_FUNCTION_ID',
]);

const provider = new VefaasSandboxProvider(cfg);
const marker = `marker-${Math.floor(Date.now() / 1000)}`;

const handle = await provider.create({ runId: 'smoke', timeoutMinutes: 10 });
console.log(`created sandbox ${handle.sandboxId}`);
try {
  // create() already waits for Ready; this read verifies the public contract.
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
