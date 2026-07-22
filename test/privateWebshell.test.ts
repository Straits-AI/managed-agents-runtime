import { describe, expect, it } from 'vitest';
import {
  parseBpCliFailure,
  runBpPrivateWebshellOperation,
  runPrivateWebshellCommand,
  runPrivateWebshellOperation,
  type PrivateWebSocket,
  type PrivateWebSocketEvent,
} from '../src/providers/byteplus/privateWebshell.js';

class FixtureSocket implements PrivateWebSocket {
  readonly sent: string[] = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Set<(event: PrivateWebSocketEvent) => void>>();

  addEventListener(type: string, listener: (event: PrivateWebSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: PrivateWebSocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  emit(type: string, event: PrivateWebSocketEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('private BytePlus WebShell transport', () => {
  it('returns bounded exit, stdout, and stderr from an echoed terminal session', async () => {
    const endpoint = 'wss://sandbox.example/webshell?ticket=runtime-secret';
    const socket = new FixtureSocket();
    const pending = runPrivateWebshellCommand({
      endpoint,
      command: 'printf runtime-output; printf runtime-warning >&2; exit 7',
      cwd: '/home/gem/workspace',
      timeoutMs: 1_000,
      maxOutputBytes: 100_000,
      nonceFactory: () => 'runtimefixture',
      websocketFactory: () => {
        queueMicrotask(() => {
          socket.emit('open');
          socket.emit('message', {
            data: JSON.stringify({
              Op: 'stdout',
              Data: [
                'terminal echo that must be ignored',
                '__managed_agents_runtimefixture_start__',
                '7',
                Buffer.from('runtime-output').toString('base64'),
                '__managed_agents_runtimefixture_stderr__',
                Buffer.from('runtime-warning').toString('base64'),
                '__managed_agents_runtimefixture_end__',
                '',
              ].join('\r\n'),
            }),
          });
        });
        return socket;
      },
    });

    await expect(pending).resolves.toEqual({
      exitCode: 7,
      stdout: 'runtime-output',
      stderr: 'runtime-warning',
    });
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).not.toContain('runtime-output');
    expect(socket.sent[0]).not.toContain('runtime-warning');
    expect(socket.sent[0]).not.toContain('/home/gem/workspace');
    expect(JSON.stringify(await pending)).not.toContain('runtime-secret');
    expect(socket.closeCalls).toBe(1);
  });

  it('rejects a malformed command result through the transport promise', async () => {
    const socket = new FixtureSocket();
    const pending = runPrivateWebshellCommand({
      endpoint: 'wss://sandbox.example/webshell?ticket=malformed-secret',
      command: 'true',
      cwd: '/home/gem/workspace',
      timeoutMs: 1_000,
      maxOutputBytes: 100_000,
      nonceFactory: () => 'malformedfixture',
      websocketFactory: () => {
        queueMicrotask(() => {
          socket.emit('open');
          socket.emit('message', {
            data: JSON.stringify({
              Op: 'stdout',
              Data: [
                '__managed_agents_malformedfixture_start__',
                '0',
                'not-base64!',
                '__managed_agents_malformedfixture_stderr__',
                '',
                '__managed_agents_malformedfixture_end__',
                '',
              ].join('\n'),
            }),
          });
        });
        return socket;
      },
    });

    await expect(pending).rejects.toThrow('Private WebShell result was invalid');
    await expect(pending).rejects.not.toThrow('malformed-secret');
    expect(socket.closeCalls).toBe(1);
  });

  it('extracts only bounded provider metadata from CLI failures', () => {
    const failure = parseBpCliFailure([
      'ResourceNotFound: Sandbox not found; ticket=never-serialize-this',
      '\tstatus code: 404, request id: 20260721171237DF94A49687A6AC1634BF',
    ].join('\n'));

    expect(failure).toMatchObject({
      code: 'ResourceNotFound',
      requestId: '20260721171237DF94A49687A6AC1634BF',
    });
    expect(JSON.stringify(failure)).not.toContain('never-serialize-this');
    expect(failure.message).toBe('BytePlus CLI request failed');
  });

  it('combines endpoint acquisition and execution into metadata-only output', async () => {
    const endpoint = 'wss://sandbox.example/webshell?ticket=combined-secret';
    const socket = new FixtureSocket();
    let capturedArgs: string[] = [];
    const pending = runBpPrivateWebshellOperation({
      functionId: 'function-fixture',
      instanceName: 'sandbox-fixture',
      profile: 'dev',
      region: 'ap-southeast-1',
      operation: { kind: 'print-marker', marker: 'combined-marker' },
      timeoutMs: 1_000,
      executeBp: async (args) => {
        capturedArgs = args;
        return JSON.stringify({
          ResponseMetadata: { RequestId: 'combined-request' },
          Result: { Endpoint: endpoint },
        });
      },
      websocketFactory: () => {
        queueMicrotask(() => {
          socket.emit('open');
          socket.emit('message', {
            data: JSON.stringify({ Op: 'stdout', Data: 'combined-marker\n' }),
          });
        });
        return socket;
      },
    });

    await expect(pending).resolves.toEqual({
      markerMatched: true,
      endpointRequestId: 'combined-request',
    });
    expect(JSON.stringify(await pending)).not.toContain('combined-secret');
    expect(JSON.stringify(await pending)).not.toContain('combined-marker');
    expect(capturedArgs).toEqual([
      'vefaas', 'GenWebshellEndpoint',
      '--FunctionId', 'function-fixture',
      '--InstanceName', 'sandbox-fixture',
      '---profile', 'dev',
      '---region', 'ap-southeast-1',
    ]);
    expect(JSON.stringify(capturedArgs)).not.toContain('ticket=');
  });

  it('executes one fixed marker without returning the signed endpoint or command output', async () => {
    const endpoint = 'wss://sandbox.example/webshell?ticket=secret-ticket';
    const socket = new FixtureSocket();
    const pending = runPrivateWebshellOperation({
      endpoint,
      operation: { kind: 'print-marker', marker: 'canary-marker' },
      timeoutMs: 1_000,
      websocketFactory: (value) => {
        expect(value).toBe(endpoint);
        queueMicrotask(() => {
          socket.emit('open');
          socket.emit('message', {
            data: JSON.stringify({ Op: 'stdout', Data: 'canary-marker\n' }),
          });
        });
        return socket;
      },
    });

    await expect(pending).resolves.toEqual({ markerMatched: true });
    expect(socket.sent).toEqual([
      JSON.stringify({
        Op: 'stdin',
        Data: "printf '%s' 'Y2FuYXJ5LW1hcmtlcg==' | base64 -d; printf '\\n'\n",
      }),
    ]);
    expect(socket.sent[0]).not.toContain('canary-marker');
    expect(socket.closeCalls).toBe(1);
    expect(JSON.stringify(await pending)).not.toContain('secret-ticket');
    expect(JSON.stringify(await pending)).not.toContain('canary-marker');
  });

  it('closes with a sanitized failure when cumulative stdout exceeds the bound', async () => {
    const endpoint = 'wss://sandbox.example/webshell?ticket=never-report-this';
    const socket = new FixtureSocket();
    const pending = runPrivateWebshellOperation({
      endpoint,
      operation: { kind: 'print-marker', marker: 'bounded-marker' },
      timeoutMs: 1_000,
      websocketFactory: () => socket,
    });

    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({ Op: 'stdout', Data: 'a'.repeat(40 * 1024) }),
    });
    socket.emit('message', {
      data: JSON.stringify({ Op: 'stdout', Data: 'b'.repeat(40 * 1024) }),
    });

    await expect(pending).rejects.toThrow('Private WebShell output exceeded bound');
    await expect(pending).rejects.not.toThrow('never-report-this');
    await expect(pending).rejects.not.toThrow('bounded-marker');
    expect(socket.closeCalls).toBe(1);
  });

  it('supports only the fixed marker file roundtrip operations', async () => {
    const endpoint = 'wss://sandbox.example/webshell?ticket=file-roundtrip';
    const run = async (
      operation:
        | { kind: 'write-marker'; marker: string; path: string }
        | { kind: 'read-marker'; marker: string; path: string },
    ): Promise<string> => {
      const socket = new FixtureSocket();
      const pending = runPrivateWebshellOperation({
        endpoint,
        operation,
        timeoutMs: 1_000,
        websocketFactory: () => {
          queueMicrotask(() => {
            socket.emit('open');
            socket.emit('message', {
              data: JSON.stringify({ Op: 'stdout', Data: `${operation.marker}\n` }),
            });
          });
          return socket;
        },
      });
      await expect(pending).resolves.toEqual({ markerMatched: true });
      return socket.sent[0] ?? '';
    };

    const path = '/tmp/managed-agents-conformance.txt';
    await expect(run({ kind: 'write-marker', marker: 'file-marker', path })).resolves.toBe(
      JSON.stringify({
        Op: 'stdin',
        Data: "printf '%s' 'ZmlsZS1tYXJrZXI=' | base64 -d > '/tmp/managed-agents-conformance.txt'; printf '%s' 'ZmlsZS1tYXJrZXI=' | base64 -d; printf '\\n'\n",
      }),
    );
    await expect(run({ kind: 'read-marker', marker: 'file-marker', path })).resolves.toBe(
      JSON.stringify({
        Op: 'stdin',
        Data: "cat '/tmp/managed-agents-conformance.txt'\n",
      }),
    );
  });
});
