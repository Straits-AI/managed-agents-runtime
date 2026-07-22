import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  discoverRuntimeContract,
  RuntimeContractCompatibilityError,
  selectCompatibleContract,
} from '../clients/kertas-runtime/src/contractDiscovery.js';

let server: Server;
let baseUrl: string;
let fixtures: Record<string, unknown>;

beforeAll(async () => {
  fixtures = JSON.parse(
    await readFile(
      path.join(process.cwd(), 'contracts/fixtures/contract-discovery.v1.json'),
      'utf8',
    ),
  );
  server = createServer((request, response) => {
    if (
      request.url !== '/v1/contracts' ||
      request.headers.authorization !== 'Bearer test-token'
    ) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(fixtures.currentOnly));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://${address.address}:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('standalone Kertas compatibility client', () => {
  it('feature-detects the live runtime through authenticated HTTP only', async () => {
    const selected = await discoverRuntimeContract({
      baseUrl,
      bearerToken: 'test-token',
    });

    expect(selected).toEqual({
      contractId: 'run-as-session/v1',
      mode: 'compatibility',
      managedSession: false,
      lifecycle: 'supported',
      deprecatedAt: null,
      sunsetAt: null,
    });
  });

  it('selects target support when present and current compatibility otherwise', async () => {
    expect(selectCompatibleContract(fixtures.currentOnly)).toMatchObject({
      contractId: 'run-as-session/v1',
      managedSession: false,
    });
    expect(selectCompatibleContract(fixtures.managedSessionAvailable)).toMatchObject({
      contractId: 'kertas.runtime/v1alpha1',
      managedSession: true,
    });
    expect(() => selectCompatibleContract(fixtures.unsupportedOnly)).toThrow(
      RuntimeContractCompatibilityError,
    );
  });

  it('contains no imports of runtime stores, migrations, or internal domain modules', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'clients/kertas-runtime/src/contractDiscovery.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/src\/(store|db|core|harness|scheduler)\//);
    expect(source).not.toMatch(/migrations\//);
  });
});
