import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  TosObjectStore,
  TosObjectStoreError,
} from '../src/providers/tosObjectStore.js';
import {
  buildTosPresignedUrl,
  buildTosSignedRequest,
} from '../src/providers/tosProtocol.js';

const date = new Date('2024-01-02T03:04:05.000Z');
const signing = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-example',
  sessionToken: 'session-example',
  endpoint: 'tos-ap-southeast-1.bytepluses.com',
  region: 'ap-southeast-1',
  bucket: 'fixture-bucket',
  key: 'folder/a b.txt',
  date,
} as const;

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    BYTEPLUS_ACCESS_KEY_ID: signing.accessKeyId,
    BYTEPLUS_SECRET_ACCESS_KEY: signing.secretAccessKey,
    BYTEPLUS_SESSION_TOKEN: signing.sessionToken,
    TOS_ENDPOINT: signing.endpoint,
    TOS_REGION: signing.region,
    TOS_BUCKET: signing.bucket,
    ...overrides,
  });
}

describe('native TOS protocol replacement', () => {
  it('matches official SDK 2.9.1 header-signing vectors', () => {
    const expected = {
      PUT: 'd3bb755a4cdac7eceb22b0dc0d33139e7f95e4dbb4938a880cf3ec90b2c36cd7',
      HEAD: 'f609e75c6b7fc59763101c0dd8046d3ac9423458f874d82e48affb6ee3959585',
      GET: 'a279f5e202f9bd942f1aad2cdf1d105e180263ebe5daa7a4cef5132d71dae92c',
    } as const;
    for (const method of ['PUT', 'HEAD', 'GET'] as const) {
      const request = buildTosSignedRequest({ ...signing, method });
      expect(request.url).toBe(
        'https://fixture-bucket.tos-ap-southeast-1.bytepluses.com/folder%2Fa%20b.txt',
      );
      expect(request.headers).toMatchObject({
        host: 'fixture-bucket.tos-ap-southeast-1.bytepluses.com',
        'x-tos-date': '20240102T030405Z',
        'x-tos-content-sha256': 'UNSIGNED-PAYLOAD',
        'x-tos-security-token': 'session-example',
        authorization:
          `TOS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20240102/ap-southeast-1/tos/request, ` +
          `SignedHeaders=host;x-tos-content-sha256;x-tos-date;x-tos-security-token, ` +
          `Signature=${expected[method]}`,
      });
    }
  });

  it('matches official SDK 2.9.1 bucket and delete signing vectors', () => {
    expect(buildTosSignedRequest({ ...signing, key: undefined, method: 'HEAD' }))
      .toMatchObject({
        url: 'https://fixture-bucket.tos-ap-southeast-1.bytepluses.com/',
        headers: { authorization: expect.stringContaining(
          'Signature=9192719e066e7806d4cd852bda8235bf3ad4160570ecb25994b5cfadd5b38bc4',
        ) },
      });
    expect(buildTosSignedRequest({ ...signing, key: undefined, method: 'PUT' })
      .headers.authorization).toContain(
        'Signature=e6e74fe722d5670415dd46a3c96696c3c956a2bd821c7b85958963d255840a9b',
      );
    expect(buildTosSignedRequest({ ...signing, method: 'DELETE' }).headers.authorization)
      .toContain(
        'Signature=1751634bd8da409a9249094897f3d5e02205b7f91686adc88fc1f24cd038159e',
      );
  });

  it('matches official SDK 2.9.1 presigned GET and PUT vectors', () => {
    expect(buildTosPresignedUrl({ ...signing, method: 'GET', expires: 900 })).toBe(
      'https://fixture-bucket.tos-ap-southeast-1.bytepluses.com/folder/a%20b.txt?' +
      'X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Content-Sha256=UNSIGNED-PAYLOAD&' +
      'X-Tos-Credential=AKIDEXAMPLE%2F20240102%2Ftos-ap-southeast-1.bytepluses.com%2Ftos%2Frequest&' +
      'X-Tos-Date=20240102T030405Z&X-Tos-Expires=900&X-Tos-SignedHeaders=host&' +
      'X-Tos-Security-Token=session-example&' +
      'X-Tos-Signature=a3b8854fcc773b81e1c6e9d2823e5354cae9124a714cc7fac71d3aa3e3255aa4',
    );
    expect(buildTosPresignedUrl({ ...signing, method: 'PUT', expires: 900 })).toContain(
      'X-Tos-Signature=051449ccf27ddd03cb581814b8297d3d98c91103a0b57109056e6ecc177a590e',
    );
  });

  it('round-trips the ObjectStore contract with bounded native fetch calls', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const responses = [
      new Response(null, { status: 200, headers: { etag: 'etag-1' } }),
      new Response(Buffer.from('downloaded'), { status: 200 }),
      new Response(null, { status: 200 }),
      new Response(JSON.stringify({ Code: 'NoSuchKey', Message: 'missing' }), {
        status: 404,
        headers: { 'x-tos-request-id': 'request-404' },
      }),
    ];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init! });
      return responses.shift()!;
    });
    const store = new TosObjectStore(config(), { fetch, now: () => date });

    expect(await store.put('path/item.bin', Buffer.from('upload'))).toEqual({ etag: 'etag-1' });
    expect(await store.get('path/item.bin')).toEqual(Buffer.from('downloaded'));
    expect(await store.exists('path/item.bin')).toBe(true);
    expect(await store.exists('path/missing.bin')).toBe(false);

    expect(calls.map((call) => call.init.method)).toEqual(['PUT', 'GET', 'HEAD', 'HEAD']);
    expect(calls[0]!.init).toMatchObject({ redirect: 'error' });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.url).toContain('/path%2Fitem.bin');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toMatch(
      /^TOS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//,
    );
  });

  it('retries transient failures but preserves non-retryable TOS error evidence', async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(Buffer.from('ok'), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Code: 'AccessDenied',
        Message: 'denied by policy',
        RequestId: 'body-request-id',
      }), { status: 403 }));
    const store = new TosObjectStore(config(), { fetch, now: () => date, sleep });

    expect(await store.get('retry.bin')).toEqual(Buffer.from('ok'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    await expect(store.get('denied.bin')).rejects.toMatchObject({
      name: 'TosObjectStoreError',
      statusCode: 403,
      code: 'AccessDenied',
      requestId: 'body-request-id',
    } satisfies Partial<TosObjectStoreError>);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('rejects oversized object responses before buffering their body', async () => {
    const fetch = vi.fn(async () => new Response('small fixture body', {
      status: 200,
      headers: { 'content-length': '9' },
    }));
    const store = new TosObjectStore(config({ TOS_MAX_OBJECT_BYTES: '8' }), {
      fetch,
      now: () => date,
    });

    await expect(store.get('too-large.bin')).rejects.toMatchObject({
      name: 'TosObjectStoreError',
      code: 'ResponseTooLarge',
    });
  });

  it('rejects unsafe configuration, invalid keys, and excessive presign lifetimes', () => {
    expect(() => new TosObjectStore(loadConfig({
      BYTEPLUS_ACCESS_KEY_ID: 'ak',
      BYTEPLUS_SECRET_ACCESS_KEY: 'sk',
      TOS_BUCKET: 'valid-bucket',
      TOS_ENDPOINT: 'https://tos.example.com/path',
    }))).toThrow(/endpoint must be a hostname/);
    expect(() => buildTosSignedRequest({ ...signing, key: '', method: 'GET' })).toThrow(
      /key must be non-empty/,
    );
    expect(() => buildTosPresignedUrl({
      ...signing,
      method: 'GET',
      expires: 604_801,
    })).toThrow(/expiry/);
  });
});
