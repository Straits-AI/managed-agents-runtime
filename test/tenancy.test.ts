import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from './helpers/db.js';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { createTenant, createApiKey } from '../src/store/tenants.js';
import { appendEvent } from '../src/core/transition.js';
import { withTransaction } from '../src/db/tx.js';
import { FsObjectStore } from '../src/providers/local/fsObjectStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: TestDb;
let app: FastifyInstance;
let store: FsObjectStore;
let storeDir: string;
let keyA: string;
let keyB: string;

const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
let agentSeq = 0;
const agentName = () => `agent-${++agentSeq}`; // names are unique per tenant

beforeAll(async () => {
  db = await createTestDb();
  storeDir = mkdtempSync(join(tmpdir(), 'ma-tenancy-'));
  store = new FsObjectStore(storeDir);
  await store.start();
  const cfg = loadConfig({ ...process.env, DATABASE_URL: db.url, API_AUTH_TOKEN: 'op-token' });
  // Wire an object store so /export exercises its tenant guard (not just 501).
  app = buildServer({ pool: db.pool, cfg, objectStore: store });

  const a = await createTenant(db.pool, { name: 'Tenant A' });
  const b = await createTenant(db.pool, { name: 'Tenant B' });
  keyA = (await createApiKey(db.pool, { tenantId: a.id })).plaintext;
  keyB = (await createApiKey(db.pool, { tenantId: b.id })).plaintext;
});

afterAll(async () => {
  await app.close();
  await store.close();
  rmSync(storeDir, { recursive: true, force: true });
  await db.drop();
});

/** Create an agent version and a run under a given API key; returns the run id. */
async function makeRun(key: string): Promise<string> {
  const agentRes = await app.inject({ method: 'POST', url: '/v1/agents', headers: bearer(key), payload: { name: agentName() } });
  expect(agentRes.statusCode, `agent: ${agentRes.body}`).toBe(201);
  const verRes = await app.inject({
    method: 'POST',
    url: `/v1/agents/${agentRes.json().id}/versions`,
    headers: bearer(key),
    payload: { instructions: 'x', modelPolicy: { model: 'none' } },
  });
  expect(verRes.statusCode, `version: ${verRes.body}`).toBe(201);
  const run = await app.inject({
    method: 'POST',
    url: '/v1/runs',
    headers: bearer(key),
    payload: { agentVersionId: verRes.json().id, goal: 'g', input: { script: [] } },
  });
  expect(run.statusCode, `run: ${run.body}`).toBe(201);
  return run.json().id;
}

describe('multi-tenancy & auth', () => {
  it('rejects missing, malformed, and unknown credentials', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/usage' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: 'Bearer nope' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: 'Basic x' } }))
        .statusCode,
    ).toBe(401);
  });

  it('the operator token authenticates as the default tenant', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/usage', headers: bearer('op-token') });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenantId).toBe('default');
  });

  it('isolates runs across tenants (cross-tenant reads are 404, not 403)', async () => {
    const runA = await makeRun(keyA);

    // Owner sees it.
    expect((await app.inject({ method: 'GET', url: `/v1/runs/${runA}`, headers: bearer(keyA) })).statusCode).toBe(200);
    // Another tenant — and the operator/default tenant — cannot even confirm it exists.
    expect((await app.inject({ method: 'GET', url: `/v1/runs/${runA}`, headers: bearer(keyB) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/runs/${runA}`, headers: bearer('op-token') })).statusCode).toBe(404);

    // Sub-resources are scoped the same way.
    for (const sub of ['events', 'approvals', 'artifacts', 'usage', 'export']) {
      const res = await app.inject({ method: 'GET', url: `/v1/runs/${runA}/${sub}`, headers: bearer(keyB) });
      expect(res.statusCode, `${sub} cross-tenant`).toBe(404);
    }
  });

  it("forbids running another tenant's agent version", async () => {
    // Tenant A makes an agent+version; tenant B tries to launch a run against it.
    const agent = (
      await app.inject({ method: 'POST', url: '/v1/agents', headers: bearer(keyA), payload: { name: agentName() } })
    ).json();
    const ver = (
      await app.inject({
        method: 'POST',
        url: `/v1/agents/${agent.id}/versions`,
        headers: bearer(keyA),
        payload: { instructions: 'x', modelPolicy: {} },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: bearer(keyB),
      payload: { agentVersionId: ver.id, goal: 'g', input: {} },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('tenant quotas', () => {
  it('enforces the concurrent-run quota with 429', async () => {
    const t = await createTenant(db.pool, { name: 'Capped', quota: { maxConcurrentRuns: 1 } });
    const key = (await createApiKey(db.pool, { tenantId: t.id })).plaintext;
    const agent = (
      await app.inject({ method: 'POST', url: '/v1/agents', headers: bearer(key), payload: { name: agentName() } })
    ).json();
    const ver = (
      await app.inject({
        method: 'POST',
        url: `/v1/agents/${agent.id}/versions`,
        headers: bearer(key),
        payload: { instructions: 'x', modelPolicy: {} },
      })
    ).json();
    const mk = () =>
      app.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: bearer(key),
        payload: { agentVersionId: ver.id, goal: 'g', input: {} },
      });

    expect((await mk()).statusCode).toBe(201); // first run: within quota (stays QUEUED = active)
    const second = await mk();
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatch(/quota/i);
  });
});

describe('usage & cost attribution', () => {
  it('reports per-run token usage and estimated cost from the ledger', async () => {
    const runId = await makeRun(keyA);
    // A fresh run has no model usage yet.
    const empty = (await app.inject({ method: 'GET', url: `/v1/runs/${runId}/usage`, headers: bearer(keyA) })).json();
    expect(empty).toMatchObject({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });

    // Simulate two model calls' worth of usage in the ledger.
    await withTransaction(db.pool, async (tx) => {
      await appendEvent(tx, runId, { type: 'ModelInvocationCompleted', payload: { usage: { inputTokens: 1_000_000, outputTokens: 500_000 } } });
      await appendEvent(tx, runId, { type: 'ModelInvocationCompleted', payload: { usage: { inputTokens: 0, outputTokens: 500_000 } } });
    });

    const u = (await app.inject({ method: 'GET', url: `/v1/runs/${runId}/usage`, headers: bearer(keyA) })).json();
    expect(u.inputTokens).toBe(1_000_000);
    expect(u.outputTokens).toBe(1_000_000);
    expect(u.modelCalls).toBe(2);
    // Default price: $0.25/M in + $2.00/M out → 0.25 + 2.00 = $2.25.
    expect(u.estimatedCostUsd).toBeCloseTo(2.25, 6);

    // Tenant rollup includes it and never leaks to another tenant.
    const rollup = (await app.inject({ method: 'GET', url: '/v1/usage', headers: bearer(keyA) })).json();
    expect(rollup.totalTokens).toBeGreaterThanOrEqual(2_000_000);
    const other = (await app.inject({ method: 'GET', url: '/v1/usage', headers: bearer(keyB) })).json();
    expect(other.totalTokens).toBe(0);
  });
});

describe('health probes', () => {
  it('serves /healthz and /readyz without auth', async () => {
    const h = await app.inject({ method: 'GET', url: '/healthz' });
    expect(h.statusCode).toBe(200);
    expect(h.json().status).toBe('ok');
    const r = await app.inject({ method: 'GET', url: '/readyz' });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('ready');
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once a tenant exhausts its burst', async () => {
    const cfg = loadConfig({
      ...process.env,
      DATABASE_URL: db.url,
      API_AUTH_TOKEN: 'op-token',
      RATE_LIMIT_PER_SEC: '1',
      RATE_LIMIT_BURST: '1',
    });
    const limited = buildServer({ pool: db.pool, cfg });
    try {
      const first = await limited.inject({ method: 'GET', url: '/v1/usage', headers: bearer('op-token') });
      expect(first.statusCode).toBe(200);
      const second = await limited.inject({ method: 'GET', url: '/v1/usage', headers: bearer('op-token') });
      expect(second.statusCode).toBe(429);
      expect(second.headers['retry-after']).toBeDefined();
      // Health probes are exempt (not rate limited, no auth).
      expect((await limited.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
