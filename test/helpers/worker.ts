import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export interface SpawnedWorker {
  proc: ChildProcess;
  kill(): void; // SIGKILL — simulates a crashed worker
  stop(): Promise<void>; // graceful
}

/** Spawn a worker as a real child process so tests can SIGKILL it. */
export function spawnWorker(
  databaseUrl: string,
  env: Record<string, string> = {},
): SpawnedWorker {
  // --import tsx keeps everything in ONE process; a CLI-style `tsx` spawn
  // would run the worker as a grandchild that survives SIGKILL of the
  // wrapper, breaking crash-recovery tests.
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/bin/worker.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        WORKER_EPOCH: 'scripted',
        LEASE_TTL_MS: '1500',
        HEARTBEAT_MS: '400',
        POLL_MS: '200',
        MAX_ATTEMPTS: '5',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  proc.stdout!.on('data', () => {});
  proc.stderr!.on('data', (d) => process.env.WORKER_DEBUG && console.error(String(d)));

  return {
    proc,
    kill() {
      proc.kill('SIGKILL');
    },
    async stop() {
      // A signal-killed process has exitCode null but signalCode set.
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill('SIGTERM');
      // Escalate to SIGKILL if graceful shutdown stalls, so a stuck worker
      // can never leak into the next test.
      const forceKill = setTimeout(() => proc.kill('SIGKILL'), 5_000);
      await new Promise((r) => proc.once('exit', r));
      clearTimeout(forceKill);
    },
  };
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? 30_000;
  const interval = opts.intervalMs ?? 150;
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out${opts.label ? `: ${opts.label}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
