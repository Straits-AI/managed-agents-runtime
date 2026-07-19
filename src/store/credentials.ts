import type { Pool } from 'pg';
import { withTransaction } from '../db/tx.js';
import { newId } from '../ids.js';
import type { SecretCipher } from '../providers/secretCipher.js';
import { patternMatches } from './grants.js';
import type { CredentialReleaseRequest } from '../core/credentials.js';
import { MODEL_INVOCATION_LOCK_SEED } from '../core/locks.js';

export interface CredentialRow {
  id: string;
  tenant_id: string;
  name: string;
  action_pattern: string;
  resource_pattern: string;
  header_name: string;
  secret_ct: string;
  iv: string;
  auth_tag: string;
  expires_at: Date | null;
  max_uses: number | null;
  uses: number;
  status: string;
  created_at: Date;
}

export interface CredentialGrantRow {
  id: string;
  credential_id: string;
  tenant_id: string;
  agent_version_id: string;
  run_id: string;
  caller_pattern: string;
  purpose_pattern: string;
  action_pattern: string;
  resource_pattern: string;
  requires_approval: boolean;
  allow_delegated_runs: boolean;
  allow_forks: boolean;
  max_uses: number | null;
  uses: number;
  expires_at: Date | null;
  status: string;
  created_at: Date;
}

export interface CredentialUseReceiptRow {
  id: string;
  grant_id: string;
  credential_id: string;
  tenant_id: string;
  run_id: string;
  attempt_id: string | null;
  approval_id: string | null;
  idempotency_key: string;
  caller: string;
  purpose: string;
  action: string;
  resource: string;
  created_at: Date;
}

interface CredentialResolutionRow extends CredentialGrantRow {
  header_name: string;
  secret_ct: string;
  iv: string;
  auth_tag: string;
  credential_action_pattern: string;
  credential_resource_pattern: string;
  credential_max_uses: number | null;
  credential_uses: number;
}

export async function createCredential(
  pool: Pool,
  input: {
    tenantId: string;
    name: string;
    action: string;
    resource?: string;
    headerName: string;
    secret: string;
    cipher: SecretCipher;
    expiresAt?: string;
    maxUses?: number;
  },
): Promise<{ id: string }> {
  const id = newId('cred');
  const sealed = await input.cipher.seal(input.secret);
  await pool.query(
    `INSERT INTO credentials
       (id, tenant_id, name, action_pattern, resource_pattern, header_name,
        secret_ct, iv, auth_tag, expires_at, max_uses)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      input.tenantId,
      input.name,
      input.action,
      input.resource ?? '*',
      input.headerName,
      sealed.ct,
      sealed.iv,
      sealed.tag,
      input.expiresAt ?? null,
      input.maxUses ?? null,
    ],
  );
  return { id };
}

/** Non-secret metadata for listing (never returns ciphertext). */
export async function listCredentials(pool: Pool, tenantId: string) {
  const { rows } = await pool.query(
    `SELECT id, name, action_pattern, resource_pattern, header_name, expires_at,
            max_uses, uses, status, created_at
     FROM credentials WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return rows;
}

export async function revokeCredential(pool: Pool, id: string, tenantId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE credentials SET status = 'revoked' WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}

export async function createCredentialGrant(
  pool: Pool,
  input: {
    tenantId: string;
    credentialId: string;
    agentVersionId: string;
    runId: string;
    caller: string;
    purpose: string;
    action: string;
    resource?: string;
    requiresApproval?: boolean;
    allowDelegatedRuns?: boolean;
    allowForks?: boolean;
    maxUses?: number;
    expiresAt?: string;
  },
): Promise<CredentialGrantRow> {
  return withTransaction(pool, async (tx) => {
    const { rows: subjects } = await tx.query<{ credential_id: string; run_id: string }>(
      `SELECT c.id AS credential_id, r.id AS run_id
       FROM credentials c
       JOIN runs r ON r.id = $4 AND r.tenant_id = c.tenant_id
       JOIN agent_versions av ON av.id = $3 AND av.id = r.agent_version_id
       JOIN agent_definitions ad ON ad.id = av.agent_id AND ad.tenant_id = c.tenant_id
       WHERE c.id = $2 AND c.tenant_id = $1`,
      [input.tenantId, input.credentialId, input.agentVersionId, input.runId],
    );
    if (!subjects[0]) {
      throw new Error('credential grant subject does not belong to the tenant or run');
    }
    const { rows } = await tx.query<CredentialGrantRow>(
      `INSERT INTO credential_grants
         (id, credential_id, tenant_id, agent_version_id, run_id,
          caller_pattern, purpose_pattern, action_pattern, resource_pattern,
          requires_approval, allow_delegated_runs, allow_forks, max_uses, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        newId('cgr'), input.credentialId, input.tenantId, input.agentVersionId,
        input.runId, input.caller, input.purpose, input.action, input.resource ?? '*',
        input.requiresApproval ?? false, input.allowDelegatedRuns ?? false,
        input.allowForks ?? false, input.maxUses ?? null, input.expiresAt ?? null,
      ],
    );
    return rows[0]!;
  });
}

export async function listCredentialGrants(
  pool: Pool,
  tenantId: string,
): Promise<CredentialGrantRow[]> {
  const { rows } = await pool.query<CredentialGrantRow>(
    `SELECT * FROM credential_grants WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return rows;
}

export async function revokeCredentialGrant(
  pool: Pool,
  id: string,
  tenantId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE credential_grants SET status = 'revoked' WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}

/** Secret-free audit records for a tenant's credential consumptions. */
export async function listCredentialUseReceipts(
  pool: Pool,
  tenantId: string,
): Promise<CredentialUseReceiptRow[]> {
  const { rows } = await pool.query<CredentialUseReceiptRow>(
    `SELECT id, grant_id, credential_id, tenant_id, run_id, attempt_id,
            approval_id, idempotency_key, caller, purpose, action, resource, created_at
     FROM credential_use_receipts WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return rows;
}

/**
 * Find and CONSUME one execution grant matching the complete credential policy.
 * The grant and credential rows are locked, use counters and the secret-free
 * receipt commit together, and a retry may reuse only an identical request.
 */
export async function consumeCredential(
  pool: Pool,
  input: CredentialReleaseRequest,
  cipher: SecretCipher,
): Promise<{ headerName: string; headerValue: string } | null> {
  return withTransaction(pool, async (tx) => {
    // Use the same per-run execution fence as model calls. The reaper honors
    // this advisory lock, while the row locks below serialize cancellation and
    // attempt replacement through the receipt commit.
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`,
      [input.runId, MODEL_INVOCATION_LOCK_SEED],
    );
    const { rows: lockedRuns } = await tx.query<{ id: string }>(
      `SELECT id FROM runs
       WHERE id = $1 AND tenant_id = $2 AND status = 'RUNNING'
         AND current_attempt_id = $3
       FOR UPDATE`,
      [input.runId, input.tenantId, input.attemptId],
    );
    if (!lockedRuns[0]) return null;
    const { rows: lockedAttempts } = await tx.query<{ id: string }>(
      `SELECT id FROM run_attempts
       WHERE id = $1 AND run_id = $2 AND state = 'ACTIVE'
         AND lease_expires_at > clock_timestamp()
       FOR UPDATE`,
      [input.attemptId, input.runId],
    );
    if (!lockedAttempts[0]) return null;

    const { rows } = await tx.query<CredentialResolutionRow>(
      `WITH RECURSIVE lineage AS (
         SELECT r.id, r.parent_run_id, r.forked_from_run_id,
                false AS via_delegation, false AS via_fork
         FROM runs r
         WHERE r.id = $2 AND r.tenant_id = $1
         UNION ALL
         SELECT ancestor.id, ancestor.parent_run_id, ancestor.forked_from_run_id,
                lineage.via_delegation OR current.parent_run_id IS NOT NULL,
                lineage.via_fork OR current.forked_from_run_id IS NOT NULL
         FROM lineage
         JOIN runs current ON current.id = lineage.id
         JOIN runs ancestor
           ON ancestor.id = COALESCE(current.parent_run_id, current.forked_from_run_id)
          AND ancestor.tenant_id = $1
       )
       SELECT g.*, c.header_name, c.secret_ct, c.iv, c.auth_tag,
              c.action_pattern AS credential_action_pattern,
              c.resource_pattern AS credential_resource_pattern,
              c.max_uses AS credential_max_uses,
              c.uses AS credential_uses
       FROM credential_grants g
       JOIN credentials c
         ON c.id = g.credential_id AND c.tenant_id = g.tenant_id
       JOIN runs r
         ON r.id = $2 AND r.tenant_id = g.tenant_id
       JOIN lineage l ON l.id = g.run_id
       WHERE g.tenant_id = $1
         AND g.agent_version_id = r.agent_version_id
         AND (NOT l.via_delegation OR g.allow_delegated_runs)
         AND (NOT l.via_fork OR g.allow_forks)
         AND g.status = 'active'
         AND c.status = 'active'
         AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
         AND (c.expires_at IS NULL OR c.expires_at > clock_timestamp())
       ORDER BY g.created_at, c.created_at
       FOR UPDATE OF g, c`,
      [input.tenantId, input.runId],
    );
    const candidates = rows.filter(
      (c) =>
        patternMatches(c.caller_pattern, input.caller) &&
        patternMatches(c.purpose_pattern, input.purpose) &&
        patternMatches(c.action_pattern, input.action) &&
        patternMatches(c.resource_pattern, input.resource) &&
        patternMatches(
          c.credential_action_pattern,
          input.action,
        ) &&
        patternMatches(c.credential_resource_pattern, input.resource),
    );
    if (candidates.length === 0) return null;
    // Candidate locks may wait behind another consumer. `clock_timestamp()`
    // deliberately re-evaluates wall time instead of transaction-start time.
    const { rows: attempts } = await tx.query<{ id: string }>(
      `SELECT a.id FROM run_attempts a
       JOIN runs r ON r.id = a.run_id
       WHERE a.id = $1 AND a.run_id = $2 AND a.state = 'ACTIVE'
         AND a.lease_expires_at > clock_timestamp()
         AND r.current_attempt_id = a.id AND r.status = 'RUNNING'`,
      [input.attemptId, input.runId],
    );
    if (!attempts[0]) return null;
    let validatedApprovalId: string | null = null;
    if (input.approvalId) {
      const { rows: approvals } = await tx.query<{ id: string }>(
        `SELECT id FROM approvals
         WHERE id = $1 AND run_id = $2 AND status = 'APPROVED'
           AND (expires_at IS NULL OR expires_at > clock_timestamp())
           AND action->>'action' = $3 AND action->>'resource' = $4
           AND action->'arguments'->>'__idemKey' = $5
         FOR UPDATE`,
        [
          input.approvalId, input.runId, input.action, input.resource,
          input.idempotencyKey,
        ],
      );
      validatedApprovalId = approvals[0]?.id ?? null;
    }

    const openWhileStillAuthorized = async (
      candidate: CredentialResolutionRow,
    ): Promise<string | null> => {
      const plaintext = await cipher.open({
        ct: candidate.secret_ct,
        iv: candidate.iv,
        tag: candidate.auth_tag,
      });
      const { rows: valid } = await tx.query<{ id: string }>(
        `SELECT g.id
         FROM credential_grants g
         JOIN credentials c
           ON c.id = g.credential_id AND c.tenant_id = g.tenant_id
         JOIN runs r
           ON r.id = $3 AND r.tenant_id = g.tenant_id
         JOIN run_attempts a
           ON a.id = $4 AND a.run_id = r.id
         WHERE g.id = $1 AND g.tenant_id = $2
           AND g.status = 'active' AND c.status = 'active'
           AND r.status = 'RUNNING' AND r.current_attempt_id = a.id
           AND a.state = 'ACTIVE' AND a.lease_expires_at > clock_timestamp()
           AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
           AND (c.expires_at IS NULL OR c.expires_at > clock_timestamp())
           AND (
             NOT g.requires_approval OR EXISTS (
               SELECT 1 FROM approvals p
               WHERE p.id = $5 AND p.run_id = r.id AND p.status = 'APPROVED'
                 AND (p.expires_at IS NULL OR p.expires_at > clock_timestamp())
                 AND p.action->>'action' = $6 AND p.action->>'resource' = $7
                 AND p.action->'arguments'->>'__idemKey' = $8
             )
           )`,
        [
          candidate.id, input.tenantId, input.runId, input.attemptId,
          validatedApprovalId, input.action, input.resource, input.idempotencyKey,
        ],
      );
      return valid[0] ? plaintext : null;
    };

    for (const candidate of candidates) {
      if (candidate.requires_approval && !validatedApprovalId) continue;
      const { rows: prior } = await tx.query<{
        caller: string;
        purpose: string;
        action: string;
        resource: string;
      }>(
        `SELECT caller, purpose, action, resource FROM credential_use_receipts
         WHERE grant_id = $1 AND run_id = $2 AND idempotency_key = $3`,
        [candidate.id, input.runId, input.idempotencyKey],
      );
      if (prior[0]) {
        if (
          prior[0].caller !== input.caller ||
          prior[0].purpose !== input.purpose ||
          prior[0].action !== input.action ||
          prior[0].resource !== input.resource
        ) {
          return null;
        }
        const headerValue = await openWhileStillAuthorized(candidate);
        return headerValue === null
          ? null
          : { headerName: candidate.header_name, headerValue };
      }
    }

    const match = candidates.find(
      (candidate) =>
        (!candidate.requires_approval || validatedApprovalId !== null) &&
        (candidate.max_uses === null || candidate.uses < candidate.max_uses) &&
        (candidate.credential_max_uses === null ||
          candidate.credential_uses < candidate.credential_max_uses),
    );
    if (!match) return null;
    // Secret release remains inside the execution fence. A slow or failed KMS
    // open cannot race cancellation, and failure rolls back counters/receipt.
    const headerValue = await openWhileStillAuthorized(match);
    if (headerValue === null) return null;
    await tx.query('UPDATE credential_grants SET uses = uses + 1 WHERE id = $1', [match.id]);
    await tx.query('UPDATE credentials SET uses = uses + 1 WHERE id = $1', [
      match.credential_id,
    ]);
    await tx.query(
      `INSERT INTO credential_use_receipts
         (id, grant_id, credential_id, tenant_id, run_id, attempt_id,
          approval_id, idempotency_key, caller, purpose, action, resource)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        newId('cuse'),
        match.id,
        match.credential_id,
        input.tenantId,
        input.runId,
        input.attemptId,
        validatedApprovalId,
        input.idempotencyKey,
        input.caller,
        input.purpose,
        input.action,
        input.resource,
      ],
    );
    return {
      headerName: match.header_name,
      headerValue,
    };
  });
}
