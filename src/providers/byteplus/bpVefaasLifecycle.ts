import { createBpProvisioningApi } from './bpProvisioningApi.js';
import type {
  CreateSandboxResult,
  SandboxInfo,
  VefaasResponseMetadata,
  WebshellEndpointResult,
} from './vefaas.js';

export class BpVefaasLifecycle {
  private readonly api: ReturnType<typeof createBpProvisioningApi>;
  private readonly onResponseMetadata: ((metadata: VefaasResponseMetadata) => void) | undefined;

  constructor(input: {
    profile: string;
    region: string;
    executeBp?: (args: string[]) => Promise<string>;
    onResponseMetadata?: (metadata: VefaasResponseMetadata) => void;
  }) {
    this.api = createBpProvisioningApi(input);
    this.onResponseMetadata = input.onResponseMetadata;
  }

  createSandbox(input: {
    functionId: string;
    timeoutMinutes: number;
    envs?: Record<string, string>;
    image?: string;
    command?: string;
    port?: number;
    cpuMilli?: number;
    memoryMB?: number;
    metadata?: Record<string, string>;
  }): Promise<CreateSandboxResult> {
    return this.call('CreateSandbox', {
      FunctionId: input.functionId,
      Timeout: input.timeoutMinutes,
      Envs: input.envs === undefined
        ? undefined
        : Object.entries(input.envs).map(([Key, Value]) => ({ Key, Value })),
      InstanceImageInfo: input.image
        ? { Image: input.image, Command: input.command, Port: input.port }
        : undefined,
      CpuMilli: input.cpuMilli,
      MemoryMB: input.memoryMB,
      Metadata: input.metadata,
    });
  }

  describeSandbox(functionId: string, sandboxId: string): Promise<SandboxInfo> {
    return this.call('DescribeSandbox', { FunctionId: functionId, SandboxId: sandboxId });
  }

  listSandboxes(
    functionId: string,
    options: {
      pageNumber?: number;
      pageSize?: number;
      sandboxId?: string;
      status?: string;
      metadata?: Record<string, string>;
    } = {},
  ): Promise<{ Sandboxes?: SandboxInfo[]; Total?: number }> {
    return this.call('ListSandboxes', {
      FunctionId: functionId,
      PageNumber: options.pageNumber ?? 1,
      PageSize: options.pageSize ?? 10,
      SandboxId: options.sandboxId,
      Status: options.status,
      Metadata: options.metadata,
    });
  }

  killSandbox(functionId: string, sandboxId: string): Promise<unknown> {
    return this.call('KillSandbox', { FunctionId: functionId, SandboxId: sandboxId });
  }

  genWebshellEndpoint(
    functionId: string,
    instanceName: string,
  ): Promise<WebshellEndpointResult> {
    return this.call('GenWebshellEndpoint', {
      FunctionId: functionId,
      InstanceName: instanceName,
    });
  }

  async getApigDomains(_functionId: string): Promise<string[]> {
    throw new Error('bp-backed private lifecycle does not expose APIG discovery');
  }

  private async call<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.api(action, body);
    try {
      this.onResponseMetadata?.({
        service: 'vefaas',
        action,
        requestId: response.requestId,
      });
    } catch {
      // Evidence observers must not alter lifecycle behavior.
    }
    return response.result as T;
  }
}
