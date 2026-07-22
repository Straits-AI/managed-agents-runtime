import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { loadProviderPortability } from '../src/providers/portability.js';
import { createTestDb, type TestDb } from './helpers/db.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const root = resolve(import.meta.dirname, '..');
const auth = { authorization: 'Bearer dev-token' };

describe('Kertas provider capability API', () => {
  it('discovers versioned contracts and resolves a provider without brand input', async () => {
    const app = buildServer({
      pool: db.pool,
      cfg: loadConfig({ DATABASE_URL: db.url }),
      providerPortability: loadProviderPortability(root),
    });
    const discovery = await app.inject({
      method: 'GET',
      url: '/v1/provider-capabilities',
      headers: auth,
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      apiVersion: 'provider-contracts/v1',
      contracts: expect.arrayContaining([expect.objectContaining({ id: 'object.read/v1' })]),
      profiles: expect.arrayContaining([expect.objectContaining({ providerId: 'aws' })]),
    });

    const resolved = await app.inject({
      method: 'POST',
      url: '/v1/provider-capabilities/resolve',
      headers: auth,
      payload: {
        apiVersion: 'provider-selection/v1',
        requirements: [{ contract: 'object.read/v1', minimumAssurance: 'live' }],
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({
      schemaVersion: 'provider-selection/v1',
      bindings: [{
        contract: 'object.read/v1',
        providerId: 'aws',
        profileId: 'public-s3-read',
        implementation: 'AwsPublicS3Reader',
        assurance: 'live',
        failureBoundary: expect.any(String),
        limitations: expect.arrayContaining([expect.stringContaining('public NOAA')]),
      }],
    });
    await app.close();
  });

  it('authenticates selection and rejects unknown or unsatisfied capabilities', async () => {
    const app = buildServer({
      pool: db.pool,
      cfg: loadConfig({ DATABASE_URL: db.url }),
      providerPortability: loadProviderPortability(root),
    });
    expect((await app.inject({
      method: 'POST',
      url: '/v1/provider-capabilities/resolve',
      payload: {
        apiVersion: 'provider-selection/v1',
        requirements: [{ contract: 'model.chat/v2', minimumAssurance: 'live' }],
      },
    })).statusCode).toBe(401);

    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/provider-capabilities/resolve',
      headers: auth,
      payload: {
        apiVersion: 'provider-selection/v1',
        requirements: [{ contract: 'model.chat/v2', minimumAssurance: 'live' }],
      },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: 'ProviderSelectionError' });

    const unsatisfied = await app.inject({
      method: 'POST',
      url: '/v1/provider-capabilities/resolve',
      headers: auth,
      payload: {
        apiVersion: 'provider-selection/v1',
        requirements: [{ contract: 'event.publish/v1', minimumAssurance: 'live' }],
      },
    });
    expect(unsatisfied.statusCode).toBe(400);
    expect(unsatisfied.json()).toMatchObject({
      error: 'ProviderSelectionError',
      message: 'no provider satisfies capability group event.publish/v1',
    });
    await app.close();
  });
});
