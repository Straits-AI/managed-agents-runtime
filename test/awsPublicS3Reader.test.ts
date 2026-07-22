import { describe, expect, it, vi } from 'vitest';
import {
  AwsPublicS3Error,
  AwsPublicS3Reader,
} from '../src/providers/aws/publicS3Reader.js';

function reader(fetch: typeof globalThis.fetch, maxObjectBytes = 64) {
  return new AwsPublicS3Reader({
    bucket: 'public-fixture-bucket',
    region: 'us-east-1',
    maxObjectBytes,
    requestTimeoutMs: 50,
    fetch,
  });
}

describe('AWS public S3 read-only capability', () => {
  it('round-trips bounded GET and HEAD metadata without credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { 'x-amz-request-id': 'head-request', 'content-length': '7', etag: 'etag-1' },
      }))
      .mockResolvedValueOnce(new Response('payload', {
        status: 200,
        headers: { 'x-amz-request-id': 'get-request', 'content-length': '7', etag: 'etag-1' },
      }));
    const store = reader(fetch);
    expect(await store.inspect('folder/object.txt')).toEqual({
      exists: true,
      metadata: { status: 200, requestId: 'head-request', etag: 'etag-1', contentLength: 7 },
    });
    expect(await store.get('folder/object.txt')).toEqual(Buffer.from('payload'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://public-fixture-bucket.s3.us-east-1.amazonaws.com/folder/object.txt',
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'HEAD', redirect: 'error' });
  });

  it('distinguishes absence from bounded provider failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 404,
        headers: { 'x-amz-request-id': 'missing-request' },
      }))
      .mockResolvedValueOnce(new Response('<Error>private provider detail</Error>', {
        status: 503,
        headers: { 'x-amz-request-id': 'failure-request' },
      }));
    const store = reader(fetch);
    expect(await store.exists('missing.txt')).toBe(false);
    await expect(store.get('failed.txt')).rejects.toMatchObject({
      name: 'AwsPublicS3Error',
      operation: 'GET',
      status: 503,
      requestId: 'failure-request',
      message: 'AWS public S3 GET failed',
    } satisfies Partial<AwsPublicS3Error>);
  });

  it('enforces declared and streamed byte limits before unbounded buffering', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('not-read', {
        status: 200,
        headers: { 'content-length': '65', 'x-amz-request-id': 'declared-too-large' },
      }))
      .mockResolvedValueOnce(new Response('streamed-payload', {
        status: 200,
        headers: { 'x-amz-request-id': 'streamed-too-large' },
      }));
    const store = reader(fetch, 8);
    await expect(store.get('declared.txt')).rejects.toMatchObject({
      status: 200,
      requestId: 'declared-too-large',
    });
    await expect(store.get('streamed.txt')).rejects.toMatchObject({
      status: 200,
      requestId: 'streamed-too-large',
    });
  });

  it('fails closed on timeout, redirects, invalid coordinates, and invalid keys', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
    await expect(reader(fetch).get('slow.txt')).rejects.toMatchObject({
      operation: 'GET',
      status: null,
      message: 'AWS public S3 GET request timed out',
    });

    const bodyFetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
      const stalledBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return Promise.resolve(new Response(stalledBody, {
        status: 200,
        headers: { 'x-amz-request-id': 'stalled-body' },
      }));
    });
    await expect(reader(bodyFetch).get('stalled.txt')).rejects.toMatchObject({
      operation: 'GET',
      status: null,
      message: 'AWS public S3 GET request timed out',
    });

    expect(() => new AwsPublicS3Reader({ bucket: '127.0.0.1', region: 'us-east-1' }))
      .toThrow(/bucket name is invalid/);
    expect(() => new AwsPublicS3Reader({ bucket: 'valid-bucket', region: 'not-a-region' }))
      .toThrow(/region is invalid/);
    await expect(reader(vi.fn()).get('../secret')).rejects.toThrow(/object key is invalid/);
  });
});
