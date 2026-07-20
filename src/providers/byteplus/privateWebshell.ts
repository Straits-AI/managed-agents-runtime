import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';

export interface PrivateWebSocketEvent {
  data?: unknown;
}

export interface PrivateWebSocket {
  addEventListener(type: string, listener: (event: PrivateWebSocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: PrivateWebSocketEvent) => void): void;
  send(data: string): void;
  close(): void;
}

export interface PrivateWebshellResult {
  markerMatched: true;
}

export type PrivateWebshellOperation =
  | { kind: 'print-marker'; marker: string }
  | { kind: 'write-marker'; marker: string; path: string }
  | { kind: 'read-marker'; marker: string; path: string };

interface PrivateWebshellEndpointLease {
  endpoint: string;
  requestId: string | null;
}

export interface BpPrivateWebshellResult extends PrivateWebshellResult {
  endpointRequestId: string | null;
}

export async function executeBpCapture(args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile('bp', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 30_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(new Error('BytePlus CLI request failed'));
        return;
      }
      resolve(stdout);
    });
  });
}

export function createNodePrivateWebSocket(endpoint: string): PrivateWebSocket {
  const WebSocketConstructor = (globalThis as unknown as {
    WebSocket?: new (url: string) => PrivateWebSocket;
  }).WebSocket;
  if (!WebSocketConstructor) {
    throw new Error('Private WebShell client is unavailable');
  }
  return new WebSocketConstructor(endpoint);
}

export async function runBpPrivateWebshellOperation(input: {
  functionId: string;
  instanceName: string;
  profile: string;
  region: string;
  operation: PrivateWebshellOperation;
  timeoutMs: number;
  executeBp: (args: string[]) => Promise<string>;
  websocketFactory: (endpoint: string) => PrivateWebSocket;
}): Promise<BpPrivateWebshellResult> {
  const lease = await requestPrivateWebshellEndpoint(input);
  const result = await runPrivateWebshellOperation({
    endpoint: lease.endpoint,
    operation: input.operation,
    timeoutMs: input.timeoutMs,
    websocketFactory: input.websocketFactory,
  });
  return {
    ...result,
    endpointRequestId: lease.requestId,
  };
}

async function requestPrivateWebshellEndpoint(input: {
  functionId: string;
  instanceName: string;
  profile: string;
  region: string;
  executeBp: (args: string[]) => Promise<string>;
}): Promise<PrivateWebshellEndpointLease> {
  for (const [name, value] of [
    ['function ID', input.functionId],
    ['instance name', input.instanceName],
    ['profile', input.profile],
    ['region', input.region],
  ] as const) {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(value)) {
      throw new Error(`Private WebShell ${name} is invalid`);
    }
  }

  let stdout: string;
  try {
    stdout = await input.executeBp([
      'vefaas', 'GenWebshellEndpoint',
      '--FunctionId', input.functionId,
      '--InstanceName', input.instanceName,
      '---profile', input.profile,
      '---region', input.region,
    ]);
  } catch {
    throw new Error('Private WebShell endpoint request failed');
  }
  if (new TextEncoder().encode(stdout).byteLength > 64 * 1024) {
    throw new Error('Private WebShell endpoint response exceeded bound');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Private WebShell endpoint response was invalid');
  }
  const response = parsed as {
    ResponseMetadata?: { RequestId?: unknown; Error?: unknown };
    Result?: { Endpoint?: unknown };
  };
  if (response.ResponseMetadata?.Error) {
    throw new Error('Private WebShell endpoint request failed');
  }
  const endpoint = response.Result?.Endpoint;
  if (typeof endpoint !== 'string') {
    throw new Error('Private WebShell endpoint response was invalid');
  }
  validateSignedEndpoint(endpoint);
  const requestId = response.ResponseMetadata?.RequestId;
  return {
    endpoint,
    requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(requestId)
      ? requestId
      : null,
  };
}

export async function runPrivateWebshellOperation(input: {
  endpoint: string;
  operation: PrivateWebshellOperation;
  timeoutMs: number;
  websocketFactory: (endpoint: string) => PrivateWebSocket;
}): Promise<PrivateWebshellResult> {
  const marker = input.operation.marker;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(marker)) {
    throw new Error('Private WebShell marker is invalid');
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000) {
    throw new Error('Private WebShell timeout is invalid');
  }
  const command = operationCommand(input.operation);
  validateSignedEndpoint(input.endpoint);

  return await new Promise<PrivateWebshellResult>((resolve, reject) => {
    let socket: PrivateWebSocket;
    let settled = false;
    let outputBytes = 0;
    const finish = (result?: PrivateWebshellResult, failure?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      socket.close();
      if (failure) reject(failure);
      else resolve(result ?? { markerMatched: true });
    };
    const onOpen = (): void => {
      socket.send(JSON.stringify({
        Op: 'stdin',
        Data: command,
      }));
    };
    const onMessage = (event: PrivateWebSocketEvent): void => {
      if (typeof event.data !== 'string' || event.data.length > 64 * 1024) {
        finish(undefined, new Error('Private WebShell frame was invalid'));
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        finish(undefined, new Error('Private WebShell frame was invalid'));
        return;
      }
      if (!isStdoutFrame(frame)) {
        finish(undefined, new Error('Private WebShell frame contract changed'));
        return;
      }
      outputBytes += new TextEncoder().encode(frame.Data).byteLength;
      if (outputBytes > 64 * 1024) {
        finish(undefined, new Error('Private WebShell output exceeded bound'));
        return;
      }
      if (frame.Data.includes(marker)) finish({ markerMatched: true });
    };
    const onError = (): void => {
      finish(undefined, new Error('Private WebShell connection failed'));
    };
    const onClose = (): void => {
      finish(undefined, new Error('Private WebShell closed before marker'));
    };
    const timer = setTimeout(() => {
      finish(undefined, new Error('Private WebShell marker timed out'));
    }, input.timeoutMs);
    timer.unref?.();

    try {
      socket = input.websocketFactory(input.endpoint);
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    } catch {
      clearTimeout(timer);
      reject(new Error('Private WebShell connection failed'));
    }
  });
}

function operationCommand(operation: PrivateWebshellOperation): string {
  const encodedMarker = Buffer.from(operation.marker, 'utf8').toString('base64');
  if (operation.kind === 'print-marker') {
    return `printf '%s' '${encodedMarker}' | base64 -d; printf '\\n'\n`;
  }
  if (operation.path !== '/tmp/managed-agents-conformance.txt') {
    throw new Error('Private WebShell path is invalid');
  }
  if (operation.kind === 'write-marker') {
    return `printf '%s' '${encodedMarker}' | base64 -d > '${operation.path}'; printf '%s' '${encodedMarker}' | base64 -d; printf '\\n'\n`;
  }
  return `cat '${operation.path}'\n`;
}

function validateSignedEndpoint(value: string): void {
  try {
    if (value.length > 8 * 1024) throw new Error('invalid');
    const parsed = new URL(value);
    if (parsed.protocol !== 'wss:' || !parsed.hostname || !parsed.searchParams.get('ticket')) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('Private WebShell endpoint was invalid');
  }
}

function isStdoutFrame(value: unknown): value is { Op: 'stdout'; Data: string } {
  return typeof value === 'object'
    && value !== null
    && 'Op' in value
    && value.Op === 'stdout'
    && 'Data' in value
    && typeof value.Data === 'string';
}
