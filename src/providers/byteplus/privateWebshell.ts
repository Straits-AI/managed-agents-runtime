import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExecResult } from '../types.js';

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

export async function runPrivateWebshellCommand(input: {
  endpoint: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  commandTimeoutSec?: number;
  maxOutputBytes: number;
  websocketFactory: (endpoint: string) => PrivateWebSocket;
  nonceFactory?: () => string;
}): Promise<ExecResult> {
  const commandBytes = Buffer.byteLength(input.command, 'utf8');
  const cwdBytes = Buffer.byteLength(input.cwd, 'utf8');
  if (commandBytes < 1 || commandBytes > 64 * 1024) {
    throw new Error('Private WebShell command size is invalid');
  }
  if (cwdBytes < 1 || cwdBytes > 4 * 1024) {
    throw new Error('Private WebShell working directory is invalid');
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 605_000) {
    throw new Error('Private WebShell timeout is invalid');
  }
  if (!Number.isSafeInteger(input.maxOutputBytes)
    || input.maxOutputBytes < 1
    || input.maxOutputBytes > 100_000) {
    throw new Error('Private WebShell output bound is invalid');
  }
  const commandTimeoutSec = input.commandTimeoutSec ?? Math.max(1, Math.ceil(input.timeoutMs / 1_000));
  if (!Number.isSafeInteger(commandTimeoutSec) || commandTimeoutSec < 1 || commandTimeoutSec > 600) {
    throw new Error('Private WebShell command timeout is invalid');
  }
  validateSignedEndpoint(input.endpoint);

  const nonce = (input.nonceFactory ?? (() => randomUUID().replaceAll('-', '')))();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(nonce)) {
    throw new Error('Private WebShell protocol nonce is invalid');
  }
  const start = `__managed_agents_${nonce}_start__`;
  const stderrMarker = `__managed_agents_${nonce}_stderr__`;
  const end = `__managed_agents_${nonce}_end__`;
  const tempBase = `/tmp/managed-agents-${nonce}`;
  const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
  const shellCommand = [
    `ma_cmd=$(printf '%s' '${encoded(input.command)}' | base64 -d) || exit 125`,
    `ma_cwd=$(printf '%s' '${encoded(input.cwd)}' | base64 -d) || exit 125`,
    `(cd -- "$ma_cwd" && timeout --signal=TERM --kill-after=5s ${commandTimeoutSec}s sh -c "$ma_cmd") > '${tempBase}.out' 2> '${tempBase}.err'`,
    'ma_rc=$?',
    `printf '%s' '${encoded(start)}' | base64 -d`,
    'printf \'\\n\'',
    'printf \'%s\\n\' "$ma_rc"',
    `base64 < '${tempBase}.out' | tr -d '\\n'`,
    'printf \'\\n\'',
    `printf '%s' '${encoded(stderrMarker)}' | base64 -d`,
    'printf \'\\n\'',
    `base64 < '${tempBase}.err' | tr -d '\\n'`,
    'printf \'\\n\'',
    `rm -f '${tempBase}.out' '${tempBase}.err'`,
    `printf '%s' '${encoded(end)}' | base64 -d`,
    'printf \'\\n\'',
  ].join('; ') + '\n';

  return await new Promise<ExecResult>((resolve, reject) => {
    let socket: PrivateWebSocket;
    let settled = false;
    let output = '';
    const transportBound = Math.min(
      512 * 1024,
      128 * 1024 + commandBytes * 2 + Math.ceil(input.maxOutputBytes * 4 / 3),
    );
    const finish = (result?: ExecResult, failure?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      socket.close();
      if (failure) reject(failure);
      else resolve(result ?? { exitCode: -1, stdout: '', stderr: '' });
    };
    const onOpen = (): void => {
      socket.send(JSON.stringify({ Op: 'stdin', Data: shellCommand }));
    };
    const onMessage = (event: PrivateWebSocketEvent): void => {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data, 'utf8') > 256 * 1024) {
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
      output += frame.Data;
      if (Buffer.byteLength(output, 'utf8') > transportBound) {
        finish(undefined, new Error('Private WebShell output exceeded bound'));
        return;
      }
      try {
        const parsed = parseCommandResult(
          output,
          { start, stderrMarker, end },
          input.maxOutputBytes,
        );
        if (parsed) finish(parsed);
      } catch (error) {
        finish(
          undefined,
          error instanceof Error
            ? error
            : new Error('Private WebShell result was invalid'),
        );
      }
    };
    const onError = (): void => finish(undefined, new Error('Private WebShell connection failed'));
    const onClose = (): void => finish(undefined, new Error('Private WebShell closed before result'));
    const timer = setTimeout(() => {
      finish(undefined, new Error('Private WebShell command timed out'));
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

function parseCommandResult(
  raw: string,
  markers: { start: string; stderrMarker: string; end: string },
  maxOutputBytes: number,
): ExecResult | null {
  const normalized = raw.replaceAll('\r', '');
  const startIndex = normalized.indexOf(`${markers.start}\n`);
  if (startIndex < 0) return null;
  const payload = normalized.slice(startIndex + markers.start.length + 1);
  const endDelimiter = `\n${markers.end}`;
  const endIndex = payload.indexOf(endDelimiter);
  if (endIndex < 0) return null;
  const complete = payload.slice(0, endIndex);
  const firstLine = complete.indexOf('\n');
  const stderrDelimiter = `\n${markers.stderrMarker}\n`;
  const stderrIndex = complete.indexOf(stderrDelimiter);
  if (firstLine < 1 || stderrIndex < firstLine) {
    throw new Error('Private WebShell result was invalid');
  }
  const exitCodeText = complete.slice(0, firstLine);
  if (!/^\d{1,3}$/.test(exitCodeText)) {
    throw new Error('Private WebShell result was invalid');
  }
  const stdout = decodeCommandOutput(
    complete.slice(firstLine + 1, stderrIndex),
    maxOutputBytes,
  );
  const stderr = decodeCommandOutput(
    complete.slice(stderrIndex + stderrDelimiter.length),
    maxOutputBytes,
  );
  if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > maxOutputBytes) {
    throw new Error('Private WebShell output exceeded bound');
  }
  return { exitCode: Number(exitCodeText), stdout, stderr };
}

function decodeCommandOutput(value: string, maxOutputBytes: number): string {
  if (value && (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0)) {
    throw new Error('Private WebShell result was invalid');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength > maxOutputBytes) {
    throw new Error('Private WebShell output exceeded bound');
  }
  return decoded.toString('utf8');
}

export class BpCliError extends Error {
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(code: string | null, requestId: string | null) {
    super('BytePlus CLI request failed');
    this.name = 'BpCliError';
    this.code = code !== null && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(code)
      ? code
      : null;
    this.requestId = requestId !== null && /^[A-Za-z0-9._:-]{1,160}$/.test(requestId)
      ? requestId
      : null;
  }
}

export function parseBpCliFailure(stderr: string): BpCliError {
  const bounded = new TextEncoder().encode(stderr).byteLength <= 64 * 1024 ? stderr : '';
  const code = /(?:^|\n)([A-Za-z][A-Za-z0-9._-]{0,79}):/.exec(bounded)?.[1] ?? null;
  const requestId = /request id:\s*([A-Za-z0-9._:-]{1,160})/i.exec(bounded)?.[1] ?? null;
  return new BpCliError(code, requestId);
}

export async function executeBpCapture(args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile('bp', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 30_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(parseBpCliFailure(stderr));
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
