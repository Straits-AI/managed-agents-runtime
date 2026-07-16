import type { Pool } from 'pg';
import type { SandboxHandle, SandboxProvider } from '../providers/types.js';
import { WORKSPACE_DIR } from './workspace.js';

/**
 * Deterministic completion verification (memo §16.3). The agent's claim of
 * completion is independently checked before the run may COMPLETE.
 */
export interface VerifierPolicy {
  /** Workspace-relative paths that must exist. */
  requiredArtifacts?: string[];
  /** Command that must exit 0 in the workspace (e.g. "npm test"). */
  command?: string;
  /** Fail verification while any tool receipt is unresolved. */
  requireReceiptsSettled?: boolean;
}

export interface VerifyResult {
  passed: boolean;
  failures: string[];
}

export async function verify(input: {
  pool: Pool;
  runId: string;
  policy: VerifierPolicy;
  claimedArtifacts: string[];
  sandbox: SandboxHandle;
  sandboxProvider: SandboxProvider;
}): Promise<VerifyResult> {
  const failures: string[] = [];
  const artifacts = [
    ...new Set([...(input.policy.requiredArtifacts ?? []), ...input.claimedArtifacts]),
  ];

  for (const path of artifacts) {
    const abs = path.startsWith('/') ? path : `${WORKSPACE_DIR}/${path}`;
    const res = await input.sandboxProvider.exec(input.sandbox, `test -e '${abs}'`);
    if (res.exitCode !== 0) failures.push(`required artifact missing: ${path}`);
  }

  if (input.policy.command) {
    const res = await input.sandboxProvider.exec(input.sandbox, input.policy.command, {
      cwd: WORKSPACE_DIR,
      timeoutSec: 600,
    });
    if (res.exitCode !== 0) {
      failures.push(
        `verification command failed (exit ${res.exitCode}): ${input.policy.command}\n` +
          `${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`,
      );
    }
  }

  if (input.policy.requireReceiptsSettled !== false) {
    const { rows } = await input.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM tool_receipts
       WHERE run_id = $1 AND status IN ('PENDING', 'NEEDS_RECONCILIATION')`,
      [input.runId],
    );
    if (rows[0]!.n !== '0') {
      failures.push(`${rows[0]!.n} tool receipt(s) unresolved`);
    }
  }

  return { passed: failures.length === 0, failures };
}
