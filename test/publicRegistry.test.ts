import { describe, expect, it, vi } from 'vitest';
import {
  parseGhcrDigestReference,
  PublicRegistryVerificationError,
  verifyPublicGhcrImage,
} from '../src/publicRegistry.js';

const digest = `sha256:${'a'.repeat(64)}`;
const image = `ghcr.io/straits-ai/managed-agents-runtime@${digest}`;

describe('public registry verification', () => {
  it('requires an immutable lowercase GHCR digest reference', () => {
    expect(parseGhcrDigestReference(image)).toEqual({
      repository: 'straits-ai/managed-agents-runtime',
      digest,
    });
    expect(() => parseGhcrDigestReference('ghcr.io/Straits-AI/runtime:latest'))
      .toThrow(PublicRegistryVerificationError);
  });

  it('fails closed when anonymous pull-token issuance is denied', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"error":"denied"}', { status: 401 }),
    );
    await expect(verifyPublicGhcrImage(image, request)).rejects.toThrow(
      /anonymous GHCR token request failed with HTTP 401/,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('cancels an oversized chunked anonymous token response while streaming', async () => {
    let cancelled = false;
    const chunks = [
      new Uint8Array(40 * 1024),
      new Uint8Array(40 * 1024),
      new Uint8Array(40 * 1024),
    ];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(verifyPublicGhcrImage(image, request)).rejects.toThrow(
      /anonymous registry token response is too large/,
    );
    expect(cancelled).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a manifest response for a different digest', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 't'.repeat(32) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'docker-content-digest': `sha256:${'b'.repeat(64)}` },
      }));
    await expect(verifyPublicGhcrImage(image, request)).rejects.toThrow(
      /did not match the requested digest/,
    );
  });

  it('proves an anonymous token and exact digest-addressed manifest', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 't'.repeat(32) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'docker-content-digest': digest },
      }));
    await expect(verifyPublicGhcrImage(image, request)).resolves.toMatchObject({
      repository: 'straits-ai/managed-agents-runtime',
      digest,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0]![0])).toContain(
      'scope=repository%3Astraits-ai%2Fmanaged-agents-runtime%3Apull',
    );
  });
});
