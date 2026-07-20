import { describe, expect, it, vi } from 'vitest';
import { runModelArkConformance } from '../src/providers/modelArkConformance.js';

describe('ModelArk live conformance seam', () => {
  it('uses a temporary key in memory and emits metadata without key, prompt, or output', async () => {
    const getTemporaryKey = vi.fn(async () => ({
      apiKey: 'canary-model-key',
      requestId: 'key-request-1',
      expiresAt: new Date('2026-07-20T01:00:00Z'),
    }));
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
});
