import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

const cfg = loadConfig();
const pool = createPool(cfg.DATABASE_URL);
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

try {
  const applied = await migrate(pool, migrationsDir);
  console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
} finally {
  await pool.end();
}
