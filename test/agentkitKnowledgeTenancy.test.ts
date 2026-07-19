import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { createTenant } from '../src/store/tenants.js';
import {
  createKnowledgeBinding,
  getKnowledgeBinding,
  markKnowledgeBindingVerified,
} from '../src/store/knowledgeBindings.js';
import {
  AgentKitKnowledgeProvider,
  KnowledgeBindingUnavailableError,
} from '../src/providers/agentkitKnowledge.js';
import type { SignV4Input } from '../src/providers/byteplus/signerV4.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

describe('tenant-owned AgentKit Knowledge bindings', () => {
  it('resolves the same logical name to each tenant authoritative provider mapping', async () => {
    const tenantA = await createTenant(db.pool, { name: 'Knowledge A' });
    const tenantB = await createTenant(db.pool, { name: 'Knowledge B' });
    await createKnowledgeBinding(db.pool, {
      tenantId: tenantA.id,
      name: 'handbook',
      provider: 'agentkit',
      providerProject: 'project-a',
      providerCollection: 'collection-a',
      liveVerifiedAt: new Date('2026-07-19T00:00:00Z'),
    });
    await createKnowledgeBinding(db.pool, {
      tenantId: tenantB.id,
      name: 'handbook',
      provider: 'agentkit',
      providerProject: 'project-b',
      providerCollection: 'collection-b',
      liveVerifiedAt: new Date('2026-07-19T00:00:00Z'),
    });

    const calls: SignV4Input[] = [];
    const provider = new AgentKitKnowledgeProvider(
      db.pool,
      { accessKeyId: 'ak', secretAccessKey: 'sk', requireLiveVerified: true },
      async <T>(input: SignV4Input) => {
        calls.push(input);
        return { result_list: [{ id: 'doc-1', content: 'tenant evidence' }] } as T;
      },
    );

    await provider.retrieve('handbook', 'refund', 3, tenantA.id);
    await provider.retrieve('handbook', 'refund', 3, tenantB.id);

    expect(calls.map((call) => JSON.parse(call.body!))).toEqual([
      {
        collection_name: 'collection-a',
        project: 'project-a',
        query: 'refund',
        limit: 3,
      },
      {
        collection_name: 'collection-b',
        project: 'project-b',
        query: 'refund',
        limit: 3,
      },
    ]);
  });

  it('cannot address another tenant collection or an unverified binding', async () => {
    const owner = await createTenant(db.pool, { name: 'Knowledge owner' });
    const attacker = await createTenant(db.pool, { name: 'Knowledge attacker' });
    await createKnowledgeBinding(db.pool, {
      tenantId: owner.id,
      name: 'claims',
      provider: 'agentkit',
      providerProject: 'owner-project',
      providerCollection: 'owner-collection',
    });
    let calls = 0;
    const provider = new AgentKitKnowledgeProvider(
      db.pool,
      { accessKeyId: 'ak', secretAccessKey: 'sk', requireLiveVerified: true },
      async <T>() => {
        calls += 1;
        return {} as T;
      },
    );

    await expect(
      provider.retrieve('owner-collection', 'claim', 3, attacker.id),
    ).rejects.toBeInstanceOf(KnowledgeBindingUnavailableError);
    await expect(
      provider.retrieve('claims', 'claim', 3),
    ).rejects.toBeInstanceOf(KnowledgeBindingUnavailableError);
    await expect(
      provider.retrieve('claims', 'claim', 3, owner.id),
    ).rejects.toBeInstanceOf(KnowledgeBindingUnavailableError);
    expect(calls).toBe(0);

    expect(await markKnowledgeBindingVerified(db.pool, owner.id, 'claims')).toBe(true);
    await provider.retrieve('claims', 'claim', 3, owner.id);
    expect(calls).toBe(1);
  });

  it('registers logical names per tenant without exposing provider fields to lookup callers', async () => {
    const tenant = await createTenant(db.pool, { name: 'Binding registry' });
    const created = await createKnowledgeBinding(db.pool, {
      tenantId: tenant.id,
      name: 'finance-policy',
      provider: 'agentkit',
      providerProject: 'private-project',
      providerCollection: 'private-collection',
    });

    const binding = await getKnowledgeBinding(db.pool, tenant.id, 'finance-policy');
    expect(binding?.id).toBe(created.id);
    expect(await getKnowledgeBinding(db.pool, 'default', 'finance-policy')).toBeNull();
  });
});
