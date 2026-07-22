import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { buildServer } from '../api/server.js';
import { log } from '../log.js';
import { loadProviderPortability } from '../providers/portability.js';

const cfg = loadConfig();
const pool = createPool(cfg.DATABASE_URL);
const logger = log.child({ component: 'api' });

let presignGet;
let objectStore;
if (cfg.TOS_BUCKET && cfg.BYTEPLUS_ACCESS_KEY_ID) {
  const { TosObjectStore } = await import('../providers/tosObjectStore.js');
  objectStore = new TosObjectStore(cfg);
  presignGet = (key: string, ttl: number) => objectStore!.presignGet(key, ttl);
} else if (cfg.LOCAL_OBJECT_STORE_DIR) {
  const { FsObjectStore } = await import('../providers/local/fsObjectStore.js');
  objectStore = new FsObjectStore(cfg.LOCAL_OBJECT_STORE_DIR, cfg.TOS_MAX_OBJECT_BYTES);
}

// Test sources are intentionally absent from the runtime image; CI verifies
// every referenced path before image publication. Runtime still verifies the
// schemas, selections, and digest-bound live evidence copied into the image.
const providerPortability = loadProviderPortability(process.cwd(), { verifyTestFiles: false });
const app = buildServer({ pool, cfg, presignGet, objectStore, providerPortability });

await app.listen({ port: cfg.API_PORT, host: cfg.API_HOST });
logger.info('listening', { host: cfg.API_HOST, port: cfg.API_PORT });

let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return; // ignore repeated signals
  shuttingDown = true;
  logger.info('shutting down', { signal: sig });
  // Bound the drain so a hung connection can't block termination forever.
  const forced = setTimeout(() => {
    logger.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, cfg.SHUTDOWN_TIMEOUT_MS);
  forced.unref();
  try {
    await app.close(); // stop accepting, drain in-flight requests
    await pool.end();
    process.exit(0);
  } catch (err) {
    logger.error('shutdown error', { err: (err as Error).message });
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
