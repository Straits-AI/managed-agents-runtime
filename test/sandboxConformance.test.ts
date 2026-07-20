import { describe, expect, it, vi } from 'vitest';
import { runSandboxConformance } from '../src/providers/sandboxConformance.js';

function fixture() {
  let status = 'Creating';
  return {
    create: vi.fn(async () => ({ sandboxId: 'sandbox-fixture', baseUrl: 'private://fixture' })),
    describe: vi.fn(async (_handle: { sandboxId: string; baseUrl: string }) => ({ status })),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: 'canary-marker', stderr: '' })),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => 'canary-marker'),
    terminate: vi.fn(async () => { status = 'Killed'; }),
    sleep: vi.fn(async () => { status = 'Ready'; }),
  };
}

describe('private sandbox live conformance seam', () => {
  it('proves lifecycle, execution, file roundtrip, and verified termination', async () => {
    const provider = fixture();
    const evidence = await runSandboxConformance(provider, {
      runId: 'fixed-run',
      timeoutMinutes: 10,
      marker: 'canary-marker',
    });

    expect(evidence).toEqual({
      schemaVersion: 1,
      runId: 'fixed-run',
      controlPlane: { ready: true, terminated: true, terminalStatus: 'Killed' },
      dataPlane: { execMarker: true, fileRoundtrip: true },
      network: { publicRouteUsed: false, signedEndpointSerialized: false },
      redaction: { markerIncluded: false, commandOutputIncluded: false },
      cleanup: { sandboxTerminated: true, terminationVerified: true },
    });
    expect(provider.terminate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(evidence)).not.toContain('canary-marker');
  });

  it('terminates and verifies cleanup when execution fails', async () => {
    const provider = fixture();
    provider.exec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'failure canary-marker' });

    await expect(runSandboxConformance(provider, {
      runId: 'failed-run',
      timeoutMinutes: 10,
      marker: 'canary-marker',
    })).rejects.toThrow('Sandbox conformance execution failed');
    expect(provider.terminate).toHaveBeenCalledTimes(1);
    await expect(provider.describe({ sandboxId: 'sandbox-fixture', baseUrl: 'private://fixture' }))
      .resolves.toEqual({ status: 'Killed' });
  });
});
