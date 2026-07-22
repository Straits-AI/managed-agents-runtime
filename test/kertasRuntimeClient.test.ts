import { describe, expect, it, vi } from 'vitest';
import {
  KertasRuntimeClient,
  RuntimeHttpError,
} from '../clients/kertas-runtime/src/index.js';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('standalone Kertas runtime client', () => {
  it('uses only authenticated public HTTP for ManagedSession resources', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(201, { id: 'ses_1', kind: 'ManagedSession' }))
      .mockResolvedValueOnce(response(201, {
        id: 'sevt_1', kind: 'ManagedSessionEvent', receivedSequence: 1,
      }))
      .mockResolvedValueOnce(response(200, { events: [], nextCursor: null }));
    const client = new KertasRuntimeClient({
      baseUrl: 'https://runtime.example/', bearerToken: 'tenant-secret', fetchImpl,
    });

    await client.createManagedSession({ agentVersionId: 'av_1', objective: 'test' }, 'create-1');
    await client.deliverManagedSessionEvent('ses_1', { eventId: 'evt_1' });
    await client.listManagedSessionEvents('ses_1', { after: '0', limit: 25 });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://runtime.example/v1alpha1/sessions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer tenant-secret',
        'content-type': 'application/json',
        'idempotency-key': 'create-1',
      },
      body: JSON.stringify({ agentVersionId: 'av_1', objective: 'test' }),
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      'https://runtime.example/v1alpha1/sessions/ses_1/events?after=0&limit=25',
    );
  });

  it('preserves HTTP status and bounded response body for tenant isolation decisions', async () => {
    const client = new KertasRuntimeClient({
      baseUrl: 'https://runtime.example',
      bearerToken: 'other-tenant',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(404, {
        error: 'session_not_found',
      })),
    });
    await expect(client.getManagedSession('ses_private')).rejects.toMatchObject({
      status: 404,
      body: { error: 'session_not_found' },
    } satisfies Partial<RuntimeHttpError>);
  });

  it('fetches only the two published versioned contract documents', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { id: 'kertas.runtime/v1alpha1', schemas: {} }))
      .mockResolvedValueOnce(response(200, { id: 'run-as-session/v1', schemas: {} }));
    const client = new KertasRuntimeClient({
      baseUrl: 'https://runtime.example', bearerToken: 'tenant-secret', fetchImpl,
    });
    await client.getContractDocument('kertas.runtime/v1alpha1');
    await client.getContractDocument('run-as-session/v1');
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'https://runtime.example/v1/contracts/kertas.runtime/v1alpha1',
      'https://runtime.example/v1/contracts/run-as-session/v1',
    ]);
  });

  it('rejects declared and streamed responses beyond the configured byte bound', async () => {
    const declared = new Response('too large', {
      status: 200,
      headers: { 'content-length': '9' },
    });
    const streamed = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('1234'));
        controller.enqueue(new TextEncoder().encode('5678'));
        controller.close();
      },
    }));
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(declared)
      .mockResolvedValueOnce(streamed);
    const client = new KertasRuntimeClient({
      baseUrl: 'https://runtime.example', bearerToken: 'tenant-secret',
      fetchImpl, maxResponseBytes: 7,
    });
    await expect(client.getRun('run_declared')).rejects.toMatchObject({
      status: 502, body: { error: 'runtime_response_too_large' },
    });
    await expect(client.getRun('run_streamed')).rejects.toMatchObject({
      status: 502, body: { error: 'runtime_response_too_large' },
    });
  });
});
