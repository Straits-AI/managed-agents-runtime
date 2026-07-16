import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { startWorker, type EpochRunner } from '../harness/worker.js';
import { scriptedEpoch } from '../harness/scriptedEpoch.js';

const cfg = loadConfig();
const pool = createPool(cfg.DATABASE_URL);

const epochMode = process.env.WORKER_EPOCH ?? 'real';
let epoch: EpochRunner;
let onSandboxOrphaned: ((sandboxId: string) => Promise<void>) | undefined;

if (epochMode === 'scripted') {
  epoch = scriptedEpoch;
} else {
  const { createRealEpoch } = await import('../harness/epoch.js');
  const { ModelArkProvider } = await import('../providers/modelark.js');
  const { VefaasSandboxProvider } = await import('../providers/vefaasSandbox.js');
  const { TosObjectStore } = await import('../providers/tosObjectStore.js');
  const sandbox = new VefaasSandboxProvider(cfg);
  epoch = createRealEpoch({
    model: new ModelArkProvider(cfg),
    sandbox,
    objectStore: new TosObjectStore(cfg),
  });
  onSandboxOrphaned = (id) => sandbox.terminateById(id);
}

console.log(`[worker] ${cfg.WORKER_ID} starting (epoch=${epochMode})`);
const handle = startWorker(pool, cfg, epoch, { onSandboxOrphaned });

async function shutdown(sig: string) {
  console.log(`[worker] ${sig} received, stopping`);
  await handle.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
