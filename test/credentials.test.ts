import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createTestDb, type TestDb } from './helpers/db.js';
import { createTenant } from '../src/store/tenants.js';
import {
  createCredential,
  createCredentialGrant,
  consumeCredential,
  listCredentials,
  listCredentialGrants,
  listCredentialUseReceipts,
  revokeCredentialGrant,
  revokeCredential,
} from '../src/store/credentials.js';
import { createAgentDefinition, createAgentVersion } from '../src/store/agents.js';
import { createRun } from '../src/store/runs.js';
import { withTransaction } from '../src/db/tx.js';
import { newId } from '../src/ids.js';
import { CredentialBroker } from '../src/providers/credentialBroker.js';
import { LocalCipher } from '../src/providers/secretCipher.js';
import type { SecretCipher } from '../src/providers/secretCipher.js';
import { encryptSecret, decryptSecret, loadKey } from '../src/crypto.js';

let db: TestDb;
let tenantId: string;
const key = randomBytes(32);
const cipher = new LocalCipher(key);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  db = await createTestDb();
  tenantId = (await createTenant(db.pool, { name: 'Cred Tenant' })).id;
});
afterAll(async () => {
  await db.drop();
});

describe('secret encryption', () => {
  it('round-trips AES-256-GCM and rejects tampering / bad keys', () => {
    const sealed = encryptSecret('ghp_supersecret', key);
    expect(sealed.ct).not.toContain('supersecret');
    expect(decryptSecret(sealed, key)).toBe('ghp_supersecret');
    // Wrong key fails the auth tag.
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow();
    // Tampered ciphertext fails the auth tag.
    expect(() => decryptSecret({ ...sealed, tag: Buffer.alloc(16).toString('base64') }, key)).toThrow();
    expect(() => loadKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('credential broker', () => {
  async function execution(
    name: string,
    options: { tenantId?: string; parentRunId?: string; forkedFromRunId?: string; agentVersionId?: string } = {},
  ) {
    const t = options.tenantId ?? (await createTenant(db.pool, { name })).id;
    let agentVersionId = options.agentVersionId;
    if (!agentVersionId) {
      const agent = await createAgentDefinition(db.pool, { name: `${name}-agent`, tenantId: t });
      agentVersionId = (
        await withTransaction(db.pool, (tx) =>
          createAgentVersion(tx, {
            agentId: agent.id,
            instructions: 'credential test',
            modelPolicy: { model: 'none' },
          }),
        )
      ).id;
    }
    const run = await withTransaction(db.pool, (tx) =>
      createRun(tx, {
        tenantId: t,
        agentVersionId,
        goal: name,
        parentRunId: options.parentRunId,
        forkedFromRunId: options.forkedFromRunId,
      }),
    );
    const attemptId = newId('att');
    await db.pool.query(
      `INSERT INTO run_attempts
         (id, run_id, attempt_no, worker_id, state, lease_expires_at)
       VALUES ($1,$2,1,'credential-test','ACTIVE',now() + interval '5 minutes')`,
      [attemptId, run.id],
    );
    await db.pool.query(
      `UPDATE runs SET status = 'RUNNING', current_attempt_id = $2 WHERE id = $1`,
      [run.id, attemptId],
    );
    return { tenantId: t, agentVersionId, run, attemptId };
  }

  const request = (
    subject: { tenantId: string; run: { id: string }; attemptId: string },
    key = newId('cuse'),
  ) => ({
    tenantId: subject.tenantId,
    runId: subject.run.id,
    attemptId: subject.attemptId,
    caller: 'http',
    purpose: 'http.request',
    action: 'external.http.request',
    resource: 'https://api.github.com',
    idempotencyKey: key,
  });

  async function seed(over: Partial<Parameters<typeof createCredential>[1]> = {}) {
    return createCredential(db.pool, {
      tenantId,
      name: 'github',
      action: 'external.http.request',
      resource: 'https://api.github.com',
      headerName: 'Authorization',
      secret: 'Bearer ghp_token',
      cipher,
      ...over,
    });
  }

  it('denies a tenant credential when no execution-scoped grant exists', async () => {
    const subject = await execution('grant-required');
    await createCredential(db.pool, {
      tenantId: subject.tenantId,
      name: 'gh',
      action: 'external.http.request',
      resource: 'https://api.github.com',
      headerName: 'Authorization',
      secret: 'Bearer must-not-release',
      cipher,
    });
    const broker = new CredentialBroker(db.pool, cipher);

    expect(
      await broker.resolve({
        ...request(subject),
      }),
    ).toBeNull();
  });

  it('resolves and injects the header for a matching scope, consuming a use', async () => {
    const subject = await execution('match');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: 'external.http.request',
      resource: 'https://api.github.com', headerName: 'Authorization',
      secret: 'Bearer ghp_token', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId,
      credentialId: credential.id,
      agentVersionId: subject.agentVersionId,
      runId: subject.run.id,
      caller: 'http', purpose: 'http.request', action: 'external.http.request',
      resource: 'https://api.github.com', maxUses: 2,
    });
    const broker = new CredentialBroker(db.pool, cipher);
    const got = await broker.resolve(request(subject, 'first'));
    expect(got).toEqual({ headerName: 'Authorization', headerValue: 'Bearer ghp_token' });
    // Second use ok, third denied (max_uses=2).
    expect(await broker.resolve(request(subject, 'second'))).not.toBeNull();
    expect(await broker.resolve(request(subject, 'third'))).toBeNull();
  });

  it('does not release across tenants, callers, purposes, resources, or actions', async () => {
    const subject = await execution('scoped');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: 'external.http.request',
      resource: 'https://api.github.com', headerName: 'Authorization', secret: 's', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: 'http', purpose: 'http.request', action: 'external.http.request',
      resource: 'https://api.github.com',
    });
    const broker = new CredentialBroker(db.pool, cipher);
    expect(await broker.resolve({ ...request(subject), tenantId })).toBeNull();
    expect(await broker.resolve({ ...request(subject), caller: 'mcp' })).toBeNull();
    expect(await broker.resolve({ ...request(subject), purpose: 'unrelated' })).toBeNull();
    expect(await broker.resolve({ ...request(subject), resource: 'https://evil.com' })).toBeNull();
    expect(await broker.resolve({ ...request(subject), action: 'external.http.get' })).toBeNull();
  });

  it('requires the current live attempt on a running execution', async () => {
    const stale = await execution('stale-attempt');
    const credential = await createCredential(db.pool, {
      tenantId: stale.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'live-only', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: stale.tenantId, credentialId: credential.id,
      agentVersionId: stale.agentVersionId, runId: stale.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
    });
    const broker = new CredentialBroker(db.pool, cipher);
    await db.pool.query(`UPDATE run_attempts SET state = 'ORPHANED' WHERE id = $1`, [stale.attemptId]);
    expect(await broker.resolve(request(stale, 'stale'))).toBeNull();

    const terminal = await execution('terminal-run');
    const terminalCredential = await createCredential(db.pool, {
      tenantId: terminal.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'running-only', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: terminal.tenantId, credentialId: terminalCredential.id,
      agentVersionId: terminal.agentVersionId, runId: terminal.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
    });
    await db.pool.query(`UPDATE runs SET status = 'COMPLETED' WHERE id = $1`, [terminal.run.id]);
    expect(await broker.resolve(request(terminal, 'terminal'))).toBeNull();

    const missingAttempt = request(terminal, 'missing-attempt') as Partial<
      Parameters<typeof consumeCredential>[1]
    >;
    delete missingAttempt.attemptId;
    expect(
      await consumeCredential(
        db.pool,
        missingAttempt as Parameters<typeof consumeCredential>[1],
        cipher,
      ),
    ).toBeNull();
  });

  it('does not release expired credentials', async () => {
    const subject = await execution('expired');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: 'external.http.request', resource: '*',
      headerName: 'Authorization', secret: 's', cipher,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: 'http', purpose: 'http.request', action: 'external.http.request', resource: '*',
    });
    const broker = new CredentialBroker(db.pool, cipher);
    expect(
      await consumeCredential(
        db.pool,
        { ...request(subject), resource: 'https://x.com' },
        cipher,
      ),
    ).toBeNull();
    expect(await broker.resolve({ ...request(subject), resource: 'https://x.com' })).toBeNull();
  });

  it('rejects mismatched execution subjects and expired grants', async () => {
    const subject = await execution('grant-subject');
    const other = await execution('other-subject', { tenantId: subject.tenantId });
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'scoped', cipher,
    });
    await expect(
      createCredentialGrant(db.pool, {
        tenantId: subject.tenantId, credentialId: credential.id,
        agentVersionId: other.agentVersionId, runId: subject.run.id,
        caller: '*', purpose: '*', action: '*', resource: '*',
      }),
    ).rejects.toThrow(/does not belong/);
    await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await new CredentialBroker(db.pool, cipher).resolve(request(subject))).toBeNull();
    expect(JSON.stringify(await listCredentialGrants(db.pool, subject.tenantId))).not.toContain('scoped');
  });

  it('never exposes the secret ciphertext when listing', async () => {
    await seed();
    const rows = await listCredentials(db.pool, tenantId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).not.toHaveProperty('secret_ct');
      expect(r).not.toHaveProperty('iv');
      expect(r).not.toHaveProperty('auth_tag');
    }
  });

  it('revoked credentials stop resolving', async () => {
    const subject = await execution('revoke');
    const { id } = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: 'external.http.request', resource: '*',
      headerName: 'Authorization', secret: 's', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: 'http', purpose: 'http.request', action: 'external.http.request', resource: '*',
    });
    const broker = new CredentialBroker(db.pool, cipher);
    expect(await broker.resolve({ ...request(subject, 'before-revoke'), resource: 'https://x.com' })).not.toBeNull();
    expect(await revokeCredential(db.pool, id, subject.tenantId)).toBe(true);
    expect(await broker.resolve({ ...request(subject, 'credential-revoked'), resource: 'https://x.com' })).toBeNull();
    const secondCredential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'second', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'second', cipher,
    });
    const secondGrant = await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: secondCredential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
    });
    expect(await revokeCredentialGrant(db.pool, secondGrant.id, subject.tenantId)).toBe(true);
    expect(await broker.resolve({ ...request(subject, 'grant-revoked'), resource: 'https://x.com' })).toBeNull();
    await expect(
      db.pool.query(`UPDATE credential_grants SET status = 'active' WHERE id = $1`, [secondGrant.id]),
    ).rejects.toThrow(/irreversible/);
  });

  it('atomically enforces a one-use grant under concurrent resolution', async () => {
    const subject = await execution('concurrent');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'only-once', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*', maxUses: 1,
    });
    const broker = new CredentialBroker(db.pool, cipher);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => broker.resolve(request(subject, `race-${index}`))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await listCredentialUseReceipts(db.pool, subject.tenantId)).toHaveLength(1);
  });

  it('fences cancellation while a credential consumption is in flight', async () => {
    const subject = await execution('cancellation-fence');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'fenced', cipher,
    });
    const grant = await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
    });
    const blocker = await db.pool.connect();
    const canceller = await db.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(`SELECT id FROM credential_grants WHERE id = $1 FOR UPDATE`, [grant.id]);
    const resolution = new CredentialBroker(db.pool, cipher).resolve(
      request(subject, 'cancel-race'),
    );
    await delay(75);
    let cancellationBlocked = false;
    try {
      await canceller.query('BEGIN');
      await canceller.query(`SET LOCAL lock_timeout = '75ms'`);
      await canceller.query(`UPDATE runs SET status = 'CANCELLED' WHERE id = $1`, [subject.run.id]);
    } catch (error) {
      cancellationBlocked = /lock timeout/i.test(String(error));
    } finally {
      await canceller.query('ROLLBACK');
      await blocker.query('COMMIT');
      blocker.release();
      canceller.release();
    }
    expect(cancellationBlocked).toBe(true);
    expect(await resolution).not.toBeNull();
  });

  it('holds the execution fence until slow secret decryption finishes', async () => {
    const subject = await execution('decryption-fence');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'slow-secret', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
    });
    let signalOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => { signalOpenStarted = resolve; });
    let releaseOpen!: () => void;
    const continueOpen = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const slowCipher: SecretCipher = {
      seal: (plaintext) => cipher.seal(plaintext),
      open: async (sealed) => {
        signalOpenStarted();
        await continueOpen;
        return cipher.open(sealed);
      },
    };
    const resolution = new CredentialBroker(db.pool, slowCipher).resolve(
      request(subject, 'decrypt-race'),
    );
    await openStarted;
    const canceller = await db.pool.connect();
    let cancellationBlocked = false;
    try {
      await canceller.query('BEGIN');
      await canceller.query(`SET LOCAL lock_timeout = '75ms'`);
      await canceller.query(`UPDATE runs SET status = 'CANCELLED' WHERE id = $1`, [subject.run.id]);
    } catch (error) {
      cancellationBlocked = /lock timeout/i.test(String(error));
    } finally {
      await canceller.query('ROLLBACK');
      canceller.release();
      releaseOpen();
    }
    expect(cancellationBlocked).toBe(true);
    expect(await resolution).toEqual({
      headerName: 'Authorization',
      headerValue: 'slow-secret',
    });
  });

  it('rejects policy that expires during slow secret decryption', async () => {
    const subject = await execution('decryption-expiry');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'too-late', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
      expiresAt: new Date(Date.now() + 150).toISOString(),
    });
    let signalOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => { signalOpenStarted = resolve; });
    let releaseOpen!: () => void;
    const continueOpen = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const slowCipher: SecretCipher = {
      seal: (plaintext) => cipher.seal(plaintext),
      open: async (sealed) => {
        signalOpenStarted();
        await continueOpen;
        return cipher.open(sealed);
      },
    };
    const resolution = new CredentialBroker(db.pool, slowCipher).resolve(
      request(subject, 'decrypt-expiry'),
    );
    await openStarted;
    await delay(225);
    releaseOpen();
    expect(await resolution).toBeNull();
    expect(await listCredentialUseReceipts(db.pool, subject.tenantId)).toEqual([]);
  });

  it('uses the database clock for credential and grant expiry', async () => {
    const subject = await execution('database-clock');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'db-expired', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
    });
    await db.pool.query(
      `UPDATE credentials SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [credential.id],
    );
    const grantSubject = await execution('database-clock-grant');
    const grantCredential = await createCredential(db.pool, {
      tenantId: grantSubject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'grant-db-expired', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: grantSubject.tenantId, credentialId: grantCredential.id,
      agentVersionId: grantSubject.agentVersionId, runId: grantSubject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 60_000));
    try {
      expect(
        await new CredentialBroker(db.pool, cipher).resolve(request(subject, 'db-clock')),
      ).toBeNull();
      expect(
        await new CredentialBroker(db.pool, cipher).resolve(
          request(grantSubject, 'db-clock-grant'),
        ),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks wall-clock lease expiry after waiting for policy locks', async () => {
    const subject = await execution('lease-expiry-fence');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'expired-while-waiting', cipher,
    });
    const grant = await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
    });
    await db.pool.query(
      `UPDATE run_attempts SET lease_expires_at = clock_timestamp() + interval '100 milliseconds'
       WHERE id = $1`,
      [subject.attemptId],
    );
    const blocker = await db.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(`SELECT id FROM credential_grants WHERE id = $1 FOR UPDATE`, [grant.id]);
    const resolution = new CredentialBroker(db.pool, cipher).resolve(
      request(subject, 'lease-race'),
    );
    await delay(175);
    await blocker.query('COMMIT');
    blocker.release();
    expect(await resolution).toBeNull();
  });

  it('denies child and fork inheritance by default and permits each only explicitly', async () => {
    const parent = await execution('lineage');
    const child = await execution('child', {
      tenantId: parent.tenantId, agentVersionId: parent.agentVersionId, parentRunId: parent.run.id,
    });
    const fork = await execution('fork', {
      tenantId: parent.tenantId, agentVersionId: parent.agentVersionId, forkedFromRunId: parent.run.id,
    });
    const credential = await createCredential(db.pool, {
      tenantId: parent.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'lineage', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: parent.tenantId, credentialId: credential.id,
      agentVersionId: parent.agentVersionId, runId: parent.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
    });
    const broker = new CredentialBroker(db.pool, cipher);
    expect(await broker.resolve(request(child, 'child-denied'))).toBeNull();
    expect(await broker.resolve(request(fork, 'fork-denied'))).toBeNull();
    await createCredentialGrant(db.pool, {
      tenantId: parent.tenantId, credentialId: credential.id,
      agentVersionId: parent.agentVersionId, runId: parent.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*', allowDelegatedRuns: true,
    });
    expect(await broker.resolve(request(child, 'child-allowed'))).not.toBeNull();
    expect(await broker.resolve(request(fork, 'fork-still-denied'))).toBeNull();
    await createCredentialGrant(db.pool, {
      tenantId: parent.tenantId, credentialId: credential.id,
      agentVersionId: parent.agentVersionId, runId: parent.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*', allowForks: true,
    });
    expect(await broker.resolve(request(fork, 'fork-allowed'))).not.toBeNull();
  });

  it('requires a matching approved action when the grant is approval-gated', async () => {
    const subject = await execution('approval');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'approved', cipher,
    });
    await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*', requiresApproval: true,
    });
    const broker = new CredentialBroker(db.pool, cipher);
    expect(await broker.resolve(request(subject, 'no-approval'))).toBeNull();
    const approvalId = newId('apr');
    const approvedRequest = request(subject, 'approved');
    await db.pool.query(
      `INSERT INTO approvals (id, run_id, action, status, decision_by, decided_at)
       VALUES ($1,$2,$3,'APPROVED','reviewer',now())`,
      [approvalId, subject.run.id, JSON.stringify({
        action: 'external.http.request', resource: 'https://api.github.com',
        arguments: { __idemKey: approvedRequest.idempotencyKey }, risk: 'external_write',
      })],
    );
    expect(await broker.resolve({ ...approvedRequest, approvalId })).not.toBeNull();
    expect(
      await broker.resolve({ ...request(subject, 'different-request'), approvalId }),
    ).toBeNull();
    expect(await broker.resolve({ ...request(subject, 'wrong-action'), approvalId, resource: 'https://evil.com' })).toBeNull();
  });

  it('records a distinct immutable receipt when a logical use is reauthorized', async () => {
    const subject = await execution('approval-reauthorization');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'reauthorized', cipher,
    });
    const grant = await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*',
      requiresApproval: true, maxUses: 1,
    });
    const approvedRequest = request(subject, 'reauthorized-logical-use');
    const approvalIds = [newId('apr'), newId('apr')];
    for (const approvalId of approvalIds) {
      await db.pool.query(
        `INSERT INTO approvals (id, run_id, action, status, decision_by, decided_at)
         VALUES ($1,$2,$3,'APPROVED','reviewer',clock_timestamp())`,
        [approvalId, subject.run.id, JSON.stringify({
          action: approvedRequest.action,
          resource: approvedRequest.resource,
          arguments: { __idemKey: approvedRequest.idempotencyKey },
          risk: 'external_write',
        })],
      );
    }
    const broker = new CredentialBroker(db.pool, cipher);
    expect(await broker.resolve({ ...approvedRequest, approvalId: approvalIds[0] }))
      .not.toBeNull();
    expect(await broker.resolve({ ...approvedRequest, approvalId: approvalIds[1] }))
      .not.toBeNull();
    const receipts = (await listCredentialUseReceipts(db.pool, subject.tenantId))
      .filter((receipt) => receipt.idempotency_key === approvedRequest.idempotencyKey);
    expect(receipts.map((receipt) => receipt.approval_id)).toEqual(approvalIds);
    const { rows } = await db.pool.query<{ uses: number }>(
      'SELECT uses FROM credential_grants WHERE id = $1', [grant.id],
    );
    expect(rows[0]?.uses).toBe(1);
  });

  it('rejects an approval that expires while credential policy locks are blocked', async () => {
    const subject = await execution('approval-expiry-fence');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'Authorization', secret: 'approval-expired', cipher,
    });
    const grant = await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*', requiresApproval: true,
    });
    const approvedRequest = request(subject, 'approval-expiry');
    const approvalId = newId('apr');
    await db.pool.query(
      `INSERT INTO approvals
         (id, run_id, action, status, decision_by, decided_at, expires_at)
       VALUES ($1,$2,$3,'APPROVED','reviewer',clock_timestamp(),
               clock_timestamp() + interval '100 milliseconds')`,
      [approvalId, subject.run.id, JSON.stringify({
        action: approvedRequest.action,
        resource: approvedRequest.resource,
        arguments: { __idemKey: approvedRequest.idempotencyKey },
        risk: 'external_write',
      })],
    );
    const blocker = await db.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(`SELECT id FROM credential_grants WHERE id = $1 FOR UPDATE`, [grant.id]);
    const resolution = new CredentialBroker(db.pool, cipher).resolve({
      ...approvedRequest,
      approvalId,
    });
    await delay(175);
    await blocker.query('COMMIT');
    blocker.release();
    expect(await resolution).toBeNull();
  });

  it('records secret-free receipts and deduplicates a logical retry', async () => {
    const subject = await execution('receipt');
    const credential = await createCredential(db.pool, {
      tenantId: subject.tenantId, name: 'gh', action: '*', resource: '*',
      headerName: 'X-Secret', secret: 'never-in-receipt', cipher,
    });
    const grant = await createCredentialGrant(db.pool, {
      tenantId: subject.tenantId, credentialId: credential.id,
      agentVersionId: subject.agentVersionId, runId: subject.run.id,
      caller: '*', purpose: '*', action: '*', resource: '*', maxUses: 2,
    });
    const broker = new CredentialBroker(db.pool, cipher);
    expect(
      await broker.resolve({
        ...request(subject, 'same-logical-use'),
        approvalId: 'apr_not_valid',
      }),
    ).not.toBeNull();
    expect(await broker.resolve(request(subject, 'same-logical-use'))).not.toBeNull();
    expect(
      await broker.resolve({
        ...request(subject, 'same-logical-use'),
        resource: 'https://different.example',
      }),
    ).toBeNull();
    const receipts = await listCredentialUseReceipts(db.pool, subject.tenantId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.approval_id).toBeNull();
    expect(JSON.stringify(receipts)).not.toContain('never-in-receipt');
    expect(JSON.stringify(receipts)).not.toContain('secret_ct');
    const { rows } = await db.pool.query<{ uses: number }>(
      `SELECT uses FROM credential_grants WHERE id = $1`, [grant.id],
    );
    expect(rows[0]?.uses).toBe(1);
  });
});
