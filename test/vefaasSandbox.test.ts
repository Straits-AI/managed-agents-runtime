import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { BytePlusApiError } from '../src/providers/byteplus/signer.js';
import { VefaasSandboxProvider } from '../src/providers/vefaasSandbox.js';

describe('BytePlus private sandbox runtime provider', () => {
  it('finds and kills an exact run-owned instance after an ambiguous create error', async () => {
    let listed = 0;
    const lifecycle = {
      createSandbox: vi.fn(async () => {
        throw new BytePlusApiError(
          'CreateSandbox',
          'InvalidOperation',
          'startup failed',
          403,
          'request-create-failed',
        );
      }),
      describeSandbox: vi.fn(),
      genWebshellEndpoint: vi.fn(),
      killSandbox: vi.fn(async () => ({})),
      listSandboxes: vi.fn(async () => {
        listed += 1;
        return listed === 1
          ? {
              Sandboxes: [{
                Id: 'sandbox-failed-create',
                FunctionId: 'function-fixture',
                Metadata: { runId: 'run-ambiguous' },
                Status: 'Failed',
              }],
              Total: 1,
            }
          : { Sandboxes: [], Total: 0 };
      }),
      getApigDomains: vi.fn(),
    };
    const cfg = loadConfig({
      BYTEPLUS_ACCESS_KEY_ID: 'fixture-ak',
      BYTEPLUS_SECRET_ACCESS_KEY: 'fixture-sk',
      VEFAAS_SANDBOX_FUNCTION_ID: 'function-fixture',
      SANDBOX_TRANSPORT: 'private-webshell',
    });
    const provider = new VefaasSandboxProvider(cfg, {
      lifecycle,
      sleep: async () => {},
    });

    await expect(provider.create({
      runId: 'run-ambiguous',
      timeoutMinutes: 10,
    })).rejects.toThrow('startup failed');
    expect(lifecycle.listSandboxes).toHaveBeenCalledWith(
      'function-fixture',
      expect.objectContaining({ metadata: { runId: 'run-ambiguous' } }),
    );
    expect(lifecycle.killSandbox).toHaveBeenCalledWith(
      'function-fixture',
      'sandbox-failed-create',
    );
  });

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
    const fileContent = 'private-file-content-'.repeat(2_500);
    const privateCommand = vi.fn(async (input: { command: string }) => {
      if (input.command === 'printf runtime-ok') {
        return { exitCode: 0, stdout: 'runtime-ok\n', stderr: '' };
      }
      if (input.command.includes('cat --')) {
        return { exitCode: 0, stdout: fileContent, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
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
    expect(privateCommand).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'wss://sandbox.example/webshell?ticket=runtime-secret',
      command: "mkdir -p -- '/home/gem/workspace'",
      cwd: '/',
    }));
    privateCommand.mockClear();
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
      fileContent,
    )).resolves.toBeUndefined();
    await expect(provider.readFile(
      handle,
      '/home/gem/workspace/private-note.txt',
    )).resolves.toBe(fileContent);
    for (const call of privateCommand.mock.calls.slice(1)) {
      const command = String(call[0]?.command ?? '');
      expect(Buffer.byteLength(command, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      expect(command).not.toContain('/home/gem/workspace/private-note.txt');
      expect(command).not.toContain(fileContent);
    }

    await expect(provider.terminate(handle)).resolves.toBeUndefined();
    expect(lifecycle.killSandbox).toHaveBeenCalledWith(
      'function-fixture',
      'sandbox-fixture',
    );
    expect(states).toHaveLength(0);
  });

  it('accepts an exact provider Terminating tombstone after KillSandbox', async () => {
    const states: Array<Record<string, unknown>> = [
      { Id: 'sandbox-terminating', Status: 'Ready' },
      { Id: 'sandbox-terminating', Status: 'Terminating' },
    ];
    const lifecycle = {
      createSandbox: vi.fn(async () => ({ SandboxId: 'sandbox-terminating' })),
      describeSandbox: vi.fn(async () => states.shift() ?? {
        Id: 'sandbox-terminating', Status: 'Terminating',
      }),
      genWebshellEndpoint: vi.fn(async () => ({
        Endpoint: 'wss://sandbox.example/webshell?ticket=runtime-secret',
      })),
      killSandbox: vi.fn(async () => ({})),
      listSandboxes: vi.fn(async () => ({ Sandboxes: [], Total: 0 })),
      getApigDomains: vi.fn(),
    };
    const cfg = loadConfig({
      BYTEPLUS_ACCESS_KEY_ID: 'fixture-ak',
      BYTEPLUS_SECRET_ACCESS_KEY: 'fixture-sk',
      VEFAAS_SANDBOX_FUNCTION_ID: 'function-fixture',
      SANDBOX_TRANSPORT: 'private-webshell',
    });
    const provider = new VefaasSandboxProvider(cfg, {
      lifecycle,
      privateCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      sleep: async () => {},
    });

    const handle = await provider.create({
      runId: 'run-terminating',
      timeoutMinutes: 10,
    });
    await expect(provider.terminate(handle)).resolves.toBeUndefined();
    expect(lifecycle.killSandbox).toHaveBeenCalledWith(
      'function-fixture',
      'sandbox-terminating',
    );
    expect(states).toHaveLength(0);
  });

  it('retries only idempotent private file operations after an uncertain transport timeout', async () => {
    const lifecycle = {
      createSandbox: vi.fn(),
      describeSandbox: vi.fn(),
      genWebshellEndpoint: vi.fn(async () => ({
        Endpoint: 'wss://sandbox.example/webshell?ticket=runtime-secret',
      })),
      killSandbox: vi.fn(),
      listSandboxes: vi.fn(),
      getApigDomains: vi.fn(),
    };
    const privateCommand = vi.fn()
      .mockRejectedValueOnce(new Error('Private WebShell command timed out'))
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const sleep = vi.fn(async () => {});
    const provider = new VefaasSandboxProvider(loadConfig({
      BYTEPLUS_ACCESS_KEY_ID: 'fixture-ak',
      BYTEPLUS_SECRET_ACCESS_KEY: 'fixture-sk',
      VEFAAS_SANDBOX_FUNCTION_ID: 'function-fixture',
      SANDBOX_TRANSPORT: 'private-webshell',
    }), { lifecycle, privateCommand, sleep });
    const handle = { sandboxId: 'sandbox-fixture', baseUrl: 'private://webshell' };

    await expect(provider.writeFile(
      handle,
      '/home/gem/workspace/retry.txt',
      'retry-safe-content',
    )).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledWith(500);
    expect(privateCommand).toHaveBeenCalledTimes(3);
    expect(privateCommand.mock.calls[0]?.[0].command)
      .toBe(privateCommand.mock.calls[1]?.[0].command);
    expect(privateCommand.mock.calls[2]?.[0].command).toContain('dd ');
    expect(privateCommand.mock.calls[2]?.[0].command).not.toContain('>>');
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

  it('keeps the APIG data plane available only when explicitly selected', async () => {
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
      genWebshellEndpoint: vi.fn(async () => {
        throw new Error('private WebShell must not be used');
      }),
      killSandbox: vi.fn(async () => ({})),
      listSandboxes: vi.fn(async () => ({ Sandboxes: [], Total: 0 })),
      getApigDomains: vi.fn(async () => ['sandbox.example/runtime']),
    };
    const apigClient = {
      bash: {
        exec: vi.fn(async () => ({
          ok: true,
          body: { data: { exit_code: 0, stdout: 'apig-ok\n', stderr: '' } },
        })),
      },
      file: {
        writeFile: vi.fn(async () => ({ ok: true, body: {} })),
        readFile: vi.fn(async () => ({
          ok: true,
          body: { data: { content: 'apig-file' } },
        })),
      },
    };
    const cfg = loadConfig({
      BYTEPLUS_ACCESS_KEY_ID: 'fixture-ak',
      BYTEPLUS_SECRET_ACCESS_KEY: 'fixture-sk',
      VEFAAS_SANDBOX_FUNCTION_ID: 'function-fixture',
      SANDBOX_TRANSPORT: 'apig',
    });
    const provider = new VefaasSandboxProvider(cfg, {
      lifecycle,
      apigClientFactory: () => apigClient,
      sleep: async () => {},
    });

    const handle = await provider.create({ runId: 'run-apig', timeoutMinutes: 10 });
    expect(handle).toEqual({
      sandboxId: 'sandbox-apig',
      baseUrl: 'https://sandbox.example/runtime',
    });
    expect(apigClient.bash.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "mkdir -p -- '/home/gem/workspace'",
        exec_dir: '/',
      }),
      { queryParams: { faasInstanceName: 'sandbox-apig' } },
    );
    apigClient.bash.exec.mockClear();
    await expect(provider.exec(handle, 'printf apig-ok')).resolves.toEqual({
      exitCode: 0,
      stdout: 'apig-ok\n',
      stderr: '',
    });
    await expect(provider.writeFile(handle, '/tmp/apig.txt', 'apig-file'))
      .resolves.toBeUndefined();
    await expect(provider.readFile(handle, '/tmp/apig.txt')).resolves.toBe('apig-file');
    expect(lifecycle.genWebshellEndpoint).not.toHaveBeenCalled();
    await expect(provider.terminate(handle)).resolves.toBeUndefined();
  });
});
