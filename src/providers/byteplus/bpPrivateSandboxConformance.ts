import type { ExecResult, SandboxHandle } from '../types.js';
import type { SandboxConformanceProvider } from '../sandboxConformance.js';
import {
  BpCliError,
  createNodePrivateWebSocket,
  executeBpCapture,
  runBpPrivateWebshellOperation,
  type BpPrivateWebshellResult,
  type PrivateWebshellOperation,
  type PrivateWebSocket,
} from './privateWebshell.js';

type BpExecutor = (args: string[]) => Promise<string>;
type WebshellRunner = (input: {
  functionId: string;
  instanceName: string;
  profile: string;
  region: string;
  operation: PrivateWebshellOperation;
  timeoutMs: number;
  executeBp: BpExecutor;
  websocketFactory: (endpoint: string) => PrivateWebSocket;
}) => Promise<BpPrivateWebshellResult>;

export interface PrivateSandboxInstanceEvidence {
  functionIdMatched: true;
  sandboxIdMatched: true;
  cpuMilli: number;
  memoryMB: number;
  revisionNumber: number;
  lifetimeMinutes: number;
  expiryPresent: true;
  imageConfigured: true;
  instanceType: string;
}

export class BpPrivateSandboxConformanceProvider implements SandboxConformanceProvider {
  private readonly functionId: string;
  private readonly profile: string;
  private readonly region: string;
  private readonly executeBp: BpExecutor;
  private readonly runWebshell: WebshellRunner;
  private readonly websocketFactory: (endpoint: string) => PrivateWebSocket;
  private readonly sleepFn: (milliseconds: number) => Promise<void>;
  private readonly afterKill: ((sandboxId: string) => Promise<void>) | undefined;
  private readonly observedRequestIds: string[] = [];
  private readonly observedRequestMetadata: Array<{ action: string; requestId: string }> = [];
  private readonly expectedFileMarkers = new Map<string, string>();
  private readonly terminatedSandboxIds = new Set<string>();
  private observedInstance: PrivateSandboxInstanceEvidence | null = null;

  constructor(input: {
    functionId: string;
    profile: string;
    region: string;
    executeBp?: BpExecutor;
    runWebshell?: WebshellRunner;
    websocketFactory?: (endpoint: string) => PrivateWebSocket;
    sleep?: (milliseconds: number) => Promise<void>;
    afterKill?: (sandboxId: string) => Promise<void>;
  }) {
    for (const [name, value] of [
      ['function ID', input.functionId],
      ['profile', input.profile],
      ['region', input.region],
    ] as const) {
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(value)) {
        throw new Error(`Private sandbox ${name} is invalid`);
      }
    }
    this.functionId = input.functionId;
    this.profile = input.profile;
    this.region = input.region;
    this.executeBp = input.executeBp ?? executeBpCapture;
    this.runWebshell = input.runWebshell ?? runBpPrivateWebshellOperation;
    this.websocketFactory = input.websocketFactory ?? createNodePrivateWebSocket;
    this.afterKill = input.afterKill;
    this.sleepFn = input.sleep ?? (async (milliseconds) => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    });
  }

  requestIds(): string[] {
    return [...this.observedRequestIds];
  }

  requestMetadata(): Array<{ action: string; requestId: string }> {
    return this.observedRequestMetadata.map((metadata) => ({ ...metadata }));
  }

  instanceEvidence(): PrivateSandboxInstanceEvidence | null {
    return this.observedInstance === null ? null : { ...this.observedInstance };
  }

  async create(input: { runId: string; timeoutMinutes: number }): Promise<SandboxHandle> {
    if (input.timeoutMinutes !== 10) {
      throw new Error('Private sandbox conformance lifetime must be ten minutes');
    }
    const result = await this.call('CreateSandbox', [
      '--body', JSON.stringify({
        FunctionId: this.functionId,
        Timeout: input.timeoutMinutes,
        CpuMilli: 1000,
        MemoryMB: 2048,
        MaxConcurrency: 1,
        RequestTimeout: 60,
        Metadata: { runId: input.runId },
      }),
    ]);
    const sandboxId = typeof result.SandboxId === 'string'
      ? result.SandboxId
      : typeof result.Id === 'string'
        ? result.Id
        : null;
    if (!sandboxId || !/^[A-Za-z0-9._-]{1,240}$/.test(sandboxId)) {
      throw new Error('Private sandbox create response was invalid');
    }
    return { sandboxId, baseUrl: 'private://webshell' };
  }

  async describe(handle: SandboxHandle): Promise<{ status: string }> {
    let result: Record<string, unknown>;
    try {
      result = await this.call('DescribeSandbox', [
        '--FunctionId', this.functionId,
        '--SandboxId', handle.sandboxId,
      ]);
    } catch (error) {
      if (error instanceof BpCliError && error.code === 'ResourceNotFound') {
        this.captureFailureRequestId(error);
        return {
          status: this.terminatedSandboxIds.has(handle.sandboxId) ? 'Deleted' : 'Creating',
        };
      }
      throw error;
    }
    const status = typeof result.Status === 'string' && /^[A-Za-z]+$/.test(result.Status)
      ? result.Status
      : 'unknown';
    if (status === 'Ready') this.captureReadyEvidence(result, handle);
    return { status };
  }

  async exec(handle: SandboxHandle, command: string): Promise<ExecResult> {
    const match = /^printf %s ([A-Za-z0-9._-]{1,80})$/.exec(command);
    if (!match?.[1]) throw new Error('Private sandbox conformance command is invalid');
    const marker = match[1];
    await this.webshell(handle, { kind: 'print-marker', marker });
    return { exitCode: 0, stdout: marker, stderr: '' };
  }

  async writeFile(handle: SandboxHandle, path: string, content: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(content)) {
      throw new Error('Private sandbox conformance file marker is invalid');
    }
    await this.webshell(handle, { kind: 'write-marker', marker: content, path });
    this.expectedFileMarkers.set(handle.sandboxId, content);
  }

  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    const marker = this.expectedFileMarkers.get(handle.sandboxId);
    if (!marker) throw new Error('Private sandbox conformance file marker is unavailable');
    await this.webshell(handle, { kind: 'read-marker', marker, path });
    return marker;
  }

  async terminate(handle: SandboxHandle): Promise<void> {
    try {
      await this.call('KillSandbox', [
        '--FunctionId', this.functionId,
        '--SandboxId', handle.sandboxId,
      ]);
    } catch (error) {
      if (!(error instanceof BpCliError) || error.code !== 'ResourceNotFound') throw error;
      this.captureFailureRequestId(error);
    }
    this.terminatedSandboxIds.add(handle.sandboxId);
    this.expectedFileMarkers.delete(handle.sandboxId);
    await this.afterKill?.(handle.sandboxId);
  }

  async sleep(milliseconds: number): Promise<void> {
    await this.sleepFn(milliseconds);
  }

  private async webshell(
    handle: SandboxHandle,
    operation: PrivateWebshellOperation,
  ): Promise<void> {
    const result = await this.runWebshell({
      functionId: this.functionId,
      instanceName: handle.sandboxId,
      profile: this.profile,
      region: this.region,
      operation,
      timeoutMs: 15_000,
      executeBp: this.executeBp,
      websocketFactory: this.websocketFactory,
    });
    if (result.endpointRequestId) {
      this.observedRequestIds.push(result.endpointRequestId);
      this.observedRequestMetadata.push({
        action: 'GenWebshellEndpoint',
        requestId: result.endpointRequestId,
      });
    }
  }

  private async call(action: string, args: string[]): Promise<Record<string, unknown>> {
    let stdout: string;
    try {
      stdout = await this.executeBp([
        'vefaas', action,
        ...args,
        '---profile', this.profile,
        '---region', this.region,
      ]);
    } catch (error) {
      if (error instanceof BpCliError) throw error;
      throw new Error(`Private sandbox ${action} request failed`);
    }
    if (new TextEncoder().encode(stdout).byteLength > 64 * 1024) {
      throw new Error(`Private sandbox ${action} response exceeded bound`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`Private sandbox ${action} response was invalid`);
    }
    const envelope = parsed as {
      ResponseMetadata?: { RequestId?: unknown; Error?: unknown };
      Result?: unknown;
    };
    if (envelope.ResponseMetadata?.Error || typeof envelope.Result !== 'object' || envelope.Result === null) {
      throw new Error(`Private sandbox ${action} request failed`);
    }
    const requestId = envelope.ResponseMetadata?.RequestId;
    if (typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
      this.observedRequestIds.push(requestId);
      this.observedRequestMetadata.push({ action, requestId });
    }
    return envelope.Result as Record<string, unknown>;
  }

  private captureFailureRequestId(error: BpCliError): void {
    if (error.requestId) this.observedRequestIds.push(error.requestId);
  }

  private captureReadyEvidence(
    result: Record<string, unknown>,
    handle: SandboxHandle,
  ): void {
    const imageInfo = result.ImageInfo;
    const imageConfigured = typeof imageInfo === 'object'
      && imageInfo !== null
      && (typeof (imageInfo as Record<string, unknown>).Id === 'string'
        || typeof (imageInfo as Record<string, unknown>).Image === 'string');
    const cpuMilli = positiveInteger(result.CpuMilli);
    const memoryMB = positiveInteger(result.MemoryMB);
    const revisionNumber = positiveInteger(result.RevisionNumber);
    const createdAt = typeof result.CreatedAt === 'string' ? Date.parse(result.CreatedAt) : NaN;
    const expireAt = typeof result.ExpireAt === 'string' ? Date.parse(result.ExpireAt) : NaN;
    const lifetimeMinutes = (expireAt - createdAt) / 60_000;
    const expiryPresent = Number.isFinite(createdAt)
      && Number.isFinite(expireAt)
      && lifetimeMinutes > 0
      && lifetimeMinutes <= 10;
    const instanceType = typeof result.InstanceType === 'string'
      && /^[A-Za-z0-9._-]{1,80}$/.test(result.InstanceType)
      ? result.InstanceType
      : null;
    if (
      result.FunctionId !== this.functionId
      || result.Id !== handle.sandboxId
      || cpuMilli !== 1000
      || memoryMB !== 2048
      || revisionNumber === null
      || !expiryPresent
      || !imageConfigured
      || instanceType === null
    ) {
      throw new Error('Private sandbox Ready response was incomplete');
    }
    this.observedInstance = {
      functionIdMatched: true,
      sandboxIdMatched: true,
      cpuMilli,
      memoryMB,
      revisionNumber,
      lifetimeMinutes,
      expiryPresent: true,
      imageConfigured: true,
      instanceType,
    };
  }
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
    ? value
    : null;
}
