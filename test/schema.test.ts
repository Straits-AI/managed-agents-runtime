import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { newId } from '../src/ids.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

describe('schema', () => {
  it('applies all migrations idempotently', async () => {
    const { rows } = await db.pool.query('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toContain('0001_init.sql');
  });

  it('rejects UPDATE and DELETE on agent_versions', async () => {
    const adId = newId('ad');
    const avId = newId('av');
    await db.pool.query(
      `INSERT INTO agent_definitions (id, name) VALUES ($1, $2)`,
      [adId, `agent-${adId}`],
    );
    await db.pool.query(
      `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
       VALUES ($1, $2, 1, 'do things', '{"model":"test"}')`,
      [avId, adId],
    );

    await expect(
      db.pool.query(`UPDATE agent_versions SET instructions = 'changed' WHERE id = $1`, [avId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query(`DELETE FROM agent_versions WHERE id = $1`, [avId]),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects UPDATE and DELETE on run_events', async () => {
    const adId = newId('ad');
    const avId = newId('av');
    const runId = newId('run');
    await db.pool.query(`INSERT INTO agent_definitions (id, name) VALUES ($1, $2)`, [
      adId,
      `agent-${adId}`,
    ]);
    await db.pool.query(
      `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
       VALUES ($1, $2, 1, 'x', '{}')`,
      [avId, adId],
    );
    await db.pool.query(
      `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
       VALUES ($1, 'default', $2, 'g', 'COMPLETED')`,
      [runId, avId],
    );
    await db.pool.query(
      `INSERT INTO run_events (run_id, seq, type) VALUES ($1, 1, 'RunCreated')`,
      [runId],
    );

    await expect(
      db.pool.query(`UPDATE run_events SET type = 'Altered' WHERE run_id = $1`, [runId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query(`DELETE FROM run_events WHERE run_id = $1`, [runId]),
    ).rejects.toThrow(/immutable/);
  });

  it('enforces unique idempotency keys per run', async () => {
    const adId = newId('ad');
    const avId = newId('av');
    const runId = newId('run');
    const attId = newId('att');
    await db.pool.query(`INSERT INTO agent_definitions (id, name) VALUES ($1, $2)`, [
      adId,
      `agent-${adId}`,
    ]);
    await db.pool.query(
      `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
       VALUES ($1, $2, 1, 'x', '{}')`,
      [avId, adId],
    );
    await db.pool.query(
      `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
       VALUES ($1, 'default', $2, 'g', 'COMPLETED')`,
      [runId, avId],
    );
    await db.pool.query(
      `INSERT INTO run_attempts (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1, $2, 1, 'w1', 'ACTIVE', now() + interval '30 seconds')`,
      [attId, runId],
    );

    const insertReceipt = (id: string) =>
      db.pool.query(
        `INSERT INTO tool_receipts (id, run_id, attempt_id, step, semantic_action,
           request_digest, idempotency_key, status)
         VALUES ($1, $2, $3, 1, 'external.http.post', 'digest', 'key-1', 'PENDING')`,
        [id, runId, attId],
      );

    await insertReceipt(newId('rcpt'));
    await expect(insertReceipt(newId('rcpt'))).rejects.toThrow(/duplicate key/);
  });

  it('rejects a legacy non-terminal run insert that omits admission', async () => {
    const adId = newId('ad');
    const avId = newId('av');
    const runId = newId('run');
    await db.pool.query(`INSERT INTO agent_definitions (id, name) VALUES ($1, $2)`, [
      adId,
      `agent-${adId}`,
    ]);
    await db.pool.query(
      `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
       VALUES ($1, $2, 1, 'x', '{}')`,
      [avId, adId],
    );

    await expect(
      db.pool.query(
        `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
         VALUES ($1, 'default', $2, 'legacy writer', 'CREATED')`,
        [runId, avId],
      ),
    ).rejects.toThrow(/requires an active admission/);
    const { rows } = await db.pool.query('SELECT id FROM runs WHERE id = $1', [runId]);
    expect(rows).toHaveLength(0);
  });

  it('installs the partial model-usage index used during admission', async () => {
    const { rows } = await db.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'run_events_model_usage_created'`,
    );
    expect(rows[0]?.indexdef).toContain('ModelInvocationCompleted');
    expect(rows[0]?.indexdef).toContain('created_at');
  });

  it('installs execution-scoped credential grants and secret-free use receipts', async () => {
    const { rows: migrations } = await db.pool.query<{ name: string }>(
      `SELECT name FROM schema_migrations WHERE name = '0014_execution_credential_grants.sql'`,
    );
    expect(migrations).toHaveLength(1);
    const { rows: receiptColumns } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'credential_use_receipts'`,
    );
    const names = receiptColumns.map((column) => column.column_name);
    expect(names).toContain('idempotency_key');
    expect(names).not.toContain('secret_ct');
    expect(names).not.toContain('iv');
    expect(names).not.toContain('auth_tag');
    const { rows: triggers } = await db.pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'credential_use_receipts'::regclass AND NOT tgisinternal`,
    );
    expect(triggers.map((trigger) => trigger.tgname)).toContain(
      'credential_use_receipts_no_update',
    );
    const { rows: grantTriggers } = await db.pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'credential_grants'::regclass AND NOT tgisinternal`,
    );
    expect(grantTriggers.map((trigger) => trigger.tgname)).toContain(
      'credential_grants_subject_guard',
    );
    const { rows: reauthorizationMigration } = await db.pool.query<{ name: string }>(
      `SELECT name FROM schema_migrations
       WHERE name = '0015_credential_reauthorization_receipts.sql'`,
    );
    expect(reauthorizationMigration).toHaveLength(1);
  });

  it('rejects a ManagedSession pinned to another tenant agent version', async () => {
    const tenantId = newId('tnt');
    const adId = newId('ad');
    const avId = newId('av');
    await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
      tenantId,
      `tenant-${tenantId}`,
    ]);
    await db.pool.query(
      `INSERT INTO agent_definitions (id, tenant_id, name)
       VALUES ($1, 'default', $2)`,
      [adId, `agent-${adId}`],
    );
    await db.pool.query(
      `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
       VALUES ($1, $2, 1, 'x', '{}')`,
      [avId, adId],
    );
    await expect(db.pool.query(
      `INSERT INTO managed_sessions
         (id, tenant_id, principal_id, agent_version_id, objective)
       VALUES ($1, $2, 'principal', $3, 'cross-tenant')`,
      [newId('ses'), tenantId, avId],
    )).rejects.toThrow(/agent version must belong to the same tenant/);
  });
});

describe('tenant-lineage migration', () => {
  it('repairs children created by the historical default-tenant bug before validation', async () => {
    const legacy = await createTestDb({ through: '0010_credentials.sql' });
    try {
      await legacy.pool.query(
        `INSERT INTO tenants (id, name) VALUES ('tenant_upgrade', 'Upgrade tenant')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_definitions (id, tenant_id, name)
         VALUES ('ad_upgrade', 'tenant_upgrade', 'upgrade-agent')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
         VALUES ('av_upgrade', 'ad_upgrade', 1, 'x', '{}')`,
      );
      await legacy.pool.query(
        `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
         VALUES ('run_upgrade_parent', 'tenant_upgrade', 'av_upgrade', 'parent', 'QUEUED')`,
      );
      await legacy.pool.query(
        `INSERT INTO runs
           (id, tenant_id, agent_version_id, parent_run_id, goal, status)
         VALUES
           ('run_upgrade_child', 'default', 'av_upgrade', 'run_upgrade_parent', 'child', 'FAILED'),
           ('run_upgrade_grandchild', 'default', 'av_upgrade', 'run_upgrade_child', 'grandchild', 'FAILED')`,
      );

      await expect(legacy.applyRemainingMigrations()).resolves.toContain(
        '0011_run_tenant_invariants.sql',
      );
      const { rows } = await legacy.pool.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM runs
         WHERE id IN ('run_upgrade_child', 'run_upgrade_grandchild')
         ORDER BY id`,
      );
      expect(rows.map((row) => row.tenant_id)).toEqual([
        'tenant_upgrade',
        'tenant_upgrade',
      ]);
    } finally {
      await legacy.drop();
    }
  });

  it('rejects an ambiguous cross-tenant child instead of rewriting ownership', async () => {
    const legacy = await createTestDb({ through: '0010_credentials.sql' });
    try {
      await legacy.pool.query(
        `INSERT INTO tenants (id, name)
         VALUES ('tenant_owner', 'Owner'), ('tenant_ambiguous', 'Ambiguous')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_definitions (id, tenant_id, name)
         VALUES ('ad_owner', 'tenant_owner', 'owner-agent')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
         VALUES ('av_owner', 'ad_owner', 1, 'x', '{}')`,
      );
      await legacy.pool.query(
        `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
         VALUES ('run_owner_parent', 'tenant_owner', 'av_owner', 'parent', 'QUEUED')`,
      );
      await legacy.pool.query(
        `INSERT INTO runs
           (id, tenant_id, agent_version_id, parent_run_id, goal, status)
         VALUES
           ('run_ambiguous_child', 'tenant_ambiguous', 'av_owner',
            'run_owner_parent', 'ambiguous', 'FAILED')`,
      );

      await expect(legacy.applyRemainingMigrations()).rejects.toThrow(
        /runs_parent_same_tenant/,
      );
      const { rows } = await legacy.pool.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM runs WHERE id = 'run_ambiguous_child'`,
      );
      expect(rows[0]?.tenant_id).toBe('tenant_ambiguous');
    } finally {
      await legacy.drop();
    }
  });
});

describe('managed-session migration', () => {
  it('upgrades historical Runs without inventing ManagedSessions', async () => {
    const legacy = await createTestDb({ through: '0018_checkpoint_envelopes.sql' });
    try {
      await legacy.pool.query(
        `INSERT INTO agent_definitions (id, name) VALUES ('ad_session_upgrade', 'session-upgrade')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
         VALUES ('av_session_upgrade', 'ad_session_upgrade', 1, 'x', '{}')`,
      );
      await legacy.pool.query(
        `INSERT INTO runs (id, tenant_id, agent_version_id, goal, status)
         VALUES ('run_session_upgrade', 'default', 'av_session_upgrade', 'historical', 'COMPLETED')`,
      );

      await expect(legacy.applyRemainingMigrations()).resolves.toContain(
        '0019_managed_sessions.sql',
      );
      const { rows: runs } = await legacy.pool.query<{ managed_session_id: string | null }>(
        `SELECT managed_session_id FROM runs WHERE id = 'run_session_upgrade'`,
      );
      const { rows: sessions } = await legacy.pool.query('SELECT id FROM managed_sessions');
      expect(runs[0]?.managed_session_id).toBeNull();
      expect(sessions).toHaveLength(0);
    } finally {
      await legacy.drop();
    }
  });
});

describe('knowledge-binding migration', () => {
  it('adds tenant-scoped logical bindings without changing existing agent versions', async () => {
    const legacy = await createTestDb({ through: '0011_run_tenant_invariants.sql' });
    try {
      await legacy.pool.query(
        `INSERT INTO tenants (id, name) VALUES ('tenant_knowledge_upgrade', 'Knowledge upgrade')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_definitions (id, tenant_id, name)
         VALUES ('ad_knowledge_upgrade', 'tenant_knowledge_upgrade', 'legacy-agent')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_versions
           (id, agent_id, version, instructions, model_policy, knowledge_config)
         VALUES ('av_knowledge_upgrade', 'ad_knowledge_upgrade', 1, 'legacy', '{}',
                 '{"knowledgeBaseId":"handbook"}')`,
      );
      await expect(legacy.applyRemainingMigrations()).resolves.toContain(
        '0012_knowledge_bindings.sql',
      );
      const { rows: versions } = await legacy.pool.query<{
        knowledge_config: Record<string, string>;
      }>(
        `SELECT knowledge_config FROM agent_versions WHERE id = 'av_knowledge_upgrade'`,
      );
      expect(versions[0]?.knowledge_config).toEqual({ knowledgeBaseId: 'handbook' });
      await legacy.pool.query(
        `INSERT INTO knowledge_bindings
           (id, tenant_id, name, provider, provider_project, provider_collection)
         VALUES ('kbnd_upgrade', 'tenant_knowledge_upgrade', 'handbook',
                 'agentkit', 'project-a', 'collection-a')`,
      );
      await expect(
        legacy.pool.query(
          `INSERT INTO knowledge_bindings
             (id, tenant_id, name, provider, provider_project, provider_collection)
           VALUES ('kbnd_duplicate', 'tenant_knowledge_upgrade', 'handbook',
                   'agentkit', 'project-b', 'collection-b')`,
        ),
      ).rejects.toThrow(/duplicate key/);
    } finally {
      await legacy.drop();
    }
  });
});

describe('run-admission migration', () => {
  it('backfills only non-terminal runs with constrained reservations', async () => {
    const legacy = await createTestDb({ through: '0012_knowledge_bindings.sql' });
    try {
      await legacy.pool.query(
        `INSERT INTO tenants (id, name, daily_token_budget)
         VALUES ('tenant_admission_upgrade', 'Admission upgrade', 500)`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_definitions (id, tenant_id, name)
         VALUES ('ad_admission_upgrade', 'tenant_admission_upgrade', 'admission-agent')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
         VALUES ('av_admission_upgrade', 'ad_admission_upgrade', 1, 'x', '{}')`,
      );
      await legacy.pool.query(
        `INSERT INTO runs
           (id, tenant_id, agent_version_id, goal, status, token_budget)
         VALUES
           ('run_admission_active_a', 'tenant_admission_upgrade', 'av_admission_upgrade',
            'active-a', 'QUEUED', 200),
           ('run_admission_active_b', 'tenant_admission_upgrade', 'av_admission_upgrade',
            'active-b', 'WAITING_SIGNAL', 300),
           ('run_admission_terminal', 'tenant_admission_upgrade', 'av_admission_upgrade',
            'terminal', 'COMPLETED', 456)`,
      );

      await expect(legacy.applyRemainingMigrations()).resolves.toContain(
        '0013_run_admissions.sql',
      );
      const { rows } = await legacy.pool.query<{
        run_id: string;
        kind: string;
        status: string;
        reserved_tokens: string;
        token_budget: string;
      }>(
         `SELECT a.run_id, a.kind, a.status, a.reserved_tokens, r.token_budget
         FROM run_admissions a JOIN runs r ON r.id = a.run_id
         WHERE a.tenant_id = 'tenant_admission_upgrade' ORDER BY a.run_id`,
      );
      expect(rows).toEqual([
        {
          run_id: 'run_admission_active_a',
          kind: 'direct',
          status: 'active',
          reserved_tokens: '200',
          token_budget: '200',
        },
        {
          run_id: 'run_admission_active_b',
          kind: 'direct',
          status: 'active',
          reserved_tokens: '300',
          token_budget: '300',
        },
      ]);
      await expect(
        legacy.pool.query(
          `INSERT INTO run_admissions
             (run_id, tenant_id, kind, reserved_tokens)
           VALUES ('run_admission_terminal', 'tenant_admission_upgrade', 'unknown', 0)`,
        ),
      ).rejects.toThrow(/check constraint/);
      await expect(
        legacy.pool.query(
          `INSERT INTO run_admissions
             (run_id, tenant_id, kind, reserved_tokens)
           VALUES ('run_admission_terminal', 'default', 'direct', 0)`,
        ),
      ).rejects.toThrow(/foreign key/);
    } finally {
      await legacy.drop();
    }
  });

  it('fails safely when legacy active budgets cannot fit the tenant quota', async () => {
    const legacy = await createTestDb({ through: '0012_knowledge_bindings.sql' });
    try {
      await legacy.pool.query(
        `INSERT INTO tenants (id, name, daily_token_budget)
         VALUES ('tenant_admission_unsafe', 'Unsafe admission upgrade', 500)`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_definitions (id, tenant_id, name)
         VALUES ('ad_admission_unsafe', 'tenant_admission_unsafe', 'unsafe-agent')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
         VALUES ('av_admission_unsafe', 'ad_admission_unsafe', 1, 'x', '{}')`,
      );
      await legacy.pool.query(
        `INSERT INTO runs
           (id, tenant_id, agent_version_id, goal, status, token_budget)
         VALUES
           ('run_admission_unsafe_a', 'tenant_admission_unsafe', 'av_admission_unsafe',
            'a', 'QUEUED', 300),
           ('run_admission_unsafe_b', 'tenant_admission_unsafe', 'av_admission_unsafe',
            'b', 'QUEUED', 300)`,
      );
      await expect(legacy.applyRemainingMigrations()).rejects.toThrow(
        /finite aggregate token budgets within the tenant quota/,
      );
      const { rows } = await legacy.pool.query<{ exists: boolean }>(
        `SELECT to_regclass('public.run_admissions') IS NOT NULL AS exists`,
      );
      expect(rows[0]?.exists).toBe(false);
    } finally {
      await legacy.drop();
    }
  });

  it('includes tokens already consumed today when validating legacy capacity', async () => {
    const legacy = await createTestDb({ through: '0012_knowledge_bindings.sql' });
    try {
      await legacy.pool.query(
        `INSERT INTO tenants (id, name, daily_token_budget)
         VALUES ('tenant_admission_spent', 'Spent admission upgrade', 500)`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_definitions (id, tenant_id, name)
         VALUES ('ad_admission_spent', 'tenant_admission_spent', 'spent-agent')`,
      );
      await legacy.pool.query(
        `INSERT INTO agent_versions (id, agent_id, version, instructions, model_policy)
         VALUES ('av_admission_spent', 'ad_admission_spent', 1, 'x', '{}')`,
      );
      await legacy.pool.query(
        `INSERT INTO runs
           (id, tenant_id, agent_version_id, goal, status, token_budget, tokens_used)
         VALUES
           ('run_admission_spent_terminal', 'tenant_admission_spent',
            'av_admission_spent', 'spent', 'COMPLETED', 400, 400),
           ('run_admission_spent_active', 'tenant_admission_spent',
            'av_admission_spent', 'active', 'QUEUED', 300, 0)`,
      );
      await legacy.pool.query(
        `INSERT INTO run_events (run_id, seq, type, payload)
         VALUES ('run_admission_spent_terminal', 1, 'ModelInvocationCompleted',
                 '{"usage":{"inputTokens":400,"outputTokens":0}}')`,
      );

      await expect(legacy.applyRemainingMigrations()).rejects.toThrow(
        /finite aggregate token budgets within the tenant quota/,
      );
    } finally {
      await legacy.drop();
    }
  });
});
