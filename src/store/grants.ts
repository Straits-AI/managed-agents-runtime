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

export interface CapabilityGrantEligibilityRow extends CapabilityGrantRow {
  is_unexpired: boolean;
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

/** Grant snapshot whose expiry decision comes from the database clock. */
export async function listGrantsWithEligibility(
  q: Q,
  runId: string,
): Promise<CapabilityGrantEligibilityRow[]> {
  const { rows } = await q.query<CapabilityGrantEligibilityRow>(
    `SELECT *, (expires_at IS NULL OR expires_at > clock_timestamp()) AS is_unexpired
     FROM capability_grants WHERE run_id = $1`,
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
  requiredGrantId?: string,
): Promise<GrantDecision> {
  const { rows } = await tx.query<CapabilityGrantEligibilityRow>(
    `SELECT *, (expires_at IS NULL OR expires_at > clock_timestamp()) AS is_unexpired
     FROM capability_grants WHERE run_id = $1
     ORDER BY created_at ASC FOR UPDATE`,
    [runId],
  );
  const matching = rows.filter(
    (g) =>
      patternMatches(g.action_pattern, action) &&
      patternMatches(g.resource_pattern, resource) &&
      g.is_unexpired &&
      (g.max_calls === null || g.calls_used < g.max_calls),
  );
  const grant = requiredGrantId
    ? matching.find((candidate) => candidate.id === requiredGrantId)
    : matching[0];
  if (!grant) {
    return { allowed: false, reason: `no capability grant matches ${action} on ${resource}` };
  }
  await tx.query(
    'UPDATE capability_grants SET calls_used = calls_used + 1 WHERE id = $1',
    [grant.id],
  );
  return { allowed: true, grant, requiresApproval: grant.requires_approval };
}

/**
 * Revalidate the already-selected logical-call grant at the last dispatch
 * boundary without consuming it a second time during receipt recovery.
 */
export async function revalidateGrantForDispatch(
  tx: Tx,
  input: { grantId: string; runId: string; action: string; resource: string },
): Promise<boolean> {
  const { rows } = await tx.query<CapabilityGrantEligibilityRow>(
    `SELECT *, (expires_at IS NULL OR expires_at > clock_timestamp()) AS is_unexpired
     FROM capability_grants WHERE id = $1 AND run_id = $2 FOR UPDATE`,
    [input.grantId, input.runId],
  );
  const grant = rows[0];
  return Boolean(
    grant?.is_unexpired &&
    patternMatches(grant.action_pattern, input.action) &&
    patternMatches(grant.resource_pattern, input.resource),
  );
}
