import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createTestDb, type TestDb } from './helpers/db.js';
import { createTenant } from '../src/store/tenants.js';
import {
  createCredential,
  consumeCredential,
  listCredentials,
  revokeCredential,
} from '../src/store/credentials.js';
import { CredentialBroker } from '../src/providers/credentialBroker.js';
import { LocalCipher } from '../src/providers/secretCipher.js';
import { encryptSecret, decryptSecret, loadKey } from '../src/crypto.js';

let db: TestDb;
let tenantId: string;
const key = randomBytes(32);
const cipher = new LocalCipher(key);

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

  it('resolves and injects the header for a matching scope, consuming a use', async () => {
    const t = (await createTenant(db.pool, { name: 'match' })).id;
    await createCredential(db.pool, {
      tenantId: t, name: 'gh', action: 'external.http.request',
      resource: 'https://api.github.com', headerName: 'Authorization',
      secret: 'Bearer ghp_token', cipher, maxUses: 2,
    });
    const broker = new CredentialBroker(db.pool, cipher);
    const got = await broker.resolve({
      tenantId: t, runId: 'run_x', action: 'external.http.request', resource: 'https://api.github.com',
    });
    expect(got).toEqual({ headerName: 'Authorization', headerValue: 'Bearer ghp_token' });
    // Second use ok, third denied (max_uses=2).
    expect(await broker.resolve({ tenantId: t, runId: 'r', action: 'external.http.request', resource: 'https://api.github.com' })).not.toBeNull();
    expect(await broker.resolve({ tenantId: t, runId: 'r', action: 'external.http.request', resource: 'https://api.github.com' })).toBeNull();
  });

  it('does not release across tenants, resources, or actions', async () => {
    const t = (await createTenant(db.pool, { name: 'scoped' })).id;
    await createCredential(db.pool, {
      tenantId: t, name: 'gh', action: 'external.http.request',
      resource: 'https://api.github.com', headerName: 'Authorization', secret: 's', cipher,
    });
    const broker = new CredentialBroker(db.pool, cipher);
    // wrong tenant
    expect(await broker.resolve({ tenantId, runId: 'r', action: 'external.http.request', resource: 'https://api.github.com' })).toBeNull();
    // wrong resource
    expect(await broker.resolve({ tenantId: t, runId: 'r', action: 'external.http.request', resource: 'https://evil.com' })).toBeNull();
    // wrong action
    expect(await broker.resolve({ tenantId: t, runId: 'r', action: 'external.http.get', resource: 'https://api.github.com' })).toBeNull();
  });

  it('does not release expired credentials', async () => {
    const t = (await createTenant(db.pool, { name: 'expired' })).id;
    await createCredential(db.pool, {
      tenantId: t, name: 'gh', action: 'external.http.request', resource: '*',
      headerName: 'Authorization', secret: 's', cipher,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const broker = new CredentialBroker(db.pool, cipher);
    expect(await consumeCredential(db.pool, { tenantId: t, action: 'external.http.request', resource: 'https://x.com' })).toBeNull();
    expect(await broker.resolve({ tenantId: t, runId: 'r', action: 'external.http.request', resource: 'https://x.com' })).toBeNull();
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
    const t = (await createTenant(db.pool, { name: 'revoke' })).id;
    const { id } = await createCredential(db.pool, {
      tenantId: t, name: 'gh', action: 'external.http.request', resource: '*',
      headerName: 'Authorization', secret: 's', cipher,
    });
    const broker = new CredentialBroker(db.pool, cipher);
    expect(await broker.resolve({ tenantId: t, runId: 'r', action: 'external.http.request', resource: 'https://x.com' })).not.toBeNull();
    expect(await revokeCredential(db.pool, id, t)).toBe(true);
    expect(await broker.resolve({ tenantId: t, runId: 'r', action: 'external.http.request', resource: 'https://x.com' })).toBeNull();
  });
});
