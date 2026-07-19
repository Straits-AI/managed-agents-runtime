import type { Pool } from 'pg';
import type { RunAttemptRow, RunRow, SemanticAction } from '../core/types.js';
import { withTransaction } from '../db/tx.js';
import { appendEvent, transitionRun } from '../core/transition.js';
import { insertApproval, listApprovals } from '../store/approvals.js';
import { authorizeAndConsume, listGrants, patternMatches } from '../store/grants.js';
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
}

export interface GovernedDispatchInput {
  idempotencyKey: string;
  credential: ResolvedCredential;
}

export interface GovernedActionSpec<T> {
  connector: string;
  action: string;
  resource: string;
  args: Record<string, unknown>;
  classification: ActionClassification;
  /** Public reads may opt out; mutations and MCP calls require a grant. */
  requireGrant: boolean;
  recovery: RecoveryPolicy;
  audit?: Record<string, unknown>;
  /** Connector-specific validation that cannot execute the action. */
  validate?: (input: { hasDeclaredGrant: boolean }) => { ok: true } | { ok: false; reason: string };
  resolveCredential?: () => Promise<ResolvedCredential>;
  beforeDispatch?: () => void;
  afterCommit?: () => void;
  dispatch: (input: GovernedDispatchInput) => Promise<{
    value: T;
    receiptResult: Record<string, unknown>;
    externalTxnId?: string;
    audit?: Record<string, unknown>;
  }>;
}

export type GovernedActionResult<T> =
  | { kind: 'completed'; value: T; deduplicated: boolean }
  | { kind: 'suspend_approval'; approvalId: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'reconciliation_required'; reason: string };

function riskFor(classification: ActionClassification): SemanticAction['risk'] {
  return classification === 'read' ? 'read' : 'external_write';
}

/**
 * Normative execution contract for every governed connector action:
 * classify → validate → policy → approval → receipt → credentials → dispatch
 * → commit/reconcile → audit. Connector handlers supply only validation and
 * transport behavior.
 */
export async function executeGovernedAction<T>(
  ctx: GovernedActionContext,
  spec: GovernedActionSpec<T>,
): Promise<GovernedActionResult<T>> {
  const scopeRunId = await replacementRootRunId(ctx.pool, ctx.run.id);
  const key = idempotencyKey({ runId: scopeRunId, action: spec.action, args: spec.args });
  const grants = await listGrants(ctx.pool, ctx.run.id);
  const declaredGrant = grants.find(
    (grant) =>
      patternMatches(grant.action_pattern, spec.action) &&
      patternMatches(grant.resource_pattern, spec.resource),
  );

  const validation = spec.validate?.({ hasDeclaredGrant: declaredGrant !== undefined });
  if (validation && !validation.ok) {
    return { kind: 'denied', reason: validation.reason };
  }

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
            receiptId: existing.id,
            connector: spec.connector,
            action: spec.action,
            resource: spec.resource,
            classification: spec.classification,
            ...spec.audit,
            reconciliationRequired: true,
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
  const usableGrant = grants.find(
    (grant) =>
      patternMatches(grant.action_pattern, spec.action) &&
      patternMatches(grant.resource_pattern, spec.resource) &&
      (grant.expires_at === null || grant.expires_at > new Date()) &&
      (pendingRecovery || grant.max_calls === null || grant.calls_used < grant.max_calls),
  );

  if (spec.requireGrant && !usableGrant) {
    await withTransaction(ctx.pool, (tx) =>
      appendEvent(
        tx,
        ctx.run.id,
        { type: 'ActionDenied', payload: { action: spec.action, resource: spec.resource } },
        { attemptId: ctx.attempt.id },
      ),
    );
    return {
      kind: 'denied',
      reason: `no capability grant allows ${spec.action} on ${spec.resource}`,
    };
  }

  let approvalId: string | null = existing?.approval_id ?? null;
  if (
    spec.classification === 'mutation' &&
    usableGrant?.requires_approval &&
    !pendingRecovery
  ) {
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
      return {
        kind: 'denied',
        reason: `${spec.action} was denied by ${approval.decision_by ?? 'a human'}`,
      };
    }
    if (approval.status !== 'APPROVED') {
      return { kind: 'denied', reason: 'approval still pending' };
    }
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
        );
        if (!authorized.allowed && spec.requireGrant) {
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
            receiptId: row.id,
            connector: spec.connector,
            action: spec.action,
            resource: spec.resource,
            classification: spec.classification,
            ...spec.audit,
          },
        },
        { attemptId: ctx.attempt.id },
      );
      return row;
    }));

  const credential = await spec.resolveCredential?.() ?? null;
  try {
    spec.beforeDispatch?.();
    const dispatched = await spec.dispatch({ idempotencyKey: key, credential });
    await withTransaction(ctx.pool, async (tx) => {
      await commitReceipt(tx, receipt.id, {
        externalTxnId: dispatched.externalTxnId,
        result: dispatched.receiptResult,
      });
      await appendEvent(
        tx,
        ctx.run.id,
        {
          type: 'ToolInvocationCommitted',
          payload: {
            receiptId: receipt.id,
            connector: spec.connector,
            action: spec.action,
            resource: spec.resource,
            classification: spec.classification,
            ...spec.audit,
            ...dispatched.audit,
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
              receiptId: receipt.id,
              connector: spec.connector,
              action: spec.action,
              resource: spec.resource,
              classification: spec.classification,
              ...spec.audit,
              reconciliationRequired: true,
            },
          },
          { attemptId: ctx.attempt.id },
        );
      });
    }
    throw error;
  }
}
