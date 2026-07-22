import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Ajv, type AnySchema } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { createTestDb, type TestDb } from './helpers/db.js';

const AUTH = { authorization: 'Bearer test-token' };
const CONTRACT_ID = 'run-as-session/v1';

let db: TestDb;
let app: FastifyInstance;
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
type ContractSchema = Record<string, unknown> & { $id: string };

function validatorsFor(contract: {
  schemas: {
    runCreate: ContractSchema;
    runResource: ContractSchema;
    runEvent: ContractSchema;
    runEventsResponse: ContractSchema;
  };
}) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(Object.values(contract.schemas) as AnySchema[]);
  return {
    create: ajv.getSchema(contract.schemas.runCreate.$id)!,
    run: ajv.getSchema(contract.schemas.runResource.$id)!,
    event: ajv.getSchema(contract.schemas.runEvent.$id)!,
    eventResponse: ajv.getSchema(contract.schemas.runEventsResponse.$id)!,
  };
}

beforeAll(async () => {
  db = await createTestDb();
  app = buildServer({
    pool: db.pool,
    cfg: loadConfig({
      ...process.env,
      DATABASE_URL: db.url,
      API_AUTH_TOKEN: 'test-token',
    }),
  });
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

async function createRunThroughPublicApi(): Promise<{
  run: Record<string, unknown>;
  runDetail: Record<string, unknown>;
  events: { events: Record<string, unknown>[] };
}> {
  const agent = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: AUTH,
    payload: { name: `contract-agent-${crypto.randomUUID()}` },
  });
  expect(agent.statusCode).toBe(201);

  const version = await app.inject({
    method: 'POST',
    url: `/v1/agents/${agent.json().id}/versions`,
    headers: AUTH,
    payload: { instructions: 'contract test', modelPolicy: { model: 'none' } },
  });
  expect(version.statusCode).toBe(201);

  const run = await app.inject({
    method: 'POST',
    url: '/v1/runs',
    headers: AUTH,
    payload: {
      agentVersionId: version.json().id,
      goal: 'prove the published Run contract',
      input: { source: 'public-http' },
    },
  });
  expect(run.statusCode).toBe(201);

  const runDetail = await app.inject({
    method: 'GET',
    url: `/v1/runs/${run.json().id}`,
    headers: AUTH,
  });
  expect(runDetail.statusCode).toBe(200);

  const events = await app.inject({
    method: 'GET',
    url: `/v1/runs/${run.json().id}/events`,
    headers: AUTH,
  });
  expect(events.statusCode).toBe(200);
  return { run: run.json(), runDetail: runDetail.json(), events: events.json() };
}

describe('run-as-session/v1 public contract', () => {
  it('requires authentication and discovers the compatibility contract', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/contracts' });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/contracts',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      apiVersion: 'kertas.runtime/contracts/v1',
      currentCompatibilityMode: CONTRACT_ID,
      contracts: [
        {
          id: CONTRACT_ID,
          status: 'compatibility',
          href: '/v1/contracts/run-as-session/v1',
        },
      ],
    });
  });

  it('publishes schemas that validate real Run API and event responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/contracts/run-as-session/v1',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const contract = response.json();
    expect(contract).toMatchObject({
      apiVersion: 'kertas.runtime/contracts/v1',
      id: CONTRACT_ID,
      status: 'compatibility',
      semantics: {
        topLevelResource: 'Run',
        runCompletionImpliesKertasOutcome: false,
        runCompletionImpliesKertasRelease: false,
      },
    });

    const validators = validatorsFor(contract);
    const { run, runDetail, events } = await createRunThroughPublicApi();

    expect(validators.run(run), JSON.stringify(validators.run.errors)).toBe(true);
    expect(validators.run(runDetail), JSON.stringify(validators.run.errors)).toBe(true);
    expect(validators.event(events.events[0]), JSON.stringify(validators.event.errors)).toBe(true);
    expect(
      validators.eventResponse(events),
      JSON.stringify(validators.eventResponse.errors),
    ).toBe(true);
  });

  it('fails closed for an unsupported contract version', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/contracts/run-as-session/v999',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'contract_not_supported',
      contractId: 'run-as-session/v999',
    });
  });

  it('ships checked compatibility fixtures and the contract in the OCI image', async () => {
    const contract = JSON.parse(
      await readFile(path.join(process.cwd(), 'contracts/run-as-session.v1.json'), 'utf8'),
    );
    const fixtures = JSON.parse(
      await readFile(
        path.join(process.cwd(), 'contracts/fixtures/run-as-session.v1.json'),
        'utf8',
      ),
    );
    const validators = validatorsFor(contract);

    expect(validators.create(fixtures.valid.runCreate)).toBe(true);
    expect(validators.run(fixtures.valid.runResource)).toBe(true);
    expect(validators.event(fixtures.valid.runEvent)).toBe(true);
    expect(validators.eventResponse(fixtures.valid.runEventsResponse)).toBe(true);
    expect(validators.create(fixtures.invalid.runCreateReservedInput)).toBe(false);
    expect(validators.create(fixtures.invalid.runCreateInvalidSchedule)).toBe(false);
    expect(validators.create(fixtures.invalid.runCreateOffsetSchedule)).toBe(false);
    expect(validators.run(fixtures.invalid.runMissingTenant)).toBe(false);
    expect(validators.run(fixtures.invalid.runUnexpectedField)).toBe(false);
    expect(validators.event(fixtures.invalid.eventUnknownType)).toBe(false);

    const dockerfile = await readFile(path.join(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY contracts ./contracts');
  });
});
