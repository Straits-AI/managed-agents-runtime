import { describe, expect, it, vi } from 'vitest';
import {
  buildTosConformanceRecord,
  resolveTosConformanceSource,
  runTosConformance,
  type TosConformanceStore,
} from '../src/providers/tosConformance.js';

class MemoryTosStore implements TosConformanceStore {
  readonly objects = new Map<string, Buffer>();
  bucketPresent = true;
  createCalls = 0;
  readonly presignTtls: number[] = [];
  brokenDeleteSuffix: string | null = null;

  async bucketExists(): Promise<boolean> {
    return this.bucketPresent;
  }

  async createBucket(): Promise<void> {
    this.createCalls += 1;
    this.bucketPresent = true;
  }

  async put(key: string, body: Buffer): Promise<{ etag: string | null }> {
    this.objects.set(key, Buffer.from(body));
    return { etag: 'fixture-etag' };
  }

  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw Object.assign(new Error('missing'), {
      statusCode: 404,
      code: 'NoSuchKey',
      requestId: 'fixture-request-404',
    });
    return Buffer.from(value);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async presignGet(key: string, ttlSec: number): Promise<string> {
    this.presignTtls.push(ttlSec);
    return `https://fixture.invalid/get/${encodeURIComponent(key)}?signature=secret`;
  }

  async presignPut(key: string, ttlSec: number): Promise<string> {
    this.presignTtls.push(ttlSec);
    return `https://fixture.invalid/put/${encodeURIComponent(key)}?signature=secret`;
  }

  async delete(key: string): Promise<void> {
    if (this.brokenDeleteSuffix && key.endsWith(this.brokenDeleteSuffix)) return;
    this.objects.delete(key);
  }
}

function keyFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/'));
}

describe('TOS live conformance runner', () => {
  it('covers control, direct data, presigned GET/PUT, failure, redaction, and cleanup', async () => {
    const store = new MemoryTosStore();
    store.bucketPresent = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const key = keyFromUrl(url);
      if (new URL(url).pathname.startsWith('/get/')) {
        expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
        return new Response(await store.get(key), { status: 200 });
      }
      expect(init).toMatchObject({ method: 'PUT', redirect: 'error' });
      const body = Buffer.from(await new Response(init?.body).arrayBuffer());
      await store.put(key, body);
      return new Response(null, { status: 200 });
    });

    const result = await runTosConformance(store, {
      fetch,
      runId: 'fixed-run',
      payload: Buffer.from('bounded-fixture'),
    });

    expect(result).toEqual({
      schemaVersion: 1,
      runId: 'fixed-run',
      controlPlane: {
        bucketExisted: false,
        bucketCreated: true,
        bucketHeadSucceeded: true,
      },
      dataPlane: {
        directPutGet: true,
        directHead: true,
        presignedGet: true,
        presignedPut: true,
      },
      failurePath: {
        operation: 'GET deleted object',
        statusCode: 404,
        code: 'NoSuchKey',
        requestId: 'fixture-request-404',
      },
      redaction: {
        credentialFieldsIncluded: false,
        payloadIncluded: false,
        presignedUrlsIncluded: false,
      },
      cleanup: {
        objectsDeleted: true,
        objectsVerifiedAbsent: 2,
        configuredBucketRetained: true,
      },
    });
    expect(store.createCalls).toBe(1);
    expect(store.objects.size).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.presignTtls).toEqual([60, 60]);
    expect(JSON.stringify(result)).not.toContain('signature=secret');
    expect(JSON.stringify(result)).not.toContain('bounded-fixture');
  });

  it('cleans up direct objects when a presigned request fails', async () => {
    const store = new MemoryTosStore();
    const fetch = vi.fn(async () => new Response('denied', { status: 403 }));

    await expect(runTosConformance(store, {
      fetch,
      runId: 'failed-run',
      payload: Buffer.from('bounded-fixture'),
    })).rejects.toThrow(/presigned GET failed.*403/);
    expect(store.objects.size).toBe(0);
  });

  it('does not reflect a presigned URL from a transport failure', async () => {
    const store = new MemoryTosStore();
    const fetch = vi.fn(async () => {
      throw new Error('connect failed for https://fixture.invalid/?signature=secret');
    });

    let failure: unknown;
    try {
      await runTosConformance(store, {
        fetch,
        runId: 'transport-failure',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('TOS presigned GET transport failed');
    expect((failure as Error).message).not.toContain('signature=secret');
    expect(store.objects.size).toBe(0);
  });

  it('fails rather than claiming cleanup when either object remains', async () => {
    const store = new MemoryTosStore();
    store.brokenDeleteSuffix = 'presigned-put.bin';
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const key = keyFromUrl(url);
      if (init?.method === 'GET') return new Response(await store.get(key), { status: 200 });
      await store.put(key, Buffer.from(await new Response(init?.body).arrayBuffer()));
      return new Response(null, { status: 200 });
    });

    await expect(runTosConformance(store, {
      fetch,
      runId: 'broken-cleanup',
    })).rejects.toThrow('TOS cleanup left a conformance object behind');
    expect([...store.objects.keys()]).toEqual([
      '_conformance/broken-cleanup/presigned-put.bin',
    ]);
  });

  it('bounds a chunked presigned response to the expected payload size', async () => {
    const store = new MemoryTosStore();
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('managed-agents-runtime TOS conformance v1'));
        controller.enqueue(Buffer.from('unexpected-extra-byte'));
        controller.close();
      },
    }), { status: 200 }));

    await expect(runTosConformance(store, {
      fetch,
      runId: 'oversized-response',
    })).rejects.toThrow('TOS presigned GET exceeded expected payload size');
    expect(store.objects.size).toBe(0);
  });

  it('sanitizes provider failures while retaining bounded operator metadata', async () => {
    const store = new MemoryTosStore();
    store.bucketExists = vi.fn(async () => {
      throw Object.assign(new Error('secret-access-key=do-not-emit'), {
        statusCode: 503,
        code: 'ServiceUnavailable',
        requestId: 'fixture-request-503',
      });
    });

    let failure: unknown;
    try {
      await runTosConformance(store, { runId: 'provider-failure' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'TOS conformance failed (HTTP 503, ServiceUnavailable, request fixture-request-503)',
    );
    expect((failure as Error).message).not.toContain('secret-access-key');
  });

  it('builds a versioned provenance record without credential or payload fields', () => {
    const evidence = {
      schemaVersion: 1 as const,
      runId: 'fixed-run',
      controlPlane: {
        bucketExisted: true,
        bucketCreated: false,
        bucketHeadSucceeded: true,
      },
      dataPlane: {
        directPutGet: true as const,
        directHead: true as const,
        presignedGet: true as const,
        presignedPut: true as const,
      },
      failurePath: {
        operation: 'GET deleted object' as const,
        statusCode: 404 as const,
        code: 'NoSuchKey',
        requestId: 'fixture-request-404',
      },
      redaction: {
        credentialFieldsIncluded: false as const,
        payloadIncluded: false as const,
        presignedUrlsIncluded: false as const,
      },
      cleanup: {
        objectsDeleted: true as const,
        objectsVerifiedAbsent: 2,
        configuredBucketRetained: true as const,
      },
    };
    const record = buildTosConformanceRecord(evidence, {
      sourceRepository: 'https://github.com/Straits-AI/managed-agents-runtime',
      sourceCommit: 'a'.repeat(40),
      sourceCommitOrigin: 'git-clean-worktree',
      adapterName: 'TosObjectStore',
      adapterSourcePath: 'src/providers/tosObjectStore.ts',
      packageVersion: '0.1.0-alpha.1',
      runtime: 'node v26.1.0',
      transport: 'native-fetch',
      apiVersion: 'TOS4-HMAC-SHA256',
      provider: 'byteplus-tos',
      region: 'ap-southeast-1',
      endpoint: 'tos-ap-southeast-1.bytepluses.com',
      bucket: 'fixture-bucket',
      credentialBoundary: {
        source: 'process-environment',
        mode: 'temporary-session',
        valuesSerialized: false,
      },
      retrievedAt: new Date('2026-07-19T02:03:04.000Z'),
      capabilities: ['object.get', 'object.put'],
      untestedSemantics: ['bucket.create-if-missing'],
      unsupportedSemantics: ['multipart-upload', 'bucket-delete'],
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      evidenceId: 'byteplus-tos-fixed-run',
      source: { commit: 'a'.repeat(40) },
      adapter: { packageVersion: '0.1.0-alpha.1' },
      toolchain: { apiVersion: 'TOS4-HMAC-SHA256' },
      region: 'ap-southeast-1',
      retrievedAt: '2026-07-19T02:03:04.000Z',
      capabilities: ['object.get', 'object.put'],
      untestedSemantics: ['bucket.create-if-missing'],
      unsupportedSemantics: ['multipart-upload', 'bucket-delete'],
      evidence,
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('accessKey');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('signature=');
  });

  it('rejects an abbreviated source revision in a conformance record', () => {
    expect(() => buildTosConformanceRecord({} as never, {
      sourceRepository: 'https://github.com/Straits-AI/managed-agents-runtime',
      sourceCommit: 'abc1234',
      sourceCommitOrigin: 'git-clean-worktree',
      adapterName: 'TosObjectStore',
      adapterSourcePath: 'src/providers/tosObjectStore.ts',
      packageVersion: '0.1.0-alpha.1',
      runtime: 'node v26.1.0',
      transport: 'native-fetch',
      apiVersion: 'TOS4-HMAC-SHA256',
      provider: 'byteplus-tos',
      region: 'ap-southeast-1',
      endpoint: 'tos-ap-southeast-1.bytepluses.com',
      bucket: 'fixture-bucket',
      credentialBoundary: {
        source: 'process-environment',
        mode: 'long-lived-access-key',
        valuesSerialized: false,
      },
      retrievedAt: new Date('2026-07-19T02:03:04.000Z'),
      capabilities: ['object.get'],
      untestedSemantics: [],
      unsupportedSemantics: ['multipart-upload'],
    })).toThrow('source commit must be a full Git SHA');
  });

  it('accepts an explicit revision only for a matching clean checkout', () => {
    const commit = 'b'.repeat(40);
    expect(resolveTosConformanceSource({
      explicitCommit: commit,
      gitCommit: commit,
      gitStatus: '',
    })).toEqual({
      commit,
      commitOrigin: 'environment-verified-clean-worktree',
    });
    expect(() => resolveTosConformanceSource({
      explicitCommit: commit,
      gitCommit: commit,
      gitStatus: ' M src/providers/tosConformance.ts',
    })).toThrow('clean worktree');
    expect(() => resolveTosConformanceSource({
      explicitCommit: commit,
      gitCommit: 'c'.repeat(40),
      gitStatus: '',
    })).toThrow('does not match Git HEAD');
  });

  it('accepts an explicit full revision for an immutable build without Git metadata', () => {
    const commit = 'd'.repeat(40);
    expect(resolveTosConformanceSource({
      explicitCommit: commit,
      gitCommit: null,
      gitStatus: null,
    })).toEqual({ commit, commitOrigin: 'environment' });
    expect(() => resolveTosConformanceSource({
      explicitCommit: undefined,
      gitCommit: null,
      gitStatus: null,
    })).toThrow('requires CONFORMANCE_SOURCE_COMMIT');
  });
});
