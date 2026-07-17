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
  // Memory provider is pluggable: Postgres (default), AgentKit/Viking Memory, or off.
  let memory;
  if (cfg.MEMORY_PROVIDER === 'agentkit') {
    const { AgentKitMemoryProvider } = await import('../providers/agentkitMemory.js');
    const { requireConfig } = await import('../config.js');
    const req = requireConfig(cfg, [
      'BYTEPLUS_ACCESS_KEY_ID',
      'BYTEPLUS_SECRET_ACCESS_KEY',
      'AGENTKIT_MEMORY_COLLECTION',
    ]);
    memory = new AgentKitMemoryProvider({
      accessKeyId: req.BYTEPLUS_ACCESS_KEY_ID,
      secretAccessKey: req.BYTEPLUS_SECRET_ACCESS_KEY,
      sessionToken: cfg.BYTEPLUS_SESSION_TOKEN,
      collectionName: req.AGENTKIT_MEMORY_COLLECTION,
    });
  } else if (cfg.MEMORY_PROVIDER !== 'none') {
    const { PgMemoryProvider } = await import('../providers/pgMemory.js');
    memory = new PgMemoryProvider(pool);
  }
  // Knowledge: Postgres (default) or AgentKit Knowledge Base.
  let knowledge;
  if (cfg.KNOWLEDGE_PROVIDER === 'agentkit') {
    const { AgentKitKnowledgeProvider } = await import('../providers/agentkitKnowledge.js');
    const { requireConfig } = await import('../config.js');
    const req = requireConfig(cfg, ['BYTEPLUS_ACCESS_KEY_ID', 'BYTEPLUS_SECRET_ACCESS_KEY']);
    knowledge = new AgentKitKnowledgeProvider({
      accessKeyId: req.BYTEPLUS_ACCESS_KEY_ID,
      secretAccessKey: req.BYTEPLUS_SECRET_ACCESS_KEY,
      sessionToken: cfg.BYTEPLUS_SESSION_TOKEN,
    });
  } else if (cfg.KNOWLEDGE_PROVIDER !== 'none') {
    const { PgKnowledgeProvider } = await import('../providers/pgKnowledge.js');
    knowledge = new PgKnowledgeProvider(pool);
  }
  epoch = createRealEpoch({
    model: new ModelArkProvider(cfg),
    sandbox,
    objectStore: new TosObjectStore(cfg),
    memory,
    knowledge,
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
