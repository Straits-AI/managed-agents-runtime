import type { ExecResult, SandboxHandle } from './types.js';

export interface SandboxConformanceProvider {
  create(input: { runId: string; timeoutMinutes: number }): Promise<SandboxHandle>;
  describe(handle: SandboxHandle): Promise<{ status: string }>;
  exec(handle: SandboxHandle, command: string): Promise<ExecResult>;
  writeFile(handle: SandboxHandle, path: string, content: string): Promise<void>;
  readFile(handle: SandboxHandle, path: string): Promise<string>;
  terminate(handle: SandboxHandle): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}

export interface SandboxConformanceEvidence {
  schemaVersion: 1;
  runId: string;
  controlPlane: { ready: true; terminated: true; terminalStatus: string };
  dataPlane: { execMarker: true; fileRoundtrip: true };
  network: { publicRouteUsed: false; signedEndpointSerialized: false };
  redaction: { markerIncluded: false; commandOutputIncluded: false };
  cleanup: { sandboxTerminated: true; terminationVerified: true };
}

const TERMINAL_STATUSES = new Set(['Killed', 'Terminated', 'Stopped', 'Deleted']);

export async function runSandboxConformance(
  provider: SandboxConformanceProvider,
  options: { runId: string; timeoutMinutes: number; marker: string },
): Promise<SandboxConformanceEvidence> {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(options.runId)) {
    throw new Error('Sandbox conformance run ID is invalid');
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(options.marker)) {
    throw new Error('Sandbox conformance marker is invalid');
  }
  const handle = await provider.create({
    runId: options.runId,
    timeoutMinutes: options.timeoutMinutes,
  });
  let primaryFailure: Error | null = null;
  let ready = false;
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { status } = await provider.describe(handle);
      if (status === 'Ready') {
        ready = true;
        break;
      }
      if (status === 'Failed') throw new Error('Sandbox conformance startup failed');
      await provider.sleep(3_000);
    }
    if (!ready) throw new Error('Sandbox conformance startup timed out');

    const execution = await provider.exec(handle, `printf %s ${options.marker}`);
    if (execution.exitCode !== 0 || !execution.stdout.includes(options.marker)) {
      throw new Error('Sandbox conformance execution failed');
    }
    await provider.writeFile(handle, '/tmp/managed-agents-conformance.txt', options.marker);
    const readBack = await provider.readFile(handle, '/tmp/managed-agents-conformance.txt');
    if (readBack !== options.marker) {
      throw new Error('Sandbox conformance file roundtrip failed');
    }
  } catch (error) {
    primaryFailure = error instanceof Error
      ? new Error(safeSandboxFailure(error.message))
      : new Error('Sandbox conformance failed');
  }

  await provider.terminate(handle);
  let terminalStatus = 'unknown';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { status } = await provider.describe(handle);
    if (TERMINAL_STATUSES.has(status)) {
      terminalStatus = status;
      break;
    }
    await provider.sleep(1_000);
  }
  if (terminalStatus === 'unknown') {
    throw new Error('Sandbox conformance cleanup could not be verified');
  }
  if (primaryFailure) throw primaryFailure;

  return {
    schemaVersion: 1,
    runId: options.runId,
    controlPlane: { ready: true, terminated: true, terminalStatus },
    dataPlane: { execMarker: true, fileRoundtrip: true },
    network: { publicRouteUsed: false, signedEndpointSerialized: false },
    redaction: { markerIncluded: false, commandOutputIncluded: false },
    cleanup: { sandboxTerminated: true, terminationVerified: true },
  };
}

function safeSandboxFailure(message: string): string {
  if (message === 'Private sandbox Ready response was incomplete') return message;
  return /^Sandbox conformance (startup failed|startup timed out|execution failed|file roundtrip failed)$/.test(message)
    ? message
    : 'Sandbox conformance failed';
}
