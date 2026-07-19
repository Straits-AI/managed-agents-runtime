import type { Config } from '../config.js';
import type { RunRow } from '../core/types.js';

/**
 * Benchmark-only fault injection (memo §24). A fault point named on the
 * run hard-kills the worker process at that exact spot — indistinguishable
 * from a crash. Inert unless HARNESS_ENABLE_FAULTS=1.
 */
export type FaultPoint =
  | 'after_external_commit'
  | 'before_external_commit'
  | 'before_mcp_dispatch'
  | 'after_mcp_remote_commit'
  | 'after_mcp_receipt_commit'
  | 'after_checkpoint';

export function maybeCrash(cfg: Config, run: RunRow, point: FaultPoint): void {
  if (cfg.HARNESS_ENABLE_FAULTS !== 1) return;
  if (!run.debug_fault_points.includes(point)) return;
  console.error(`[faults] injected crash at ${point} for ${run.id}`);
  process.kill(process.pid, 'SIGKILL');
}
