import { exec } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { ExecResult, SandboxHandle, SandboxProvider } from '../types.js';
import { WORKSPACE_DIR } from '../../harness/workspace.js';

/**
 * Local child-process sandbox for the no-BytePlus stack (memo §21 portability).
 * A drop-in for VefaasSandboxProvider: each sandbox gets a temp root, and the
 * kernel's logical WORKSPACE_DIR (and /tmp) are transparently remapped into it,
 * so the workspace/checkpoint flow works unchanged.
 *
 * ⚠️ SECURITY: commands run on the HOST with NO isolation. This is for local
 * development, tests, and portability demos only — never for untrusted agents
 * in production (use a real isolated SandboxProvider there).
 */
export class LocalSandboxProvider implements SandboxProvider {
  private readonly roots = new Map<string, string>();

  async create(req: {
    runId: string;
    timeoutMinutes?: number;
    image?: string;
    envs?: Record<string, string>;
    cpuMilli?: number;
    memoryMB?: number;
  }): Promise<SandboxHandle> {
    const root = mkdtempSync(join(tmpdir(), `ma-local-${req.runId}-`));
    mkdirSync(join(root, 'workspace'), { recursive: true });
    mkdirSync(join(root, 'tmp'), { recursive: true });
    const sandboxId = `local-${root.split('-').pop()}`;
    this.roots.set(sandboxId, root);
    return { sandboxId, baseUrl: 'local' };
  }

  private root(handle: SandboxHandle): string {
    const r = this.roots.get(handle.sandboxId);
    if (!r) throw new Error(`unknown local sandbox ${handle.sandboxId}`);
    return r;
  }

  /** Remap logical paths (WORKSPACE_DIR, /tmp) into this sandbox's temp root. */
  private mapText(handle: SandboxHandle, s: string): string {
    const root = this.root(handle);
    return s.split(WORKSPACE_DIR).join(join(root, 'workspace')).split('/tmp/').join(join(root, 'tmp') + '/');
  }

  async exec(
    handle: SandboxHandle,
    command: string,
    opts: { timeoutSec?: number; cwd?: string } = {},
  ): Promise<ExecResult> {
    const root = this.root(handle);
    const cwd = this.mapText(handle, opts.cwd ?? WORKSPACE_DIR);
    return new Promise((resolve) => {
      exec(
        this.mapText(handle, command),
        { cwd, timeout: (opts.timeoutSec ?? 300) * 1000, maxBuffer: 64 * 1024 * 1024, shell: '/bin/bash', env: { ...process.env, HOME: root } },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
          resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }

  async writeFile(handle: SandboxHandle, path: string, content: string): Promise<void> {
    const p = this.mapText(handle, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    return readFileSync(this.mapText(handle, path), 'utf8');
  }
  async describe(): Promise<{ status: string }> {
    return { status: 'Ready' };
  }
  async terminate(handle: SandboxHandle): Promise<void> {
    const root = this.roots.get(handle.sandboxId);
    if (root) {
      rmSync(root, { recursive: true, force: true });
      this.roots.delete(handle.sandboxId);
    }
  }
}
