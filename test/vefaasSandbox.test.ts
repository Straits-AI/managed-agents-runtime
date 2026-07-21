import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { BytePlusApiError } from '../src/providers/byteplus/signer.js';
import { VefaasSandboxProvider } from '../src/providers/vefaasSandbox.js';

describe('BytePlus private sandbox runtime provider', () => {
  it('waits for Ready, executes privately, and verifies termination', async () => {
    const states: Array<Record<string, unknown> | Error> = [
      new BytePlusApiError(
        'DescribeSandbox',
        'ResourceNotFound',
        'Sandbox not found',
        404,
        'request-creating',
      ),
      { Id: 'sandbox-fixture', Status: 'Ready' },
      { Id: 'sandbox-fixture', Status: 'Deleted' },
    ];
    const lifecycle = {
      createSandbox: vi.fn(async () => ({ SandboxId: 'sandbox-fixture' })),
      describeSandbox: vi.fn(async () => {
        const state = states.shift();
        if (state instanceof Error) throw state;
        return state ?? { Id: 'sandbox-fixture', Status: 'Deleted' };
      }),
      genWebshellEndpoint: vi.fn(async () => ({
        Endpoint: 'wss://sandbox.example/webshell?ticket=runtime-secret',
      })),
      killSandbox: vi.fn(async () => ({})),
      listSandboxes: vi.fn(async () => ({ Sandboxes: [], Total: 0 })),
      getApigDomains: vi.fn(async () => {
        throw new Error('public gateway must not be used');
      }),
    };
    const privateCommand = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'runtime-ok\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'seed-content',
        stderr: '',
      });
    const cfg = loadConfig({
      BYTEPLUS_ACCESS_KEY_ID: 'fixture-ak',
      BYTEPLUS_SECRET_ACCESS_KEY: 'fixture-sk',
      VEFAAS_SANDBOX_FUNCTION_ID: 'function-fixture',
      SANDBOX_TRANSPORT: 'private-webshell',
    });
    const provider = new VefaasSandboxProvider(cfg, {
      lifecycle,
      privateCommand,
      sleep: async () => {},
    });

    const handle = await provider.create({
      runId: 'run-fixture',
      timeoutMinutes: 10,
    });
    expect(handle).toEqual({
      sandboxId: 'sandbox-fixture',
      baseUrl: 'private://webshell',
    });
    await expect(provider.exec(handle, 'printf runtime-ok')).resolves.toEqual({
      exitCode: 0,
      stdout: 'runtime-ok\n',
      stderr: '',
    });
    expect(privateCommand).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'wss://sandbox.example/webshell?ticket=runtime-secret',
      command: 'printf runtime-ok',
      cwd: '/home/gem/workspace',
    }));
    expect(lifecycle.getApigDomains).not.toHaveBeenCalled();

    await expect(provider.writeFile(
      handle,
      '/home/gem/workspace/private-note.txt',
      'seed-content',
    )).resolves.toBeUndefined();
    await expect(provider.readFile(
      handle,
      '/home/gem/workspace/private-note.txt',
    )).resolves.toBe('seed-content');
    for (const call of privateCommand.mock.calls.slice(1)) {
      const command = String(call[0]?.command ?? '');
      expect(command).not.toContain('/home/gem/workspace/private-note.txt');
      expect(command).not.toContain('seed-content');
    }

    await expect(provider.terminate(handle)).resolves.toBeUndefined();
    expect(lifecycle.killSandbox).toHaveBeenCalledWith(
      'function-fixture',
      'sandbox-fixture',
    );
    expect(states).toHaveLength(0);
  });

  it('terminates a Ready instance when explicit APIG discovery fails', async () => {
    const states: Array<Record<string, unknown>> = [
      { Id: 'sandbox-apig', Status: 'Ready' },
      { Id: 'sandbox-apig', Status: 'Deleted' },
    ];
    const lifecycle = {
      createSandbox: vi.fn(async () => ({ SandboxId: 'sandbox-apig' })),
      describeSandbox: vi.fn(async () => states.shift() ?? {
        Id: 'sandbox-apig',
        Status: 'Deleted',
      }),
      genWebshellEndpoint: vi.fn(async () => ({
        Endpoint: 'wss://sandbox.example/webshell?ticket=unused',
      })),
      killSandbox: vi.fn(async () => ({})),
      listSandboxes: vi.fn(async () => ({ Sandboxes: [], Total: 0 })),
      getApigDomains: vi.fn(async () => []),
    };
    const cfg = loadConfig({
      BYTEPLUS_ACCESS_KEY_ID: 'fixture-ak',
      BYTEPLUS_SECRET_ACCESS_KEY: 'fixture-sk',
      VEFAAS_SANDBOX_FUNCTION_ID: 'function-fixture',
      SANDBOX_TRANSPORT: 'apig',
    });
    const provider = new VefaasSandboxProvider(cfg, {
      lifecycle,
      sleep: async () => {},
    });

    await expect(provider.create({
      runId: 'run-apig',
      timeoutMinutes: 10,
    })).rejects.toThrow('No APIG domain found');
    expect(lifecycle.killSandbox).toHaveBeenCalledWith(
      'function-fixture',
      'sandbox-apig',
    );
    expect(states).toHaveLength(0);
  });
});
