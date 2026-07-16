import { SandboxClient } from '@agent-infra/sandbox';
import type { Config } from '../config.js';
import { requireConfig } from '../config.js';
import { VefaasClient } from './byteplus/vefaas.js';
import type { ExecResult, SandboxHandle, SandboxProvider } from './types.js';

/**
 * BytePlus veFaaS Cloud Sandbox provider: lifecycle via our signed
 * control-plane client; in-sandbox exec/files via the AIO sandbox REST API
 * (typed @agent-infra/sandbox client), instance-routed with the
 * faasInstanceName query parameter.
 */
export class VefaasSandboxProvider implements SandboxProvider {
  private readonly vefaas: VefaasClient;
  private readonly functionId: string;
  private readonly defaultImage: string | undefined;
  private domainCache: string | null = null;

  constructor(cfg: Config) {
    const required = requireConfig(cfg, [
      'BYTEPLUS_ACCESS_KEY_ID',
      'BYTEPLUS_SECRET_ACCESS_KEY',
      'VEFAAS_SANDBOX_FUNCTION_ID',
    ]);
    this.vefaas = new VefaasClient({
      host: cfg.BYTEPLUS_OPENAPI_HOST,
      region: cfg.BYTEPLUS_REGION,
      accessKeyId: required.BYTEPLUS_ACCESS_KEY_ID,
      secretAccessKey: required.BYTEPLUS_SECRET_ACCESS_KEY,
      sessionToken: cfg.BYTEPLUS_SESSION_TOKEN,
    });
    this.functionId = required.VEFAAS_SANDBOX_FUNCTION_ID;
    this.defaultImage = cfg.SANDBOX_IMAGE;
  }

  /** Exposed for preflight checks. */
  get lifecycle(): VefaasClient {
    return this.vefaas;
  }

  private async apigDomain(): Promise<string> {
    if (this.domainCache) return this.domainCache;
    const domains = await this.vefaas.getApigDomains(this.functionId);
    // Prefer a public https domain when several routes exist.
    const domain = domains.find((d) => !d.includes('internal')) ?? domains[0];
    if (!domain) {
      throw new Error(
        `No APIG domain found for sandbox function ${this.functionId} — ` +
          `is the Code Sandbox Agent application deployed with an API gateway?`,
      );
    }
    this.domainCache = domain;
    return domain;
  }

  private client(handle: SandboxHandle): SandboxClient {
    return new SandboxClient({ environment: handle.baseUrl });
  }

  private route(handle: SandboxHandle) {
    return { queryParams: { faasInstanceName: handle.sandboxId } };
  }

  async create(req: {
    runId: string;
    timeoutMinutes: number;
    image?: string;
    envs?: Record<string, string>;
    cpuMilli?: number;
    memoryMB?: number;
  }): Promise<SandboxHandle> {
    const result = await this.vefaas.createSandbox({
      functionId: this.functionId,
      timeoutMinutes: req.timeoutMinutes,
      envs: req.envs,
      image: req.image ?? this.defaultImage,
      cpuMilli: req.cpuMilli,
      memoryMB: req.memoryMB,
      metadata: { runId: req.runId },
    });
    const sandboxId = (result.SandboxId ?? result.Id) as string | undefined;
    if (!sandboxId) {
      throw new Error(`CreateSandbox returned no sandbox id: ${JSON.stringify(result)}`);
    }
    const domain = await this.apigDomain();
    const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
    return { sandboxId, baseUrl };
  }

  async exec(
    handle: SandboxHandle,
    command: string,
    opts: { timeoutSec?: number; cwd?: string } = {},
  ): Promise<ExecResult> {
    const res = await this.client(handle).bash.exec(
      {
        command,
        exec_dir: opts.cwd,
        timeout: opts.timeoutSec ?? 300,
        max_output_length: 100_000,
      },
      this.route(handle),
    );
    if (!res.ok) {
      throw new Error(`bash.exec failed: ${JSON.stringify(res.error).slice(0, 500)}`);
    }
    const data = res.body.data;
    if (!data) {
      throw new Error(
        `bash.exec returned no data: ${JSON.stringify(res.body).slice(0, 500)}`,
      );
    }
    return {
      exitCode: data.exit_code ?? -1,
      stdout: data.stdout ?? '',
      stderr: data.stderr ?? '',
    };
  }

  async writeFile(handle: SandboxHandle, path: string, content: string): Promise<void> {
    const res = await this.client(handle).file.writeFile(
      { file: path, content },
      this.route(handle),
    );
    if (!res.ok) {
      throw new Error(`file.writeFile failed: ${JSON.stringify(res.error).slice(0, 500)}`);
    }
  }

  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    const res = await this.client(handle).file.readFile(
      { file: path },
      this.route(handle),
    );
    if (!res.ok) {
      throw new Error(`file.readFile failed: ${JSON.stringify(res.error).slice(0, 500)}`);
    }
    const content = (res.body.data as { content?: string } | undefined)?.content;
    if (content === undefined) {
      throw new Error(`file.readFile returned no content for ${path}`);
    }
    return content;
  }

  async describe(handle: SandboxHandle): Promise<{ status: string }> {
    const info = await this.vefaas.describeSandbox(this.functionId, handle.sandboxId);
    return { status: (info.Status as string | undefined) ?? 'unknown' };
  }

  async terminate(handle: SandboxHandle): Promise<void> {
    await this.vefaas.killSandbox(this.functionId, handle.sandboxId);
  }

  /** Best-effort kill by id (used by the reaper for orphaned sandboxes). */
  async terminateById(sandboxId: string): Promise<void> {
    await this.vefaas.killSandbox(this.functionId, sandboxId);
  }
}
