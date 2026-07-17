/**
 * Probe the live AgentKit OpenAPI to (a) confirm entitlement and (b) map the
 * memory action surface. Read-only by default; pass --create to provision a
 * VikingDB-backed memory collection (billable) and then discover the memory-
 * data add/search action names against it.
 *
 *   python3 scripts/refresh-creds.py
 *   node --env-file=.env --import tsx scripts/probe-agentkit.ts [--create]
 *
 * Prints only action names + sanitized status — never credentials.
 */
import { loadConfig, requireConfig } from '../src/config.js';
import { AgentKitClient } from '../src/providers/byteplus/agentkit.js';

const cfg = loadConfig();
const req = requireConfig(cfg, ['BYTEPLUS_ACCESS_KEY_ID', 'BYTEPLUS_SECRET_ACCESS_KEY']);
const client = new AgentKitClient({
  accessKeyId: req.BYTEPLUS_ACCESS_KEY_ID,
  secretAccessKey: req.BYTEPLUS_SECRET_ACCESS_KEY,
  sessionToken: cfg.BYTEPLUS_SESSION_TOKEN,
});

async function probe(action: string, body: Record<string, unknown>): Promise<void> {
  try {
    const res = await client.raw(action, body);
    console.log(`OK   ${action} -> ${JSON.stringify(res).slice(0, 140)}`);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.log(`     ${action} -> ${(err.code ?? err.message ?? '?').slice(0, 90)}`);
  }
}

console.log('== entitlement + collection surface ==');
await probe('ListRuntimes', { PageNumber: 1, PageSize: 5 });
await probe('ListTools', { PageNumber: 1, PageSize: 5 });
const cols = await client.listMemoryCollections().catch(() => ({ Memories: [] }));
console.log(`ListMemoryCollections -> ${cols.Memories?.length ?? 0} collection(s)`);

if (process.argv.includes('--create')) {
  console.log('\n== creating a memory collection (billable, VikingDB) ==');
  const created = await client.createMemoryCollection({
    name: 'managed-agents-memory',
    description: 'Managed Agents runtime long-term memory',
  });
  console.log('created:', JSON.stringify(created).slice(0, 200));
}

// Candidate memory-data action names to map (safe reads / missing-param probes).
console.log('\n== memory-data action discovery ==');
const memoryId = (cols.Memories?.[0]?.MemoryId as string) ?? 'mem-does-not-exist';
for (const a of [
  'SearchMemory', 'SearchMemoryData', 'SearchMemories', 'RetrieveMemory', 'QueryMemory',
  'AddMemory', 'AddMemoryData', 'CreateMemoryData', 'WriteMemory', 'PutMemory',
  'ListMemoryData', 'GetMemory', 'SearchMemoryCollection',
]) {
  await probe(a, { MemoryId: memoryId, Query: 'test', PageNumber: 1, PageSize: 5 });
}
