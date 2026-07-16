/**
 * Preflight: verify every provider the runtime depends on, one PASS/FAIL/SKIP
 * line each. SKIP = required env vars absent. Exits non-zero on any FAIL.
 *
 * This is the M4 credential gate — it also settles empirically whether the
 * vefaas sandbox actions are exposed on the configured OpenAPI host
 * (open.byteplusapi.com vs open.volcengineapi.com).
 */
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { ModelArkProvider } from '../providers/modelark.js';
import { TosObjectStore } from '../providers/tosObjectStore.js';
import { VefaasSandboxProvider } from '../providers/vefaasSandbox.js';

const cfg = loadConfig();
let failed = false;

type Outcome = 'PASS' | 'FAIL' | 'SKIP';

function report(name: string, outcome: Outcome, detail: string): void {
  const icon = outcome === 'PASS' ? '✓' : outcome === 'FAIL' ? '✗' : '-';
  console.log(`${icon} ${outcome.padEnd(4)} ${name.padEnd(22)} ${detail}`);
  if (outcome === 'FAIL') failed = true;
}

async function check(
  name: string,
  requiredEnv: (keyof typeof cfg)[],
  fn: () => Promise<string>,
): Promise<void> {
  const missing = requiredEnv.filter((k) => !cfg[k]);
  if (missing.length > 0) {
    report(name, 'SKIP', `missing env: ${missing.join(', ')}`);
    return;
  }
  try {
    report(name, 'PASS', await fn());
  } catch (err) {
    report(name, 'FAIL', (err as Error).message.slice(0, 300));
  }
}

// 1. PostgreSQL
await check('postgres', ['DATABASE_URL'], async () => {
  const pool = createPool(cfg.DATABASE_URL);
  try {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM information_schema.tables
       WHERE table_name = 'runs'`,
    );
    return rows[0]!.n === '1'
      ? 'connected, schema present'
      : 'connected, schema NOT migrated (run: npm run migrate)';
  } finally {
    await pool.end();
  }
});

// 2. ModelArk
await check('modelark', ['ARK_API_KEY', 'ARK_MODEL'], async () => {
  const provider = new ModelArkProvider(cfg);
  const res = await provider.chat({
    model: cfg.ARK_MODEL!,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
    maxTokens: 16,
  });
  return `model=${cfg.ARK_MODEL} replied "${(res.message.content ?? '').trim().slice(0, 40)}" (${res.usage.inputTokens}+${res.usage.outputTokens} tokens)`;
});

// 3. TOS put/get/presign roundtrip
await check(
  'tos',
  ['BYTEPLUS_ACCESS_KEY_ID', 'BYTEPLUS_SECRET_ACCESS_KEY', 'TOS_BUCKET'],
  async () => {
    const store = new TosObjectStore(cfg);
    const key = `preflight/${randomBytes(8).toString('hex')}.txt`;
    const payload = Buffer.from(`preflight ${new Date().toISOString()}`);
    await store.put(key, payload);
    const roundtrip = await store.get(key);
    if (!roundtrip.equals(payload)) throw new Error('get returned different bytes');
    const presigned = await store.presignGet(key, 300);
    const viaUrl = await fetch(presigned);
    if (!viaUrl.ok) throw new Error(`presigned GET failed: HTTP ${viaUrl.status}`);
    return `bucket=${cfg.TOS_BUCKET} put/get/presign OK (${key})`;
  },
);

// 4. veFaaS control plane reachability (settles the host question)
await check(
  'vefaas-api',
  ['BYTEPLUS_ACCESS_KEY_ID', 'BYTEPLUS_SECRET_ACCESS_KEY', 'VEFAAS_SANDBOX_FUNCTION_ID'],
  async () => {
    const provider = new VefaasSandboxProvider(cfg);
    const res = await provider.lifecycle.listSandboxes(cfg.VEFAAS_SANDBOX_FUNCTION_ID!, {
      pageSize: 1,
    });
    return `host=${cfg.BYTEPLUS_OPENAPI_HOST} ListSandboxes OK (total=${res.Total ?? 0})`;
  },
);

// 5. Full sandbox lifecycle: create → domain → exec → kill
await check(
  'sandbox-lifecycle',
  ['BYTEPLUS_ACCESS_KEY_ID', 'BYTEPLUS_SECRET_ACCESS_KEY', 'VEFAAS_SANDBOX_FUNCTION_ID'],
  async () => {
    const provider = new VefaasSandboxProvider(cfg);
    const handle = await provider.create({
      runId: 'preflight',
      timeoutMinutes: 5,
    });
    try {
      const echo = await provider.exec(handle, 'echo preflight-$((6*7))', {
        timeoutSec: 60,
      });
      if (!echo.stdout.includes('preflight-42')) {
        throw new Error(
          `exec returned unexpected output: exit=${echo.exitCode} stdout=${echo.stdout.slice(0, 120)} stderr=${echo.stderr.slice(0, 120)}`,
        );
      }
      return `sandbox=${handle.sandboxId} domain OK, bash exec OK`;
    } finally {
      await provider.terminate(handle).catch((e) => {
        report('sandbox-cleanup', 'FAIL', `could not kill ${handle.sandboxId}: ${e}`);
      });
    }
  },
);

console.log(failed ? '\npreflight FAILED' : '\npreflight passed');
process.exit(failed ? 1 : 0);
