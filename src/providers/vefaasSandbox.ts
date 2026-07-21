import { SandboxClient } from '@agent-infra/sandbox';
import type { Config } from '../config.js';
import { requireConfig } from '../config.js';
import { VefaasClient } from './byteplus/vefaas.js';
import type { CreateSandboxResult, SandboxInfo, WebshellEndpointResult } from './byteplus/vefaas.js';
import { BytePlusApiError } from './byteplus/signer.js';
import {
  createNodePrivateWebSocket,
  runPrivateWebshellCommand,
  type PrivateWebSocket,
} from './byteplus/privateWebshell.js';
import type { ExecResult, SandboxHandle, SandboxProvider } from './types.js';
import { WORKSPACE_DIR } from '../harness/workspace.js';

interface VefaasSandboxLifecycle {
  createSandbox(input: Parameters<VefaasClient['createSandbox']>[0]): Promise<CreateSandboxResult>;
  describeSandbox(functionId: string, sandboxId: string): Promise<SandboxInfo>;
  killSandbox(functionId: string, sandboxId: string): Promise<unknown>;
  genWebshellEndpoint(functionId: string, instanceName: string): Promise<WebshellEndpointResult>;
  getApigDomains(functionId: string): Promise<string[]>;
  listSandboxes: VefaasClient['listSandboxes'];
}

type PrivateCommandRunner = typeof runPrivateWebshellCommand;

export interface VefaasSandboxProviderDependencies {
  lifecycle?: VefaasSandboxLifecycle;
  privateCommand?: PrivateCommandRunner;
  websocketFactory?: (endpoint: string) => PrivateWebSocket;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * BytePlus veFaaS Cloud Sandbox provider: lifecycle via our signed
 * control-plane client; in-sandbox exec/files through secret-isolated private
 * WebShell by default, or the AIO REST API through explicitly selected APIG.
 */
export class VefaasSandboxProvider implements SandboxProvider {
  private readonly vefaas: VefaasSandboxLifecycle;
  private readonly functionId: string;
  private readonly defaultImage: string | undefined;
  private readonly defaultCommand: string | undefined;
  private readonly configuredDomain: string | undefined;
  private readonly gatewayApiKey: string | undefined;
  private readonly transport: 'private-webshell' | 'apig';
  private readonly privateCommand: PrivateCommandRunner;
  private readonly websocketFactory: (endpoint: string) => PrivateWebSocket;
  private readonly sleepFn: (milliseconds: number) => Promise<void>;
  private readonly terminatedSandboxIds = new Set<string>();
  private domainCache: string | null = null;

  constructor(cfg: Config, dependencies: VefaasSandboxProviderDependencies = {}) {
    const required = requireConfig(cfg, [
      'BYTEPLUS_ACCESS_KEY_ID',
      'BYTEPLUS_SECRET_ACCESS_KEY',
      'VEFAAS_SANDBOX_FUNCTION_ID',
    ]);
    this.vefaas = dependencies.lifecycle ?? new VefaasClient({
      host: cfg.BYTEPLUS_OPENAPI_HOST,
      region: cfg.BYTEPLUS_REGION,
      accessKeyId: required.BYTEPLUS_ACCESS_KEY_ID,
      secretAccessKey: required.BYTEPLUS_SECRET_ACCESS_KEY,
      sessionToken: cfg.BYTEPLUS_SESSION_TOKEN,
    });
    this.functionId = required.VEFAAS_SANDBOX_FUNCTION_ID;
    this.defaultImage = cfg.SANDBOX_IMAGE;
    this.defaultCommand = cfg.SANDBOX_STARTUP_COMMAND;
    this.configuredDomain = cfg.SANDBOX_GATEWAY_DOMAIN;
    this.gatewayApiKey = cfg.SANDBOX_GATEWAY_API_KEY;
    this.transport = cfg.SANDBOX_TRANSPORT;
    this.privateCommand = dependencies.privateCommand ?? runPrivateWebshellCommand;
    this.websocketFactory = dependencies.websocketFactory ?? createNodePrivateWebSocket;
    this.sleepFn = dependencies.sleep ?? (async (milliseconds) => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    });
  }

  /** Exposed for preflight checks. */
  get lifecycle(): VefaasSandboxLifecycle {
    return this.vefaas;
  }

  private async apigDomain(): Promise<string> {
    if (this.configuredDomain) return this.configuredDomain;
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
    // The APIG route's Key Auth plugin reads the API key from the
    // Authorization header; without it the gateway returns 401 before the
    // request reaches the sandbox.
    const headers = this.gatewayApiKey
      ? { Authorization: this.gatewayApiKey }
      : undefined;
    return new SandboxClient({ environment: handle.baseUrl, headers });
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
      // Only override the image per-call; otherwise the instance inherits the
      // released app's image AND startup command. Overriding Image without also
      // supplying Command is a 400 ("Command is empty").
      image: req.image,
      command: req.image ? this.defaultCommand : undefined,
      cpuMilli: req.cpuMilli,
      memoryMB: req.memoryMB,
      metadata: { runId: req.runId },
    });
    const sandboxId = (result.SandboxId ?? result.Id) as string | undefined;
    if (!sandboxId) {
      throw new Error(`CreateSandbox returned no sandbox id: ${JSON.stringify(result)}`);
    }
    const privateHandle = { sandboxId, baseUrl: 'private://webshell' };
    try {
      await this.waitForReady(privateHandle);
      if (this.transport === 'private-webshell') return privateHandle;
      const domain = await this.apigDomain();
      return {
        sandboxId,
        baseUrl: domain.startsWith('http') ? domain : `https://${domain}`,
      };
    } catch (error) {
      await this.terminate(privateHandle).catch(() => {});
      throw error;
    }
  }

  async exec(
    handle: SandboxHandle,
    command: string,
    opts: { timeoutSec?: number; cwd?: string } = {},
  ): Promise<ExecResult> {
    if (this.transport === 'private-webshell') {
      return await this.execPrivate(handle, command, opts);
    }
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
    if (this.transport === 'private-webshell') {
      const encodedPath = Buffer.from(path, 'utf8').toString('base64');
      const encodedContent = Buffer.from(content, 'utf8').toString('base64');
      const result = await this.execPrivate(
        handle,
        `ma_path=$(printf '%s' '${encodedPath}' | base64 -d) && ` +
          `mkdir -p -- "$(dirname -- "$ma_path")" && ` +
          `printf '%s' '${encodedContent}' | base64 -d > "$ma_path"`,
        { timeoutSec: 60, cwd: WORKSPACE_DIR },
      );
      if (result.exitCode !== 0) {
        throw new Error(`private file.writeFile failed with exit ${result.exitCode}`);
      }
      return;
    }
    const res = await this.client(handle).file.writeFile(
      { file: path, content },
      this.route(handle),
    );
    if (!res.ok) {
      throw new Error(`file.writeFile failed: ${JSON.stringify(res.error).slice(0, 500)}`);
    }
  }

  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    if (this.transport === 'private-webshell') {
      const encodedPath = Buffer.from(path, 'utf8').toString('base64');
      const result = await this.execPrivate(
        handle,
        `ma_path=$(printf '%s' '${encodedPath}' | base64 -d) && cat -- "$ma_path"`,
        { timeoutSec: 60, cwd: WORKSPACE_DIR },
      );
      if (result.exitCode !== 0) {
        throw new Error(`private file.readFile failed with exit ${result.exitCode}`);
      }
      return result.stdout;
    }
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
    try {
      const info = await this.vefaas.describeSandbox(this.functionId, handle.sandboxId);
      return { status: (info.Status as string | undefined) ?? 'unknown' };
    } catch (error) {
      if (error instanceof BytePlusApiError && error.code === 'ResourceNotFound') {
        return {
          status: this.terminatedSandboxIds.has(handle.sandboxId) ? 'Deleted' : 'Creating',
        };
      }
      throw error;
    }
  }

  async terminate(handle: SandboxHandle): Promise<void> {
    try {
      await this.vefaas.killSandbox(this.functionId, handle.sandboxId);
    } catch (error) {
      if (!(error instanceof BytePlusApiError) || error.code !== 'ResourceNotFound') throw error;
    }
    this.terminatedSandboxIds.add(handle.sandboxId);
    await this.waitForTerminal(handle);
  }

  /** Best-effort kill by id (used by the reaper for orphaned sandboxes). */
  async terminateById(sandboxId: string): Promise<void> {
    await this.terminate({ sandboxId, baseUrl: 'private://webshell' });
  }

  private async execPrivate(
    handle: SandboxHandle,
    command: string,
    opts: { timeoutSec?: number; cwd?: string },
  ): Promise<ExecResult> {
    const timeoutSec = opts.timeoutSec ?? 300;
    if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) {
      throw new Error('sandbox command timeout must be between 1 and 600 seconds');
    }
    const lease = await this.vefaas.genWebshellEndpoint(this.functionId, handle.sandboxId);
    if (typeof lease.Endpoint !== 'string') {
      throw new Error('Private WebShell endpoint response was invalid');
    }
    return await this.privateCommand({
      endpoint: lease.Endpoint,
      command,
      cwd: opts.cwd ?? WORKSPACE_DIR,
      timeoutMs: timeoutSec * 1_000 + 5_000,
      commandTimeoutSec: timeoutSec,
      maxOutputBytes: 100_000,
      websocketFactory: this.websocketFactory,
    });
  }

  private async waitForReady(handle: SandboxHandle): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { status } = await this.describe(handle);
      if (status === 'Ready') return;
      if (status === 'Failed' || status === 'Deleted' || status === 'Terminated') {
        throw new Error(`sandbox entered terminal state before Ready: ${status}`);
      }
      await this.sleepFn(2_000);
    }
    throw new Error('sandbox did not become Ready before deadline');
  }

  private async waitForTerminal(handle: SandboxHandle): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { status } = await this.describe(handle);
      if (status === 'Deleted' || status === 'Terminated') return;
      await this.sleepFn(1_000);
    }
    throw new Error('sandbox termination was not verified before deadline');
  }
}
