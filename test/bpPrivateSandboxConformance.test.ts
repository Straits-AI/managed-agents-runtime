import { describe, expect, it, vi } from 'vitest';
import { runSandboxConformance } from '../src/providers/sandboxConformance.js';
import { BpPrivateSandboxConformanceProvider } from '../src/providers/byteplus/bpPrivateSandboxConformance.js';
import { BpCliError } from '../src/providers/byteplus/privateWebshell.js';

describe('bp private sandbox conformance provider', () => {
  it('uses bounded lifecycle calls and fixed private WebShell operations without APIG', async () => {
    let status = 'Creating';
    const bpCalls: string[][] = [];
    const operations: unknown[] = [];
    const executeBp = vi.fn(async (args: string[]) => {
      bpCalls.push(args);
      const action = args[1];
      if (action === 'CreateSandbox') {
        return JSON.stringify({
          ResponseMetadata: { RequestId: 'create-request' },
          Result: { SandboxId: 'sandbox-fixture' },
        });
      }
      if (action === 'DescribeSandbox') {
        return JSON.stringify({
          ResponseMetadata: { RequestId: `describe-${status}` },
          Result: status === 'Ready'
            ? {
                Status: status,
                FunctionId: 'function-fixture',
                Id: 'sandbox-fixture',
                CpuMilli: 1000,
                MemoryMB: 2048,
                RevisionNumber: 1,
                CreatedAt: '2026-07-20T10:00:00Z',
                ExpireAt: '2026-07-20T10:10:00Z',
                ImageInfo: { Id: 'image-fixture' },
                InstanceType: 'pod',
              }
            : { Status: status },
        });
      }
      if (action === 'KillSandbox') {
        status = 'Killed';
        return JSON.stringify({
          ResponseMetadata: { RequestId: 'kill-request' },
          Result: {},
        });
      }
      throw new Error(`unexpected action ${action}`);
    });
    const provider = new BpPrivateSandboxConformanceProvider({
      functionId: 'function-fixture',
      profile: 'dev',
      region: 'ap-southeast-1',
      executeBp,
      runWebshell: vi.fn(async (input) => {
        operations.push(input.operation);
        return { markerMatched: true as const, endpointRequestId: 'webshell-request' };
      }),
      websocketFactory: () => { throw new Error('fixture does not open a socket'); },
      sleep: vi.fn(async () => { status = 'Ready'; }),
    });

    const evidence = await runSandboxConformance(provider, {
      runId: 'private-fixture',
      timeoutMinutes: 10,
      marker: 'private-marker',
    });

    expect(evidence.network).toEqual({
      publicRouteUsed: false,
      signedEndpointSerialized: false,
    });
    expect(bpCalls.map((args) => args[1])).toEqual([
      'CreateSandbox',
      'DescribeSandbox',
      'DescribeSandbox',
      'KillSandbox',
      'DescribeSandbox',
    ]);
    expect(bpCalls.every((args) => !args.join(' ').includes('apig'))).toBe(true);
    expect(operations).toEqual([
      { kind: 'print-marker', marker: 'private-marker' },
      {
        kind: 'write-marker',
        marker: 'private-marker',
        path: '/tmp/managed-agents-conformance.txt',
      },
      {
        kind: 'read-marker',
        marker: 'private-marker',
        path: '/tmp/managed-agents-conformance.txt',
      },
    ]);
    expect(provider.requestIds()).toEqual([
      'create-request',
      'describe-Creating',
      'describe-Ready',
      'webshell-request',
      'webshell-request',
      'webshell-request',
      'kill-request',
      'describe-Killed',
    ]);
    expect(provider.instanceEvidence()).toEqual({
      functionIdMatched: true,
      sandboxIdMatched: true,
      cpuMilli: 1000,
      memoryMB: 2048,
      revisionNumber: 1,
      lifetimeMinutes: 10,
      expiryPresent: true,
      imageConfigured: true,
      instanceType: 'pod',
    });
  });

  it('terminates instead of accepting an incomplete Ready control-plane response', async () => {
    let status = 'Ready';
    const actions: string[] = [];
    const provider = new BpPrivateSandboxConformanceProvider({
      functionId: 'function-fixture',
      profile: 'dev',
      region: 'ap-southeast-1',
      executeBp: async (args) => {
        const action = args[1] ?? '';
        actions.push(action);
        if (action === 'CreateSandbox') {
          return JSON.stringify({ Result: { SandboxId: 'sandbox-fixture' } });
        }
        if (action === 'DescribeSandbox') {
          return JSON.stringify({ Result: { Status: status } });
        }
        if (action === 'KillSandbox') {
          status = 'Killed';
          return JSON.stringify({ Result: {} });
        }
        throw new Error('unexpected action');
      },
      runWebshell: vi.fn(),
      websocketFactory: () => { throw new Error('not reached'); },
      sleep: vi.fn(),
    });

    await expect(runSandboxConformance(provider, {
      runId: 'incomplete-ready',
      timeoutMinutes: 10,
      marker: 'private-marker',
    })).rejects.toThrow('Private sandbox Ready response was incomplete');
    expect(actions).toContain('KillSandbox');
  });

  it('retries eventual ResourceNotFound and accepts it as terminal only after kill', async () => {
    let describeCalls = 0;
    let terminated = false;
    const provider = new BpPrivateSandboxConformanceProvider({
      functionId: 'function-fixture',
      profile: 'dev',
      region: 'ap-southeast-1',
      executeBp: async (args) => {
        const action = args[1];
        if (action === 'CreateSandbox') {
          return JSON.stringify({
            ResponseMetadata: { RequestId: 'create-request' },
            Result: { SandboxId: 'sandbox-fixture' },
          });
        }
        if (action === 'DescribeSandbox') {
          describeCalls += 1;
          if (describeCalls === 1 || terminated) {
            throw new BpCliError(
              'ResourceNotFound',
              describeCalls === 1 ? 'eventual-request' : 'deleted-request',
            );
          }
          return JSON.stringify({
            ResponseMetadata: { RequestId: 'ready-request' },
            Result: {
              Status: 'Ready',
              FunctionId: 'function-fixture',
              Id: 'sandbox-fixture',
              CpuMilli: 1000,
              MemoryMB: 2048,
              RevisionNumber: 1,
              CreatedAt: '2026-07-20T10:00:00Z',
              ExpireAt: '2026-07-20T10:10:00Z',
              ImageInfo: { Id: 'image-fixture' },
              InstanceType: 'pod',
            },
          });
        }
        if (action === 'KillSandbox') {
          terminated = true;
          return JSON.stringify({
            ResponseMetadata: { RequestId: 'kill-request' },
            Result: {},
          });
        }
        throw new Error(`unexpected action ${action}`);
      },
      runWebshell: vi.fn(async () => ({
        markerMatched: true as const,
        endpointRequestId: 'webshell-request',
      })),
      websocketFactory: () => { throw new Error('fixture does not open a socket'); },
      sleep: vi.fn(),
    });

    await expect(runSandboxConformance(provider, {
      runId: 'eventual-fixture',
      timeoutMinutes: 10,
      marker: 'private-marker',
    })).resolves.toMatchObject({
      controlPlane: { ready: true, terminated: true, terminalStatus: 'Deleted' },
      cleanup: { sandboxTerminated: true, terminationVerified: true },
    });
    expect(provider.requestIds()).toEqual([
      'create-request',
      'eventual-request',
      'ready-request',
      'webshell-request',
      'webshell-request',
      'webshell-request',
      'kill-request',
      'deleted-request',
    ]);
  });

  it('uses an explicit disposable-application cascade before reporting terminal cleanup', async () => {
    let status = 'Creating';
    let applicationDeleted = false;
    const afterKill = vi.fn(async (sandboxId: string) => {
      expect(sandboxId).toBe('sandbox-fixture');
      expect(status).toBe('Terminating');
      applicationDeleted = true;
    });
    const provider = new BpPrivateSandboxConformanceProvider({
      functionId: 'function-fixture',
      profile: 'dev',
      region: 'ap-southeast-1',
      executeBp: async (args) => {
        const action = args[1];
        if (action === 'CreateSandbox') {
          return JSON.stringify({
            ResponseMetadata: { RequestId: 'create-request' },
            Result: { SandboxId: 'sandbox-fixture' },
          });
        }
        if (action === 'DescribeSandbox') {
          if (applicationDeleted) {
            throw new BpCliError('ResourceNotFound', 'deleted-request');
          }
          return JSON.stringify({
            ResponseMetadata: { RequestId: `describe-${status}` },
            Result: status === 'Ready'
              ? {
                  Status: status,
                  FunctionId: 'function-fixture',
                  Id: 'sandbox-fixture',
                  CpuMilli: 1000,
                  MemoryMB: 2048,
                  RevisionNumber: 1,
                  CreatedAt: '2026-07-20T10:00:00Z',
                  ExpireAt: '2026-07-20T10:10:00Z',
                  ImageInfo: { Id: 'image-fixture' },
                  InstanceType: 'pod',
                }
              : { Status: status },
          });
        }
        if (action === 'KillSandbox') {
          status = 'Terminating';
          return JSON.stringify({
            ResponseMetadata: { RequestId: 'kill-request' },
            Result: {},
          });
        }
        throw new Error(`unexpected action ${action}`);
      },
      runWebshell: vi.fn(async () => ({
        markerMatched: true as const,
        endpointRequestId: 'webshell-request',
      })),
      websocketFactory: () => { throw new Error('fixture does not open a socket'); },
      sleep: vi.fn(async () => { status = 'Ready'; }),
      afterKill,
    });

    await expect(runSandboxConformance(provider, {
      runId: 'cascade-fixture',
      timeoutMinutes: 10,
      marker: 'private-marker',
    })).resolves.toMatchObject({
      controlPlane: { terminalStatus: 'Deleted' },
      cleanup: { terminationVerified: true },
    });
    expect(afterKill).toHaveBeenCalledTimes(1);
    expect(provider.requestMetadata()).toEqual(expect.arrayContaining([
      { action: 'CreateSandbox', requestId: 'create-request' },
      { action: 'GenWebshellEndpoint', requestId: 'webshell-request' },
      { action: 'KillSandbox', requestId: 'kill-request' },
    ]));
  });
});
