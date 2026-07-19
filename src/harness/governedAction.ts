import type { Pool } from 'pg';
import type { RunAttemptRow, RunRow, SemanticAction } from '../core/types.js';
import type { CredentialProvider } from '../providers/types.js';
import { withTransaction } from '../db/tx.js';
import { appendEvent, transitionRun } from '../core/transition.js';
import { insertApproval, listApprovals } from '../store/approvals.js';
import {
  authorizeAndConsume,
  listGrantsWithEligibility,
  patternMatches,
} from '../store/grants.js';
import {
  commitReceipt,
  failReceipt,
  findReceiptByLineageKey,
  idempotencyKey,
  insertPendingReceipt,
  replacementRootRunId,
} from '../store/receipts.js';

export type ActionClassification = 'read' | 'mutation';
export type RecoveryPolicy = 'retry_with_idempotency' | 'reconcile';
export type ResolvedCredential = { headerName: string; headerValue: string } | null;

export interface GovernedActionContext {
  pool: Pool;
  run: RunRow;
  attempt: RunAttemptRow;
  step: number;
  credentials?: CredentialProvider;
}

export interface GovernedDispatchInput {
  idempotencyKey: string;
  credential: ResolvedCredential;
}

export interface GovernedActionSpec<T extends Record<string, unknown>> {
  connector: string;
  /** Stable reason for credential release, distinct from the transport action. */
  purpose?: string;
  action: string;
  resource: string;
  args: Record<string, unknown>;
  classification: ActionClassification;
  /** Public reads may opt out; mutations and MCP calls require a grant. */
  requireGrant: boolean;
  /** Prefer and consume an exact resource grant when one is available. */
  preferExactResourceGrant?: boolean;
  recovery: RecoveryPolicy;
  audit?: Record<string, unknown>;
  /** Connector-specific validation that cannot execute the action. */
  validate?: (input: {
    hasDeclaredGrant: boolean;
    declaredGrantResourcePatterns: string[];
    usableGrantResourcePatterns: string[];
  }) => { ok: true } | { ok: false; reason: string };
  beforeDispatch?: () => void;
  afterCommit?: () => void;
  dispatch: (input: GovernedDispatchInput) => Promise<{
    value: T;
    externalTxnId?: string;
    audit?: Record<string, unknown>;
  }>;
}

export type GovernedActionResult<T extends Record<string, unknown>> =
  | { kind: 'completed'; value: T; deduplicated: boolean }
  | { kind: 'suspend_approval'; approvalId: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'reconciliation_required'; reason: string };

function riskFor(classification: ActionClassification): SemanticAction['risk'] {
  return classification === 'read' ? 'read' : 'external_write';
}

function actionAudit<T extends Record<string, unknown>>(
  spec: GovernedActionSpec<T>,
): Record<string, unknown> {
  return {
    connector: spec.connector,
    action: spec.action,
    resource: spec.resource,
    classification: spec.classification,
  };
}

async function auditDenial<T extends Record<string, unknown>>(
  ctx: GovernedActionContext,
  spec: GovernedActionSpec<T>,
  reason: string,
  stage: 'validation' | 'policy' | 'approval',
): Promise<void> {
  await withTransaction(ctx.pool, (tx) =>
    appendEvent(
      tx,
      ctx.run.id,
      {
        type: 'ActionDenied',
        payload: {
          ...spec.audit,
          stage,
          reason,
          ...actionAudit(spec),
        },
      },
      { attemptId: ctx.attempt.id },
    ),
  );
}

/**
 * Normative execution contract for every governed connector action:
 * classify → validate → policy → approval → credentials → receipt → dispatch
 * → commit/reconcile → audit. Connector handlers supply only validation and
 * transport behavior.
 */
export async function executeGovernedAction<T extends Record<string, unknown>>(
  ctx: GovernedActionContext,
  spec: GovernedActionSpec<T>,
): Promise<GovernedActionResult<T>> {
  const scopeRunId = await replacementRootRunId(ctx.pool, ctx.run.id);
  const key = idempotencyKey({ runId: scopeRunId, action: spec.action, args: spec.args });
  const grants = await listGrantsWithEligibility(ctx.pool, ctx.run.id);
  const declaredGrants = grants.filter(
    (grant) =>
      patternMatches(grant.action_pattern, spec.action) &&
      patternMatches(grant.resource_pattern, spec.resource),
  );

  const existing = await findReceiptByLineageKey(ctx.pool, ctx.run.id, key);
  if (existing?.status === 'COMMITTED') {
    return {
      kind: 'completed',
      value: existing.result as T,
      deduplicated: true,
    };
  }
  if (existing?.status === 'PENDING' && spec.recovery === 'reconcile') {
    await withTransaction(ctx.pool, async (tx) => {
      await failReceipt(tx, existing.id, 'NEEDS_RECONCILIATION');
      await appendEvent(
        tx,
        ctx.run.id,
        {
          type: 'ToolInvocationFailed',
          payload: {
            ...spec.audit,
            receiptId: existing.id,
            reconciliationRequired: true,
            ...actionAudit(spec),
          },
        },
        { attemptId: ctx.attempt.id },
      );
    });
    return {
      kind: 'reconciliation_required',
      reason: 'prior action outcome requires reconciliation',
    };
  }
  if (existing && existing.status !== 'PENDING') {
    return {
      kind: 'reconciliation_required',
      reason: `prior action is ${existing.status.toLowerCase()}`,
    };
  }
  const pendingRecovery = existing?.status === 'PENDING';
  const usableGrants = declaredGrants.filter(
    (grant) =>
      grant.is_unexpired &&
      (pendingRecovery || grant.max_calls === null || grant.calls_used < grant.max_calls),
  );
  if (spec.preferExactResourceGrant) {
    usableGrants.sort((left, right) =>
      Number(right.resource_pattern === spec.resource) -
      Number(left.resource_pattern === spec.resource));
  }
  const usableGrant = usableGrants[0];

  const validation = spec.validate?.({
    hasDeclaredGrant: declaredGrants.length > 0,
    declaredGrantResourcePatterns: declaredGrants.map((grant) => grant.resource_pattern),
    usableGrantResourcePatterns: usableGrants.map((grant) => grant.resource_pattern),
  });
  if (validation && !validation.ok) {
    await auditDenial(ctx, spec, validation.reason, 'validation');
    return { kind: 'denied', reason: validation.reason };
  }

  if (spec.requireGrant && !usableGrant) {
    const reason = `no capability grant allows ${spec.action} on ${spec.resource}`;
    await auditDenial(ctx, spec, reason, 'policy');
    return {
      kind: 'denied',
      reason,
    };
  }

  let approvalId: string | null = existing?.approval_id ?? null;
  if (usableGrant?.requires_approval && !pendingRecovery) {
    const approvals = await listApprovals(ctx.pool, ctx.run.id);
    const approval = approvals.find(
      (candidate) =>
        (candidate.action.arguments as { __idemKey?: string }).__idemKey === key,
    );
    if (!approval) {
      const created = await withTransaction(ctx.pool, async (tx) => {
        const row = await insertApproval(tx, {
          runId: ctx.run.id,
          attemptId: ctx.attempt.id,
          action: {
            action: spec.action,
            resource: spec.resource,
            arguments: { ...spec.args, __idemKey: key },
            risk: riskFor(spec.classification),
          },
        });
        await transitionRun(tx, ctx.run.id, {
          expectFrom: ['RUNNING'],
          to: 'WAITING_APPROVAL',
          event: {
            type: 'ApprovalRequested',
            payload: { approvalId: row.id, action: spec.action, resource: spec.resource },
          },
          attemptId: ctx.attempt.id,
        });
        return row;
      });
      return { kind: 'suspend_approval', approvalId: created.id };
    }
    approvalId = approval.id;
    if (approval.status === 'DENIED') {
      const reason = `${spec.action} was denied by ${approval.decision_by ?? 'a human'}`;
      await auditDenial(ctx, spec, reason, 'approval');
      return {
        kind: 'denied',
        reason,
      };
    }
    if (approval.status === 'EXPIRED') {
      const reason = `approval expired for ${spec.action}`;
      await auditDenial(ctx, spec, reason, 'approval');
      return { kind: 'denied', reason };
    }
    if (approval.status !== 'APPROVED') {
      return { kind: 'denied', reason: 'approval still pending' };
    }
  }

  let credential: ResolvedCredential = null;
  try {
    credential =
      (await ctx.credentials?.resolve({
        tenantId: ctx.run.tenant_id,
        runId: ctx.run.id,
        attemptId: ctx.attempt.id,
        caller: spec.connector,
        purpose: spec.purpose ?? spec.action,
        action: spec.action,
        resource: spec.resource,
        approvalId,
        idempotencyKey: key,
      })) ?? null;
  } catch {
    await withTransaction(ctx.pool, (tx) =>
      appendEvent(
        tx,
        ctx.run.id,
        {
          type: 'ToolInvocationFailed',
          payload: {
            ...spec.audit,
            stage: 'credential',
            reconciliationRequired: false,
            ...actionAudit(spec),
          },
        },
        { attemptId: ctx.attempt.id },
      ),
    );
    throw new Error(`credential resolution failed for ${spec.action}`);
  }

  const receipt =
    (pendingRecovery ? existing : null) ??
    (await withTransaction(ctx.pool, async (tx) => {
      if (usableGrant) {
        const authorized = await authorizeAndConsume(
          tx,
          ctx.run.id,
          spec.action,
          spec.resource,
          usableGrant.id,
        );
        if (!authorized.allowed) {
          throw new Error(`capability disappeared: ${authorized.reason}`);
        }
      }
      const row = await insertPendingReceipt(tx, {
        runId: ctx.run.id,
        attemptId: ctx.attempt.id,
        step: ctx.step,
        action: spec.action,
        args: spec.args,
        idempotencyKey: key,
        approvalId,
        reversibility: spec.classification === 'read' ? 'reversible' : 'irreversible',
      });
      await appendEvent(
        tx,
        ctx.run.id,
        {
          type: 'ToolInvocationStarted',
          payload: {
            ...spec.audit,
            receiptId: row.id,
            ...actionAudit(spec),
          },
        },
        { attemptId: ctx.attempt.id },
      );
      return row;
    }));

  try {
    spec.beforeDispatch?.();
    const dispatched = await spec.dispatch({ idempotencyKey: key, credential });
    await withTransaction(ctx.pool, async (tx) => {
      await commitReceipt(tx, receipt.id, {
        externalTxnId: dispatched.externalTxnId,
        result: dispatched.value,
      });
      await appendEvent(
        tx,
        ctx.run.id,
        {
          type: 'ToolInvocationCommitted',
          payload: {
            ...spec.audit,
            ...dispatched.audit,
            receiptId: receipt.id,
            ...actionAudit(spec),
          },
        },
        { attemptId: ctx.attempt.id },
      );
    });
    spec.afterCommit?.();
    return { kind: 'completed', value: dispatched.value, deduplicated: false };
  } catch (error) {
    if (spec.recovery === 'reconcile') {
      await withTransaction(ctx.pool, async (tx) => {
        await failReceipt(tx, receipt.id, 'NEEDS_RECONCILIATION');
        await appendEvent(
          tx,
          ctx.run.id,
          {
            type: 'ToolInvocationFailed',
            payload: {
              ...spec.audit,
              receiptId: receipt.id,
              reconciliationRequired: true,
              ...actionAudit(spec),
            },
          },
          { attemptId: ctx.attempt.id },
        );
      });
    }
    throw error;
  }
}
