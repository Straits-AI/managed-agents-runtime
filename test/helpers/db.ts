import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
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
  drop(): Promise<void>;
}

/**
 * Create a throwaway database with the full schema applied, so test files
 * are isolated from each other and can run in parallel.
 */
export async function createTestDb(): Promise<TestDb> {
  const dbName = `ma_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(BASE_URL);
  url.pathname = `/${dbName}`;
  const pool = createPool(url.toString());
  await migrate(pool, MIGRATIONS_DIR);

  return {
    pool,
    url: url.toString(),
    async drop() {
      await pool.end();
      const admin2 = new pg.Client({ connectionString: BASE_URL });
      await admin2.connect();
      await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin2.end();
    },
  };
}
