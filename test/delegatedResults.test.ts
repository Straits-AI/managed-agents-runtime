import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { withTransaction } from '../src/db/tx.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun, getRun } from '../src/store/runs.js';
import { transitionRun } from '../src/core/transition.js';
import { newId } from '../src/ids.js';
import { spawnChildren, wakeReadyParents } from '../src/scheduler/children.js';
import { buildBoundedRunResult } from '../src/core/delegatedResults.js';
import { createArtifact } from '../src/store/artifacts.js';
import { childLineageProjection } from '../src/store/childLineage.js';
import { listEvents } from '../src/store/events.js';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';

let db: TestDb;
let agentVersionId: string;

beforeAll(async () => {
  db = await createTestDb();
  const definition = await createAgentDefinition(db.pool, { name: 'delegated-results' });
  const version = await withTransaction(db.pool, (tx) => createAgentVersion(tx, {
    agentId: definition.id,
    instructions: 'return structured child results',
    modelPolicy: { model: 'fixture' },
  }));
  agentVersionId = version.id;
});

afterAll(async () => db.drop());

async function running(runId: string): Promise<string> {
  const attemptId = newId('att');
  await db.pool.query(
    `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
     VALUES ($1, $2, 1, 'child-result-worker', 'ACTIVE', now() + interval '1 minute')`,
    [attemptId, runId],
  );
  await withTransaction(db.pool, async (tx) => {
    await transitionRun(tx, runId, {
      expectFrom: ['QUEUED'],
      to: 'STARTING',
      event: { type: 'AttemptStarted' },
      attemptId,
      patch: { current_attempt_id: attemptId },
    });
    await transitionRun(tx, runId, {
      expectFrom: ['STARTING'],
      to: 'RUNNING',
      event: { type: 'AttemptStarted' },
      attemptId,
    });
  });
  return attemptId;
}

describe('bounded delegated results and lineage', () => {
  it('selects the latest replacement and returns results, artifacts, evidence, usage, and merge policy', async () => {
    const parent = await withTransaction(db.pool, (tx) => createRun(tx, {
      tenantId: 'default', agentVersionId, goal: 'delegate one subtask',
    }));
    const parentAttempt = await running(parent.id);
    const [originalId] = await withTransaction(db.pool, (tx) => spawnChildren(tx, {
      parentRunId: parent.id,
      attemptId: parentAttempt,
      children: [{ agentVersionId, goal: 'produce a bounded answer', tokenBudget: 100 }],
    }));
    const originalAttempt = await running(originalId!);
    await withTransaction(db.pool, (tx) => transitionRun(tx, originalId!, {
      expectFrom: ['RUNNING'],
      to: 'FAILED',
      event: { type: 'RunFailed', payload: { reason: 'transient' } },
      attemptId: originalAttempt,
      reason: 'transient',
      patch: { tokens_used: '25' },
    }));

    const firstWake = await wakeReadyParents(db.pool, 1);
    expect(firstWake.woken).toEqual([]);
    expect(firstWake.replaced).toHaveLength(1);
    const replacementId = firstWake.replaced[0]!;
    const replacementAttempt = await running(replacementId);
    const bounded = buildBoundedRunResult('completed by replacement', {
      answer: 42,
      confidence: 'high',
    });
    await withTransaction(db.pool, async (tx) => {
      await transitionRun(tx, replacementId, {
        expectFrom: ['RUNNING'],
        to: 'VERIFYING',
        event: { type: 'VerificationStarted' },
        attemptId: replacementAttempt,
      });
      await transitionRun(tx, replacementId, {
        expectFrom: ['VERIFYING'],
        to: 'COMPLETED',
        event: { type: 'RunCompleted' },
        attemptId: replacementAttempt,
        patch: {
          result: bounded.value,
          result_size_bytes: bounded.sizeBytes,
          tokens_used: '40',
        },
      });
    });

    const bytes = Buffer.from('replacement report');
    await withTransaction(db.pool, (tx) => createArtifact(tx, {
      producerRunId: replacementId,
      producerAttemptId: replacementAttempt,
      producerStep: 3,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      mimeType: 'text/plain',
      sizeBytes: bytes.byteLength,
      logicalRole: 'delegated-result',
      sourcePath: 'answer.txt',
      sourceRefs: [{ kind: 'workspace_path', path: 'answer.txt' }],
      verificationRefs: [],
      evidenceRefs: [],
      objectKey: `runs/${replacementId}/artifacts/answer`,
    }));

    const finalWake = await wakeReadyParents(db.pool, 1);
    expect(finalWake).toEqual({ woken: [parent.id], replaced: [] });
    expect(await getRun(db.pool, parent.id)).toMatchObject({ status: 'QUEUED' });

    const lineage = await childLineageProjection(db.pool, parent.id, 'default');
    expect(lineage?.children).toHaveLength(2);
    expect(lineage?.children[0]).toMatchObject({
      runId: originalId,
      rootRunId: originalId,
      selected: false,
      status: 'FAILED',
      terminalReason: 'transient',
      usage: { tokens: '25' },
    });
    expect(lineage?.selected).toEqual([expect.objectContaining({
      runId: replacementId,
      rootRunId: originalId,
      replacesRunId: originalId,
      replacementGeneration: 1,
      selected: true,
      result: bounded.value,
      resultSizeBytes: bounded.sizeBytes,
      usage: { tokens: '40' },
      artifactRefs: [expect.objectContaining({ logicalRole: 'delegated-result' })],
      evidenceRefs: [expect.objectContaining({ type: 'RunCompleted' })],
      workspaceMerge: {
        strategy: 'isolated-no-automatic-merge',
        patchRef: null,
        conflictBehavior: 'parent-must-apply-explicit-patch',
      },
    })]);
    expect(await childLineageProjection(db.pool, parent.id, 'other-tenant')).toBeNull();

    const app = buildServer({
      pool: db.pool,
      cfg: loadConfig({
        ...process.env,
        DATABASE_URL: db.url,
        API_AUTH_TOKEN: 'delegated-results-token',
        RATE_LIMIT_PER_SEC: '0',
      }),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/runs/${parent.id}/children`,
        headers: { authorization: 'Bearer delegated-results-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().selected).toEqual([
        expect.objectContaining({ runId: replacementId, rootRunId: originalId }),
      ]);
    } finally {
      await app.close();
    }

    const resolved = (await listEvents(db.pool, parent.id)).find(
      (event) => event.type === 'ChildrenResolved',
    );
    expect(resolved?.payload.children).toEqual(lineage?.selected);
    expect(JSON.stringify(resolved?.payload)).not.toContain('object_key');
  });
});
