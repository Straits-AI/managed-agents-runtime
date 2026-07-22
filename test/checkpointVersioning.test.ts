import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from './helpers/db.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { withTransaction } from '../src/db/tx.js';
import { newId } from '../src/ids.js';
import { insertCheckpoint, latestCheckpoint } from '../src/store/checkpoints.js';
import {
  createCheckpointEnvelope,
  decodeCheckpointEnvelope,
  UnsupportedCheckpointVersionError,
} from '../src/core/checkpoints.js';
import { migrate } from '../src/db/migrate.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

let db: TestDb;
let runId: string;
let attemptId: string;

beforeAll(async () => {
  db = await createTestDb();
  const definition = await createAgentDefinition(db.pool, { name: 'checkpoint-contract' });
  const version = await withTransaction(db.pool, (tx) => createAgentVersion(tx, {
    agentId: definition.id,
    instructions: 'checkpoint safely',
    modelPolicy: { model: 'fixture' },
  }));
  const run = await withTransaction(db.pool, (tx) => createRun(tx, {
    tenantId: 'default', agentVersionId: version.id, goal: 'persist commitments',
  }));
  runId = run.id;
  attemptId = newId('att');
  await db.pool.query(
    `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
     VALUES ($1, $2, 1, 'checkpoint-worker', 'ACTIVE', now() + interval '1 minute')`,
    [attemptId, runId],
  );
});

afterAll(async () => db.drop());

describe('versioned checkpoint envelopes', () => {
  it('upgrades the supported v1 fixture and restores a complete v2 fixture', async () => {
    const upgraded = decodeCheckpointEnvelope(1, {
      step: 3,
      transcriptTosKey: 'runs/legacy/transcript.json',
      pendingToolCall: { id: 'call-1', name: 'wait_for_signal', arguments: { name: 'ready' } },
    });
    expect(upgraded).toMatchObject({
      schemaVersion: 2,
      step: 3,
      commitments: { awaitedSignal: null, activeChildRunIds: [] },
      references: { childRunIds: [], artifactIds: [] },
      contextSelection: { strategyVersion: 'context-compiler/v1' },
    });

    const envelope = createCheckpointEnvelope({
      step: 8,
      transcriptTosKey: `runs/${runId}/transcripts/8.json`,
      pendingToolCall: { id: 'call-8', name: 'delegate', arguments: { subtasks: [] } },
      commitments: {
        awaitedSignal: 'approval-result',
        pendingApprovalIds: ['apr_1'],
        activeChildRunIds: ['run_child_active'],
        pendingWork: {
          active: ['merge child output'],
          blocked: [{ item: 'publish', reason: 'approval pending' }],
          remaining: ['verify artifact'],
        },
      },
      references: {
        childRunIds: ['run_child_failed', 'run_child_active'],
        artifactIds: ['art_report'],
        evidence: [{ runId, eventSeq: '17' }],
      },
      contextSelection: {
        strategyVersion: 'context-compiler/v1',
        transcriptTailLimit: 60,
        transcriptMessagesAvailable: 74,
        transcriptMessagesSelected: 60,
        memoryIds: ['mem_policy'],
        userMessageCount: 2,
        approvalOutcomeCount: 1,
        skillRefs: ['review@1.0.0'],
      },
    });
    await withTransaction(db.pool, (tx) => insertCheckpoint(tx, {
      runId,
      attemptId,
      eventSeq: 17n,
      progress: { active: ['merge child output'], remaining: ['verify artifact'] },
      agentState: envelope,
    }));
    const restored = await latestCheckpoint(db.pool, runId);
    expect(restored?.schema_version).toBe(2);
    expect(restored?.agent_state).toEqual(envelope);
  });

  it('fails closed for unsupported versions, secret fields, and signed transport URLs', async () => {
    expect(() => decodeCheckpointEnvelope(99, {})).toThrow(UnsupportedCheckpointVersionError);
    expect(() => createCheckpointEnvelope({
      step: 0,
      pendingToolCall: {
        id: 'secret-call',
        name: 'external_http_request',
        arguments: { authorization: 'Bearer must-not-persist' },
      },
    })).toThrow(/forbidden secret field/);
    expect(() => createCheckpointEnvelope({
      step: 0,
      pendingToolCall: {
        id: 'neutral-key-secret-call',
        name: 'external_http_request',
        arguments: { body: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' },
      },
    })).toThrow(/credential-like value/);
    expect(() => createCheckpointEnvelope({
      step: 0,
      pendingToolCall: {
        id: 'neutral-key-bearer-call',
        name: 'external_http_request',
        arguments: { value: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      },
    })).toThrow(/credential-like value/);
    expect(() => createCheckpointEnvelope({
      step: 0,
      contextSummary: 'resume at https://example.test/file?X-Amz-Signature=secret',
    })).toThrow(/signed or credential-bearing URL/);
    expect(() => createCheckpointEnvelope({
      step: 0,
      contextSummary: 'resume at https://blob.example.test/file?sv=2025-01-05&sig=secret',
    })).toThrow(/signed or credential-bearing URL/);
    expect(() => decodeCheckpointEnvelope(2, {
      ...createCheckpointEnvelope({ step: 0 }),
      commitments: { awaitedSignal: null, pendingApprovalIds: 'not-an-array' },
    })).toThrow(/pendingApprovalIds must be an array/);
    expect(() => decodeCheckpointEnvelope(2, {
      ...createCheckpointEnvelope({ step: 0 }),
      contextSelection: {
        ...createCheckpointEnvelope({ step: 0 }).contextSelection,
        transcriptMessagesAvailable: 1,
        transcriptMessagesSelected: 2,
      },
    })).toThrow(/transcript selection is inconsistent/);

    await db.pool.query(
      `INSERT INTO checkpoints
         (id, run_id, attempt_id, event_seq, progress, agent_state, schema_version)
       VALUES ($1, $2, $3, 999, '{}', '{"schemaVersion":99}', 99)`,
      [newId('ckpt'), runId, attemptId],
    );
    await expect(latestCheckpoint(db.pool, runId)).rejects.toThrow(
      UnsupportedCheckpointVersionError,
    );
  });
});

describe('interrupted checkpoint schema upgrade', () => {
  it('restores an unmigrated v1 row after migration and writes v2 without rewriting history', async () => {
    const legacy = await createTestDb({ through: '0017_delegated_results.sql' });
    try {
      await legacy.pool.query(
        `INSERT INTO agent_definitions (id, tenant_id, name)
         VALUES ('agt_ckpt_upgrade', 'default', 'checkpoint-upgrade')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
         VALUES ('av_ckpt_upgrade', 'agt_ckpt_upgrade', 1, 'legacy', '{"model":"none"}')`,
      );
      await legacy.pool.query(
        `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
         VALUES ('run_ckpt_upgrade', 'default', 'av_ckpt_upgrade', 'upgrade', 'COMPLETED')`,
      );
      await legacy.pool.query(
        `INSERT INTO run_attempts
           (id, run_id, attempt_no, worker_id, state, lease_expires_at)
         VALUES ('att_ckpt_upgrade', 'run_ckpt_upgrade', 1, 'legacy', 'EXITED', now())`,
      );
      await legacy.pool.query(
        `INSERT INTO checkpoints
           (id, run_id, attempt_id, event_seq, progress, agent_state)
         VALUES ('ckpt_legacy', 'run_ckpt_upgrade', 'att_ckpt_upgrade', 4, '{}',
                 '{"step":4,"contextSummary":"legacy summary"}')`,
      );

      await expect(migrate(
        legacy.pool,
        join(FIXTURES, 'checkpoint-interrupted-migration'),
      )).rejects.toThrow(/0018_checkpoint_envelopes.sql.*division by zero/);
      const { rows: rolledBackColumns } = await legacy.pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'checkpoints' AND column_name = 'schema_version'`,
      );
      expect(rolledBackColumns).toHaveLength(0);
      const { rows: rolledBackMigrations } = await legacy.pool.query(
        `SELECT 1 FROM schema_migrations WHERE name = '0018_checkpoint_envelopes.sql'`,
      );
      expect(rolledBackMigrations).toHaveLength(0);

      expect(await legacy.applyRemainingMigrations()).toContain('0018_checkpoint_envelopes.sql');
      const restored = await latestCheckpoint(legacy.pool, 'run_ckpt_upgrade');
      expect(restored).toMatchObject({
        id: 'ckpt_legacy',
        schema_version: 1,
        agent_state: { schemaVersion: 2, step: 4, contextSummary: 'legacy summary' },
      });
      await withTransaction(legacy.pool, (tx) => insertCheckpoint(tx, {
        runId: 'run_ckpt_upgrade',
        attemptId: 'att_ckpt_upgrade',
        eventSeq: 5n,
        progress: {},
        agentState: createCheckpointEnvelope({ step: 5 }),
      }));
      const versions = await legacy.pool.query<{ schema_version: number }>(
        'SELECT schema_version FROM checkpoints ORDER BY event_seq',
      );
      expect(versions.rows.map((row) => row.schema_version)).toEqual([1, 2]);
    } finally {
      await legacy.drop();
    }
  });
});
