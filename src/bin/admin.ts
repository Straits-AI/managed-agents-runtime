/**
 * Operator CLI for tenant + API-key administration.
 *
 *   node --env-file=.env --import tsx src/bin/admin.ts tenant create "Acme" \
 *        [--max-concurrent 10] [--daily-tokens 5000000] [--id acme]
 *   node --env-file=.env --import tsx src/bin/admin.ts key create <tenantId> [--name "ci"]
 *   node --env-file=.env --import tsx src/bin/admin.ts tenant list
 *
 * A minted key's plaintext is printed exactly once — it is never stored or
 * recoverable. Store it somewhere safe immediately.
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { createTenant, createApiKey } from '../store/tenants.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [, , resource, action, ...rest] = process.argv;
  const cfg = loadConfig();
  const pool = createPool(cfg.DATABASE_URL);

  try {
    if (resource === 'tenant' && action === 'create') {
      const name = rest.find((a) => !a.startsWith('--'));
      if (!name) throw new Error('usage: tenant create <name> [--id X] [--max-concurrent N] [--daily-tokens N]');
      const maxc = flag(rest, 'max-concurrent');
      const daily = flag(rest, 'daily-tokens');
      const tenant = await createTenant(pool, {
        name,
        id: flag(rest, 'id'),
        quota: {
          maxConcurrentRuns: maxc ? Number(maxc) : undefined,
          dailyTokenBudget: daily ? Number(daily) : undefined,
        },
      });
      process.stdout.write(`tenant created: ${tenant.id} (${tenant.name})\n`);
    } else if (resource === 'tenant' && action === 'list') {
      const { rows } = await pool.query(
        'SELECT id, name, status, max_concurrent_runs, daily_token_budget FROM tenants ORDER BY created_at',
      );
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    } else if (resource === 'key' && action === 'create') {
      const tenantId = rest.find((a) => !a.startsWith('--'));
      if (!tenantId) throw new Error('usage: key create <tenantId> [--name X]');
      const { id, plaintext } = await createApiKey(pool, { tenantId, name: flag(rest, 'name') });
      process.stdout.write(
        `api key created: ${id} for tenant ${tenantId}\n` +
          `\n  ${plaintext}\n\n` +
          `Store this now — it is shown once and cannot be recovered.\n`,
      );
    } else {
      process.stderr.write(
        'usage:\n' +
          '  tenant create <name> [--id X] [--max-concurrent N] [--daily-tokens N]\n' +
          '  tenant list\n' +
          '  key create <tenantId> [--name X]\n',
      );
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

await main();
