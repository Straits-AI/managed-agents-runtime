import { afterEach, describe, expect, it, vi } from 'vitest';
import { VefaasClient } from '../src/providers/byteplus/vefaas.js';

describe('veFaaS successful response metadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('observes bounded action metadata without changing lifecycle results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ResponseMetadata: { RequestId: 'request-create-1' },
      Result: { SandboxId: 'sandbox-1' },
    }), { status: 200 })));
    const observed: unknown[] = [];
    const client = new VefaasClient({
      host: 'open.byteplusapi.com',
      region: 'ap-southeast-1',
      accessKeyId: 'fixture-ak',
      secretAccessKey: 'fixture-sk',
      onResponseMetadata: (metadata) => observed.push(metadata),
    });

    await expect(client.createSandbox({
      functionId: 'function-1',
      timeoutMinutes: 10,
    })).resolves.toEqual({ SandboxId: 'sandbox-1' });
    expect(observed).toEqual([{
      service: 'vefaas',
      action: 'CreateSandbox',
      requestId: 'request-create-1',
    }]);
  });

  it('reports null rather than forwarding unsafe request metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ResponseMetadata: { RequestId: 'unsafe request id' },
      Result: { Status: 'Ready' },
    }), { status: 200 })));
    const observed: unknown[] = [];
    const client = new VefaasClient({
      host: 'open.byteplusapi.com',
      region: 'ap-southeast-1',
      accessKeyId: 'fixture-ak',
      secretAccessKey: 'fixture-sk',
      onResponseMetadata: (metadata) => observed.push(metadata),
    });

    await client.describeSandbox('function-1', 'sandbox-1');
    expect(observed).toEqual([{
      service: 'vefaas',
      action: 'DescribeSandbox',
      requestId: null,
    }]);
  });

  it('serializes sandbox env maps and the complete image override shape', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      ResponseMetadata: { RequestId: 'request-create-2' },
      Result: { SandboxId: 'sandbox-2' },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new VefaasClient({
      host: 'open.byteplusapi.com',
      region: 'ap-southeast-1',
      accessKeyId: 'fixture-ak',
      secretAccessKey: 'fixture-sk',
    });

    await client.createSandbox({
      functionId: 'function-1',
      timeoutMinutes: 10,
      envs: { HOME: '/home/tiger' },
      image: 'registry.example/sandbox:1',
      command: 'bash /run.sh',
      port: 8080,
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      Envs: [{ Key: 'HOME', Value: '/home/tiger' }],
      InstanceImageInfo: {
        Image: 'registry.example/sandbox:1',
        Command: 'bash /run.sh',
        Port: 8080,
      },
    });
  });
});
