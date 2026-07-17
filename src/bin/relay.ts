import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { drainOutbox } from '../store/outbox.js';
import { log } from '../log.js';
import type { EventPublisher } from '../providers/types.js';

const cfg = loadConfig();
const pool = createPool(cfg.DATABASE_URL);
const rlog = log.child({ component: 'relay', publisher: cfg.PUBLISHER });

let publisher: EventPublisher;
if (cfg.PUBLISHER === 'kafka') {
  const { KafkaPublisher } = await import('../providers/kafkaPublisher.js');
  publisher = new KafkaPublisher();
} else {
  const { InProcessPublisher } = await import('../providers/local/inProcessPublisher.js');
  publisher = new InProcessPublisher();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = true;
async function loop(): Promise<void> {
  while (running) {
    try {
      // Drain greedily while rows keep coming; idle-sleep when caught up.
      const n = await drainOutbox(pool, publisher, cfg.RELAY_BATCH);
      if (n === 0) await sleep(cfg.RELAY_POLL_MS);
    } catch (err) {
      rlog.error('drain error', { err: (err as Error).message });
      await sleep(cfg.RELAY_POLL_MS);
    }
  }
}

rlog.info('starting');
const loopPromise = loop();

let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  rlog.info('shutting down', { signal: sig });
  running = false;
  const forced = setTimeout(() => {
    rlog.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, cfg.SHUTDOWN_TIMEOUT_MS);
  forced.unref();
  await loopPromise;
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
