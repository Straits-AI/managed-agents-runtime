import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';

type Q = Pool | Tx;

export interface CapabilityGrantRow {
  id: string;
  run_id: string;
  action_pattern: string;
  resource_pattern: string;
  requires_approval: boolean;
  max_calls: number | null;
  calls_used: number;
  expires_at: Date | null;
  created_at: Date;
}

/** Glob-lite matching: '*' wildcard segments, e.g. 'external.http.*'. */
export function patternMatches(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern.split('*').map(escapeRegExp).join('.*')}$`,
  );
  return re.test(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function listGrants(q: Q, runId: string): Promise<CapabilityGrantRow[]> {
  const { rows } = await q.query<CapabilityGrantRow>(
    'SELECT * FROM capability_grants WHERE run_id = $1',
    [runId],
  );
  return rows;
}

export type GrantDecision =
  | { allowed: false; reason: string }
  | { allowed: true; grant: CapabilityGrantRow; requiresApproval: boolean };

/**
 * Match an action/resource against the run's grants. Locks the matched
 * grant row and increments calls_used so max_calls is enforced under
 * concurrency. Call inside a transaction.
 */
export async function authorizeAndConsume(
  tx: Tx,
  runId: string,
  action: string,
  resource: string,
): Promise<GrantDecision> {
  const { rows } = await tx.query<CapabilityGrantRow>(
    `SELECT * FROM capability_grants WHERE run_id = $1
     ORDER BY created_at ASC FOR UPDATE`,
    [runId],
  );
  const grant = rows.find(
    (g) =>
      patternMatches(g.action_pattern, action) &&
      patternMatches(g.resource_pattern, resource) &&
      (g.expires_at === null || g.expires_at > new Date()) &&
      (g.max_calls === null || g.calls_used < g.max_calls),
  );
  if (!grant) {
    return { allowed: false, reason: `no capability grant matches ${action} on ${resource}` };
  }
  await tx.query(
    'UPDATE capability_grants SET calls_used = calls_used + 1 WHERE id = $1',
    [grant.id],
  );
  return { allowed: true, grant, requiresApproval: grant.requires_approval };
}
