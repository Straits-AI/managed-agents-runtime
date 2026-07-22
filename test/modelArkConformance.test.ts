import { describe, expect, it, vi } from 'vitest';
import {
  createModelArkTemporaryKeyRequest,
  parseBoundedProviderFailure,
  runModelArkConformance,
  runModelArkExpectedFailure,
} from '../src/providers/modelArkConformance.js';

describe('ModelArk live conformance seam', () => {
  it('scopes a preset endpoint key to the explicit project and model alias', () => {
    expect(createModelArkTemporaryKeyRequest({
      durationSeconds: 900,
      resourceType: 'presetendpoint',
      resourceIds: ['seed-2-0-lite-260228'],
      projectName: 'default',
    })).toEqual({
      DurationSeconds: 900,
      ResourceType: 'presetendpoint',
      ResourceIds: ['seed-2-0-lite-260228'],
      ProjectName: 'default',
    });
  });

  it('rejects preset endpoint key requests without a project', () => {
    expect(() => createModelArkTemporaryKeyRequest({
      durationSeconds: 900,
      resourceType: 'presetendpoint',
      resourceIds: ['seed-2-0-lite-260228'],
    })).toThrow('ModelArk preset endpoint key requires an explicit project name');
  });

  it('does not add a project to endpoint key requests', () => {
    expect(createModelArkTemporaryKeyRequest({
      durationSeconds: 900,
      resourceType: 'endpoint',
      resourceIds: ['ep-fixture'],
    })).toEqual({
      DurationSeconds: 900,
      ResourceType: 'endpoint',
      ResourceIds: ['ep-fixture'],
    });
  });

  it('rejects an unsupported key resource type at the runtime boundary', () => {
    expect(() => createModelArkTemporaryKeyRequest({
      durationSeconds: 900,
      resourceType: 'model' as never,
      resourceIds: ['seed-2-0-lite-260228'],
    })).toThrow('ModelArk temporary key resource type is invalid');
  });

  it('extracts only bounded provider metadata from a bp failure', () => {
    expect(parseBoundedProviderFailure(
      'NotFound.Resource: secret body\nstatus code: 404, request id: request-404',
    )).toEqual({
      status: 404,
      code: 'NotFound.Resource',
      requestId: 'request-404',
    });
  });

  it('uses a temporary key in memory and emits metadata without key, prompt, or output', async () => {
    const getTemporaryKey = vi.fn(async (input: { model: string }) => {
      expect(input.model).toBe('seed-fixture');
      return {
      apiKey: 'canary-model-key',
      requestId: 'key-request-1',
      expiresAt: new Date('2026-07-20T01:00:00Z'),
      };
    });
    const invoke = vi.fn(async (input: { apiKey: string; model: string }) => {
      expect(input.apiKey).toBe('canary-model-key');
      return {
        markerMatched: true,
        requestId: 'inference-request-1',
        inputTokens: 9,
        outputTokens: 1,
        finishReason: 'stop',
        output: 'canary-model-output',
      };
    });

    const evidence = await runModelArkConformance({ getTemporaryKey, invoke }, {
      model: 'seed-fixture',
      now: new Date('2026-07-20T00:00:00Z'),
    });

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      model: 'seed-fixture',
      temporaryKey: { persisted: false, serialized: false, requestId: 'key-request-1' },
      inference: {
        markerMatched: true,
        requestId: 'inference-request-1',
        inputTokens: 9,
        outputTokens: 1,
        finishReason: 'stop',
      },
      redaction: { promptIncluded: false, outputIncluded: false, credentialIncluded: false },
    });
    expect(JSON.stringify(evidence)).not.toContain('canary-model-key');
    expect(JSON.stringify(evidence)).not.toContain('canary-model-output');
  });

  it('sanitizes inference errors rather than reflecting a temporary key', async () => {
    const deps = {
      getTemporaryKey: vi.fn(async () => ({
        apiKey: 'canary-model-key',
        requestId: 'key-request-2',
        expiresAt: new Date('2026-07-20T01:00:00Z'),
      })),
      invoke: vi.fn(async () => {
        throw Object.assign(new Error('authorization canary-model-key'), {
          status: 429,
          code: 'RateLimitExceeded',
          requestId: 'inference-request-2',
        });
      }),
    };

    await expect(runModelArkConformance(deps, {
      model: 'seed-fixture',
      now: new Date('2026-07-20T00:00:00Z'),
    })).rejects.toThrow(
      'ModelArk conformance failed (HTTP 429, RateLimitExceeded, request inference-request-2)',
    );
  });

  it('serializes only bounded metadata for an expected unavailable-model failure', async () => {
    const getTemporaryKey = vi.fn(async (input: { model: string }) => {
      expect(input.model).toBe('seed-unavailable');
      return {
        apiKey: 'negative-canary-key',
        requestId: 'negative-key-request-1',
        expiresAt: new Date('2026-07-20T01:00:00Z'),
      };
    });
    const invoke = vi.fn(async (input: { apiKey: string; model: string }) => {
      expect(input).toEqual({ apiKey: 'negative-canary-key', model: 'seed-unavailable' });
      throw Object.assign(new Error('secret negative-canary-key'), {
        status: 400,
        code: 'ModelNotOpen',
        requestId: 'negative-inference-request-1',
      });
    });

    const evidence = await runModelArkExpectedFailure({ getTemporaryKey, invoke }, {
      model: 'seed-unavailable',
      expectedCode: 'ModelNotOpen',
      now: new Date('2026-07-20T00:00:00Z'),
    });

    expect(evidence).toEqual({
      model: 'seed-unavailable',
      expectedCode: 'ModelNotOpen',
      observed: true,
      status: 400,
      code: 'ModelNotOpen',
      requestId: 'negative-inference-request-1',
      temporaryKey: {
        persisted: false,
        serialized: false,
        requestId: 'negative-key-request-1',
      },
      redaction: {
        promptIncluded: false,
        outputIncluded: false,
        credentialIncluded: false,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain('negative-canary-key');
  });

  it('rejects an unexpected negative-probe outcome', async () => {
    const dependencies = {
      getTemporaryKey: vi.fn(async () => ({
        apiKey: 'negative-canary-key',
        requestId: 'negative-key-request-2',
        expiresAt: new Date('2026-07-20T01:00:00Z'),
      })),
      invoke: vi.fn(async () => ({
        markerMatched: true,
        requestId: 'unexpected-success',
        inputTokens: 1,
        outputTokens: 1,
        finishReason: 'stop',
        output: 'PONG',
      })),
    };

    await expect(runModelArkExpectedFailure(dependencies, {
      model: 'seed-unavailable',
      expectedCode: 'ModelNotOpen',
      now: new Date('2026-07-20T00:00:00Z'),
    })).rejects.toThrow('ModelArk negative probe unexpectedly succeeded');
  });
});
