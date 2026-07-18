import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';

describe('API error boundary', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('redacts internal server failures and returns the request correlation id', async () => {
    const pool = {
      query: async () => {
        throw new Error('postgres password=do-not-leak');
      },
    } as unknown as Pool;
    app = buildServer({
      pool,
      cfg: loadConfig({ API_AUTH_TOKEN: 'test-token' }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/runs/run_missing',
      headers: {
        authorization: 'Bearer test-token',
        'x-request-id': 'request-public-123',
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'internal_error',
      message: 'Internal server error',
      requestId: 'request-public-123',
    });
    expect(response.body).not.toContain('postgres');
    expect(response.body).not.toContain('do-not-leak');
  });
});
