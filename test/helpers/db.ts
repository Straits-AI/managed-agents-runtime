import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { createPool, type Pool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/postgres';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export interface TestDb {
  pool: Pool;
  url: string;
  applyRemainingMigrations(): Promise<string[]>;
  drop(): Promise<void>;
}

/**
 * Create a throwaway database with the full schema applied, so test files
 * are isolated from each other and can run in parallel.
 */
export async function createTestDb(options: { through?: string } = {}): Promise<TestDb> {
  const dbName = `ma_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(BASE_URL);
  url.pathname = `/${dbName}`;
  const pool = createPool(url.toString());
  // DROP DATABASE ... WITH (FORCE) can kill an idle client's socket while it
  // is still closing; pg surfaces that as a pool 'error' event, which is an
  // uncaught exception if unhandled. Expected during teardown — swallow it.
  pool.on('error', () => {});
  if (options.through) {
    const partialDir = mkdtempSync(join(tmpdir(), 'ma-migrations-'));
    try {
      for (const file of readdirSync(MIGRATIONS_DIR)) {
        if (/^\d+_.+\.sql$/.test(file) && file <= options.through) {
          copyFileSync(join(MIGRATIONS_DIR, file), join(partialDir, file));
        }
      }
      await migrate(pool, partialDir);
    } finally {
      rmSync(partialDir, { recursive: true, force: true });
    }
  } else {
    await migrate(pool, MIGRATIONS_DIR);
  }

  return {
    pool,
    url: url.toString(),
    applyRemainingMigrations() {
      return migrate(pool, MIGRATIONS_DIR);
    },
    async drop() {
      await pool.end();
      const admin2 = new pg.Client({ connectionString: BASE_URL });
      await admin2.connect();
      await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin2.end();
    },
  };
}
