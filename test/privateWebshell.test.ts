import { describe, expect, it } from 'vitest';
import {
  runBpPrivateWebshellOperation,
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
