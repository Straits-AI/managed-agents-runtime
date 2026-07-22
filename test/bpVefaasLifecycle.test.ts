import { describe, expect, it, vi } from 'vitest';
import { BpVefaasLifecycle } from '../src/providers/byteplus/bpVefaasLifecycle.js';

describe('bp-backed veFaaS lifecycle', () => {
  it('maps the production lifecycle contract without exposing profile credentials', async () => {
    const calls: string[][] = [];
    const metadata = vi.fn();
    const lifecycle = new BpVefaasLifecycle({
      profile: 'dev',
      region: 'ap-southeast-1',
      onResponseMetadata: metadata,
      executeBp: async (args) => {
        calls.push(args);
        return JSON.stringify({
          ResponseMetadata: { RequestId: `request-${args[1]}` },
          Result: args[1] === 'CreateSandbox'
            ? { SandboxId: 'sandbox-fixture' }
            : { Sandboxes: [], Total: 0 },
        });
      },
    });

    await expect(lifecycle.createSandbox({
      functionId: 'function-fixture',
      timeoutMinutes: 10,
      metadata: { runId: 'run-fixture' },
    })).resolves.toEqual({ SandboxId: 'sandbox-fixture' });
    await expect(lifecycle.listSandboxes('function-fixture', {
      pageNumber: 1,
      pageSize: 100,
      sandboxId: 'sandbox-fixture',
    })).resolves.toEqual({ Sandboxes: [], Total: 0 });

    expect(JSON.parse(calls[0]?.[3] ?? '{}')).toMatchObject({
      FunctionId: 'function-fixture',
      Timeout: 10,
      Metadata: { runId: 'run-fixture' },
    });
    expect(JSON.parse(calls[1]?.[3] ?? '{}')).toMatchObject({
      FunctionId: 'function-fixture',
      SandboxId: 'sandbox-fixture',
      PageNumber: 1,
      PageSize: 100,
    });
    expect(calls.every((args) => args.includes('dev') && args.includes('ap-southeast-1')))
      .toBe(true);
    expect(metadata).toHaveBeenCalledWith({
      service: 'vefaas',
      action: 'CreateSandbox',
      requestId: 'request-CreateSandbox',
    });
  });
});
