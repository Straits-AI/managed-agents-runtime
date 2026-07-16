import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { buildServer } from '../api/server.js';

const cfg = loadConfig();
const pool = createPool(cfg.DATABASE_URL);

let presignGet;
if (cfg.TOS_BUCKET && cfg.BYTEPLUS_ACCESS_KEY_ID) {
  const { TosObjectStore } = await import('../providers/tosObjectStore.js');
  const store = new TosObjectStore(cfg);
  presignGet = (key: string, ttl: number) => store.presignGet(key, ttl);
}

const app = buildServer({ pool, cfg, presignGet });

await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
console.log(`[api] listening on :${cfg.API_PORT}`);

async function shutdown() {
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
