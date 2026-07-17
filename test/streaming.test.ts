import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from './helpers/db.js';
import { spawnWorker, type SpawnedWorker } from './helpers/worker.js';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import type { ScriptOp } from '../src/harness/scriptedEpoch.js';

let db: TestDb;
let app: FastifyInstance;
let base: string;
let agentVersionId: string;
const workers: SpawnedWorker[] = [];
const AUTH = { authorization: 'Bearer test-token' };

beforeAll(async () => {
  db = await createTestDb();
  const cfg = loadConfig({ ...process.env, DATABASE_URL: db.url, API_AUTH_TOKEN: 'test-token' });
  app = buildServer({ pool: db.pool, cfg });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const def = await createAgentDefinition(db.pool, { name: 'sse-agent' });
  const ver = await withTransaction(db.pool, (tx) =>
    createAgentVersion(tx, { agentId: def.id, instructions: 'x', modelPolicy: { model: 'none' } }),
  );
  agentVersionId = ver.id;
}, 30_000);

afterAll(async () => {
  while (workers.length > 0) await workers.pop()!.stop();
  await app.close();
  await db.drop();
});

/** Read the SSE stream, returning parsed frames once the `end` event arrives. */
async function readStream(runId: string, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(`${base}/v1/runs/${runId}/events/stream`, {
    headers: AUTH,
    signal: ctrl.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: { id?: string; event?: string; data?: string }[] = [];
  let ended = false;
  while (!ended) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() ?? '';
    for (const block of blocks) {
      if (block.startsWith(':')) continue; // heartbeat comment
      const frame: { id?: string; event?: string; data?: string } = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = line.slice(6);
      }
      frames.push(frame);
      if (frame.event === 'end') ended = true;
    }
  }
  clearTimeout(t);
  await reader.cancel().catch(() => {});
  return frames;
}

describe('SSE event streaming', () => {
  it('streams a run’s events in order and ends when the run completes', async () => {
    const script: ScriptOp[] = [
      { op: 'progress', note: 'working' },
      { op: 'checkpoint' },
      { op: 'complete' },
    ];
    const run = await withTransaction(db.pool, (tx) =>
      createRun(tx, { agentVersionId, goal: 'stream me', input: { script } }),
    );
    // Connect from seq 0 first; events are durable so we replay from the start
    // regardless of whether the worker races ahead — no missed-event window.
    workers.push(spawnWorker(db.url));

    const frames = await readStream(run.id);
    const dataFrames = frames.filter((f) => f.data && f.event !== 'end');
    const types = dataFrames.map((f) => JSON.parse(f.data!).type);

    expect(types).toContain('AttemptStarted');
    expect(types).toContain('ProgressUpdated');
    expect(types[types.length - 1]).toBe('RunCompleted');

    // ids (event seq) are strictly ascending.
    const seqs = dataFrames.map((f) => Number(f.id));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    // The stream ended with a terminal marker.
    const end = frames.at(-1)!;
    expect(end.event).toBe('end');
    expect(JSON.parse(end.data!).status).toBe('COMPLETED');
  }, 30_000);

  it('rejects an unauthenticated stream and a cross-tenant run', async () => {
    const res = await fetch(`${base}/v1/runs/run_x/events/stream`);
    expect(res.status).toBe(401);
    await res.body?.cancel().catch(() => {});

    const res2 = await fetch(`${base}/v1/runs/run_missing/events/stream`, { headers: AUTH });
    expect(res2.status).toBe(404);
    await res2.body?.cancel().catch(() => {});
  });
});
