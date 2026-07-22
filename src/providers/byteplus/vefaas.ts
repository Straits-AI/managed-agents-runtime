import { signedCallWithMetadata } from './signer.js';

/**
 * veFaaS Cloud Sandbox lifecycle client (control plane). API shape
 * confirmed from @agent-infra/sandbox: POST /?Action=<X>&Version=2024-06-06,
 * service 'vefaas' (plus 'apig' for route discovery).
 */
export interface VefaasClientOptions {
  host: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  onResponseMetadata?: (metadata: VefaasResponseMetadata) => void;
}

export interface VefaasResponseMetadata {
  service: 'vefaas' | 'apig';
  action: string;
  requestId: string | null;
}

const VEFAAS_VERSION = '2024-06-06';
const APIG_VERSION = '2022-11-12';

export interface CreateSandboxResult {
  SandboxId?: string;
  Id?: string;
  [k: string]: unknown;
}

export interface SandboxInfo {
  Id?: string;
  SandboxId?: string;
  Status?: string;
  [k: string]: unknown;
}

export interface WebshellEndpointResult {
  Endpoint?: string;
  [k: string]: unknown;
}

export class VefaasClient {
  constructor(private readonly opts: VefaasClientOptions) {}

  private async call<T>(
    service: 'vefaas' | 'apig',
    action: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await signedCallWithMetadata<T>({
      host: this.opts.host,
      region: this.opts.region,
      service,
      action,
      version: service === 'vefaas' ? VEFAAS_VERSION : APIG_VERSION,
      body: JSON.stringify(body),
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      sessionToken: this.opts.sessionToken,
    });
    try {
      this.opts.onResponseMetadata?.({
        service,
        action,
        requestId: response.requestId,
      });
    } catch {
      // Evidence observers must not change runtime lifecycle semantics.
    }
    return response.result;
  }

  createSandbox(input: {
    functionId: string;
    timeoutMinutes: number;
    envs?: Record<string, string>;
    image?: string;
    command?: string;
    cpuMilli?: number;
    memoryMB?: number;
    metadata?: Record<string, string>;
  }): Promise<CreateSandboxResult> {
    return this.call<CreateSandboxResult>('vefaas', 'CreateSandbox', {
      FunctionId: input.functionId,
      Timeout: input.timeoutMinutes,
      Envs: input.envs,
      // Official InstanceImageInfoForCreateSandboxInput fields are `Image`
      // (URL) and `Command`; an image override without a command is a 400
      // ("Command is empty"). Omit entirely to inherit the released app.
      InstanceImageInfo: input.image
        ? { Image: input.image, Command: input.command }
        : undefined,
      CpuMilli: input.cpuMilli,
      MemoryMB: input.memoryMB,
      Metadata: input.metadata,
    });
  }

  describeSandbox(functionId: string, sandboxId: string): Promise<SandboxInfo> {
    return this.call<SandboxInfo>('vefaas', 'DescribeSandbox', {
      FunctionId: functionId,
      SandboxId: sandboxId,
    });
  }

  listSandboxes(
    functionId: string,
    opts: { pageNumber?: number; pageSize?: number; status?: string } = {},
  ): Promise<{ Sandboxes?: SandboxInfo[]; Total?: number }> {
    return this.call('vefaas', 'ListSandboxes', {
      FunctionId: functionId,
      PageNumber: opts.pageNumber ?? 1,
      PageSize: opts.pageSize ?? 10,
      Status: opts.status,
    });
  }

  setSandboxTimeout(
    functionId: string,
    sandboxId: string,
    timeoutMinutes: number,
  ): Promise<unknown> {
    return this.call('vefaas', 'SetSandboxTimeout', {
      FunctionId: functionId,
      SandboxId: sandboxId,
      Timeout: timeoutMinutes,
    });
  }

  killSandbox(functionId: string, sandboxId: string): Promise<unknown> {
    return this.call('vefaas', 'KillSandbox', {
      FunctionId: functionId,
      SandboxId: sandboxId,
    });
  }

  genWebshellEndpoint(
    functionId: string,
    instanceName: string,
  ): Promise<WebshellEndpointResult> {
    return this.call<WebshellEndpointResult>('vefaas', 'GenWebshellEndpoint', {
      FunctionId: functionId,
      InstanceName: instanceName,
    });
  }

  /**
   * Discover the sandbox function's public APIG domain(s):
   * ListTriggers → apig trigger's UpstreamId → ListRoutes → Domains.
   * A specific instance is addressed via ?faasInstanceName=<sandboxId>.
   */
  async getApigDomains(functionId: string): Promise<string[]> {
    const triggers = await this.call<{
      Items?: { Type?: string; DetailedConfig?: string }[];
    }>('vefaas', 'ListTriggers', { FunctionId: functionId });

    let upstreamId: string | undefined;
    for (const item of triggers.Items ?? []) {
      if (item.Type === 'apig' && item.DetailedConfig) {
        try {
          upstreamId = (JSON.parse(item.DetailedConfig) as { UpstreamId?: string })
            .UpstreamId;
          if (upstreamId) break;
        } catch {
          // malformed config entry; try the next trigger
        }
      }
    }
    if (!upstreamId) return [];

    const routes = await this.call<{
      Items?: {
        MatchRule?: { Path?: { MatchContent?: string } };
        Domains?: { Domain?: string }[];
      }[];
    }>('apig', 'ListRoutes', {
      UpstreamId: upstreamId,
      PageSize: 100,
      PageNumber: 1,
    });

    const domains: string[] = [];
    for (const route of routes.Items ?? []) {
      const prefix = route.MatchRule?.Path?.MatchContent ?? '';
      for (const d of route.Domains ?? []) {
        if (d.Domain) domains.push(`${d.Domain}${prefix}`);
      }
    }
    return domains;
  }

  /** Instance-scoped base URL for the in-sandbox REST API. */
  static instanceUrl(domain: string, sandboxId: string): string {
    const base = domain.startsWith('http') ? domain : `https://${domain}`;
    return base.includes('?')
      ? `${base}&faasInstanceName=${sandboxId}`
      : `${base}?faasInstanceName=${sandboxId}`;
  }
}
