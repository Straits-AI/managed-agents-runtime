import type { Pool, PoolClient } from 'pg';
import type { RunAttemptRow, RunRow, SemanticAction } from '../core/types.js';
import type { CredentialProvider } from '../providers/types.js';
import { withClientTransaction } from '../db/tx.js';
import { appendEvent, transitionRun } from '../core/transition.js';
import {
  insertApproval,
  listApprovals,
  lockApprovalForExecution,
} from '../store/approvals.js';
import {
  authorizeAndConsume,
  listGrantsWithEligibility,
  patternMatches,
  revalidateGrantForDispatch,
} from '../store/grants.js';
import {
  commitReceipt,
  failReceipt,
  findReceiptByLineageKey,
  idempotencyKey,
  insertPendingReceipt,
  replacementRootRunId,
  setPendingReceiptApproval,
} from '../store/receipts.js';
import { GOVERNED_ACTION_LOCK_SEED } from '../core/locks.js';
import { invocationAbortFence } from './invocationAbort.js';

export type ActionClassification = 'read' | 'mutation';
export type RecoveryPolicy = 'retry_with_idempotency' | 'reconcile';
export type ResolvedCredential = { headerName: string; headerValue: string } | null;

export interface GovernedActionContext {
  pool: Pool;
  run: RunRow;
  attempt: RunAttemptRow;
  step: number;
  credentials?: CredentialProvider;
  /** Worker lease/cancellation signal; action fencing composes it with DB-session loss. */
  signal?: AbortSignal;
}

export interface GovernedDispatchInput {
  idempotencyKey: string;
  credential: ResolvedCredential;
  signal: AbortSignal;
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
  beforeDispatch?: () => void | Promise<void>;
  /** Fault boundary after remote success but before local receipt commit. */
  afterDispatch?: () => void;
  afterCommit?: () => void;
  reconcile?: (input: GovernedDispatchInput) => Promise<
    | {
        status: 'committed';
        value: T;
        externalTxnId?: string;
        audit?: Record<string, unknown>;
      }
    | { status: 'not_found'; terminal: true }
    | { status: 'unknown' }
  >;
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

interface PoolAdmission {
  active: number;
  limit: number;
  waiters: Array<() => void>;
}

const poolAdmissions = new WeakMap<Pool, PoolAdmission>();

async function acquireFenceAdmission(pool: Pool): Promise<() => void> {
  let admission = poolAdmissions.get(pool);
  if (!admission) {
    const configuredMax = pool.options.max ?? 10;
    admission = {
      active: 0,
      // A governed action owns a session-lock connection across remote I/O.
      // Reserve one pool slot for credential brokers and other DB-backed
      // services invoked inside that fence, or N concurrent actions can
      // starve an N-connection pool permanently.
      limit: Math.max(1, configuredMax - 1),
      waiters: [],
    };
    poolAdmissions.set(pool, admission);
  }
  if (admission.active >= admission.limit) {
    await new Promise<void>((resolve) => admission!.waiters.push(resolve));
  } else {
    admission.active += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = admission!.waiters.shift();
    if (next) {
      // Transfer the permit synchronously. Decrementing before waking a waiter
      // lets a newly arriving caller steal the slot and exceed the limit.
      next();
    } else {
      admission!.active -= 1;
    }
  };
}

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
  client: PoolClient,
  ctx: GovernedActionContext,
  spec: GovernedActionSpec<T>,
  reason: string,
  stage: 'validation' | 'policy' | 'approval',
): Promise<void> {
  await withClientTransaction(client, (tx) =>
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

async function markReconciliationRequired<T extends Record<string, unknown>>(
  client: PoolClient,
  ctx: GovernedActionContext,
  spec: GovernedActionSpec<T>,
  receiptId: string,
  reason: string,
): Promise<GovernedActionResult<T>> {
  await withClientTransaction(client, async (tx) => {
    await assertCurrentActionOwner(tx, ctx);
    await failReceipt(tx, receiptId, 'NEEDS_RECONCILIATION');
    await appendEvent(
      tx,
      ctx.run.id,
      {
        type: 'ToolInvocationFailed',
        payload: {
          ...spec.audit,
          receiptId,
          reason,
          reconciliationRequired: true,
          ...actionAudit(spec),
        },
      },
      { attemptId: ctx.attempt.id },
    );
  });
  return { kind: 'reconciliation_required', reason };
}

async function auditRetryableFailure<T extends Record<string, unknown>>(
  client: PoolClient,
  ctx: GovernedActionContext,
  spec: GovernedActionSpec<T>,
  receiptId: string,
  stage: 'dispatch' | 'receipt_commit',
): Promise<void> {
  await withClientTransaction(client, (tx) =>
    appendEvent(
      tx,
      ctx.run.id,
      {
        type: 'ToolInvocationFailed',
        payload: {
          ...spec.audit,
          receiptId,
          stage,
          retryable: true,
          reconciliationRequired: false,
          ...actionAudit(spec),
        },
      },
      { attemptId: ctx.attempt.id },
    ),
  );
}

async function failUndispatchedReceiptAndDeny<T extends Record<string, unknown>>(
  client: PoolClient,
  ctx: GovernedActionContext,
  spec: GovernedActionSpec<T>,
  receiptId: string,
  reason: string,
  stage: 'validation' | 'policy' | 'approval',
): Promise<GovernedActionResult<T>> {
  await withClientTransaction(client, async (tx) => {
    await assertCurrentActionOwner(tx, ctx);
    await failReceipt(tx, receiptId, 'FAILED');
    await appendEvent(
      tx,
      ctx.run.id,
      {
        type: 'ActionDenied',
        payload: { ...spec.audit, stage, reason, ...actionAudit(spec) },
      },
      { attemptId: ctx.attempt.id },
    );
  });
  return { kind: 'denied', reason };
}

async function requestFreshApproval<T extends Record<string, unknown>>(
  client: PoolClient,
  ctx: GovernedActionContext,
  spec: GovernedActionSpec<T>,
  key: string,
  receiptId?: string,
): Promise<GovernedActionResult<T>> {
  const created = await withClientTransaction(client, async (tx) => {
    await assertCurrentActionOwner(tx, ctx);
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
    if (receiptId) await setPendingReceiptApproval(tx, receiptId, row.id);
    return row;
  });
  return { kind: 'suspend_approval', approvalId: created.id };
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
  const releaseAdmission = await acquireFenceAdmission(ctx.pool);
  let client: PoolClient | undefined;
  const parentSignal = ctx.signal ?? new AbortController().signal;
  let abortFence: ReturnType<typeof invocationAbortFence> | undefined;
  let locked = false;
  try {
    client = await ctx.pool.connect();
    abortFence = invocationAbortFence(client, parentSignal);
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, $2))', [
      key,
      GOVERNED_ACTION_LOCK_SEED,
    ]);
    locked = true;
    if (abortFence.signal.aborted) {
      throw abortFence.signal.reason instanceof Error
        ? abortFence.signal.reason
        : new Error('governed action cancelled before execution');
    }
    return await executeGovernedActionFenced(ctx, spec, key, client, abortFence.signal);
  } finally {
    let clientLost = abortFence?.clientLost() ?? false;
    if (locked && client && abortFence && !abortFence.clientLost()) {
      try {
        const { rows } = await client.query<{ unlocked: boolean }>(
          `SELECT pg_advisory_unlock(hashtextextended($1, $2)) AS unlocked`,
          [key, GOVERNED_ACTION_LOCK_SEED],
        );
        if (rows[0]?.unlocked !== true) clientLost = true;
      } catch {
        // A failed session-unlock can leave the lock held invisibly in an idle
        // pooled client. Destroy the session instead of returning it healthy.
        clientLost = true;
      }
    }
    abortFence?.dispose();
    client?.release(clientLost ? new Error('governed action lock session lost') : undefined);
    releaseAdmission();
  }
}

async function assertCurrentActionOwner(
  client: PoolClient,
  ctx: GovernedActionContext,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT r.id FROM runs r
     JOIN run_attempts a ON a.id = $2 AND a.run_id = r.id
     WHERE r.id = $1 AND r.status = 'RUNNING'
       AND r.current_attempt_id = a.id
       AND a.state = 'ACTIVE'
       AND a.lease_expires_at > clock_timestamp()`,
    [ctx.run.id, ctx.attempt.id],
  );
  if (!rows[0]) throw new Error('governed action attempt is no longer current');
}

async function executeGovernedActionFenced<T extends Record<string, unknown>>(
  ctx: GovernedActionContext,
  spec: GovernedActionSpec<T>,
  key: string,
  fenceClient: PoolClient,
  signal: AbortSignal,
): Promise<GovernedActionResult<T>> {
  await assertCurrentActionOwner(fenceClient, ctx);
  const existing = await findReceiptByLineageKey(fenceClient, ctx.run.id, key);
  if (existing?.status === 'COMMITTED') {
    return {
      kind: 'completed',
      value: existing.result as T,
      deduplicated: true,
    };
  }
  if (existing && existing.status !== 'PENDING') {
    return {
      kind: 'reconciliation_required',
      reason: `prior action is ${existing.status.toLowerCase()}`,
    };
  }
  const pendingRecovery = existing?.status === 'PENDING';
  let priorOutcomeKnownAbsent = false;

  // Resolve durable uncertainty before consulting fresh dispatch authority.
  // Reconciliation uses the stable key and provider-internal lookup only: it
  // must never decrypt/release an execution credential. If the remote effect
  // already committed, closing the receipt is bookkeeping rather than a new
  // mutation. Only an authoritative terminal not_found proceeds to a newly
  // authorized dispatch below.
  if (existing?.status === 'PENDING' && spec.recovery === 'reconcile') {
    if (!spec.reconcile) {
      return markReconciliationRequired(
        fenceClient,
        ctx,
        spec,
        existing.id,
        'prior action outcome requires manual reconciliation',
      );
    }
    let reconciled: Awaited<ReturnType<NonNullable<typeof spec.reconcile>>>;
    try {
      reconciled = await spec.reconcile({ idempotencyKey: key, credential: null, signal });
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : error;
      }
      return markReconciliationRequired(
        fenceClient,
        ctx,
        spec,
        existing.id,
        'provider reconciliation failed',
      );
    }
    if (reconciled.status === 'committed') {
      await withClientTransaction(fenceClient, async (tx) => {
        await assertCurrentActionOwner(tx, ctx);
        await commitReceipt(tx, existing.id, {
          externalTxnId: reconciled.externalTxnId,
          result: reconciled.value,
        });
        await appendEvent(
          tx,
          ctx.run.id,
          {
            type: 'ToolInvocationCommitted',
            payload: {
              ...spec.audit,
              ...reconciled.audit,
              receiptId: existing.id,
              reconciled: true,
              ...actionAudit(spec),
            },
          },
          { attemptId: ctx.attempt.id },
        );
      });
      return { kind: 'completed', value: reconciled.value, deduplicated: true };
    }
    if (reconciled.status === 'unknown') {
      return markReconciliationRequired(
        fenceClient,
        ctx,
        spec,
        existing.id,
        'provider could not reconcile prior action outcome',
      );
    }
    // The provider's terminal:true contract certifies that the prior call has
    // no present or future commit. Fresh dispatch authority is required below.
    priorOutcomeKnownAbsent = true;
  }

  const grants = await listGrantsWithEligibility(fenceClient, ctx.run.id);
  const declaredGrants = grants.filter(
    (grant) =>
      patternMatches(grant.action_pattern, spec.action) &&
      patternMatches(grant.resource_pattern, spec.resource),
  );
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
    if (priorOutcomeKnownAbsent && existing) {
      return failUndispatchedReceiptAndDeny(
        fenceClient, ctx, spec, existing.id, validation.reason, 'validation',
      );
    }
    await auditDenial(fenceClient, ctx, spec, validation.reason, 'validation');
    return { kind: 'denied', reason: validation.reason };
  }

  if (spec.requireGrant && !usableGrant) {
    const reason = `no capability grant allows ${spec.action} on ${spec.resource}`;
    if (pendingRecovery && existing) {
      if (priorOutcomeKnownAbsent) {
        return failUndispatchedReceiptAndDeny(
          fenceClient, ctx, spec, existing.id, reason, 'policy',
        );
      }
      return markReconciliationRequired(fenceClient, ctx, spec, existing.id, reason);
    }
    await auditDenial(fenceClient, ctx, spec, reason, 'policy');
    return {
      kind: 'denied',
      reason,
    };
  }

  let approvalId: string | null = existing?.approval_id ?? null;
  if (usableGrant?.requires_approval) {
    if (!approvalId) {
      const approvals = await listApprovals(fenceClient, ctx.run.id);
      approvalId = approvals.findLast(
        (candidate) =>
          (candidate.action.arguments as { __idemKey?: string }).__idemKey === key,
      )?.id ?? null;
    }
    if (!approvalId) {
      return requestFreshApproval(
        fenceClient,
        ctx,
        spec,
        key,
        pendingRecovery && existing ? existing.id : undefined,
      );
    }
    const approval = await withClientTransaction(fenceClient, (tx) =>
      lockApprovalForExecution(tx, {
        approvalId: approvalId!,
        runId: ctx.run.id,
        action: spec.action,
        resource: spec.resource,
        idempotencyKey: key,
      }));
    if (!approval) {
      if (pendingRecovery && existing) {
        return requestFreshApproval(fenceClient, ctx, spec, key, existing.id);
      }
      const reason = `approval no longer authorizes ${spec.action}`;
      await auditDenial(fenceClient, ctx, spec, reason, 'approval');
      return { kind: 'denied', reason };
    }
    if (approval.status === 'DENIED') {
      const reason = `${spec.action} was denied by ${approval.decision_by ?? 'a human'}`;
      if (priorOutcomeKnownAbsent && existing) {
        return failUndispatchedReceiptAndDeny(
          fenceClient, ctx, spec, existing.id, reason, 'approval',
        );
      }
      await auditDenial(fenceClient, ctx, spec, reason, 'approval');
      return {
        kind: 'denied',
        reason,
      };
    }
    if (approval.status === 'EXPIRED') {
      if (pendingRecovery && existing) {
        return requestFreshApproval(fenceClient, ctx, spec, key, existing.id);
      }
      const reason = `approval expired for ${spec.action}`;
      await auditDenial(fenceClient, ctx, spec, reason, 'approval');
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
    await withClientTransaction(fenceClient, (tx) =>
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

  // Credential resolution can be slow. Revalidate approval with the database
  // clock at the final dispatch boundary so an approval cannot expire while a
  // broker is obtaining or refreshing credentials.
  if (usableGrant?.requires_approval && approvalId) {
    const approval = await withClientTransaction(fenceClient, (tx) =>
      lockApprovalForExecution(tx, {
        approvalId: approvalId!,
        runId: ctx.run.id,
        action: spec.action,
        resource: spec.resource,
        idempotencyKey: key,
      }));
    if (approval?.status !== 'APPROVED') {
      const reason = approval?.status === 'EXPIRED'
        ? `approval expired for ${spec.action}`
        : `approval no longer authorizes ${spec.action}`;
      if (approval?.status === 'EXPIRED' && pendingRecovery && existing) {
        return requestFreshApproval(fenceClient, ctx, spec, key, existing.id);
      }
      if (priorOutcomeKnownAbsent && existing) {
        return failUndispatchedReceiptAndDeny(
          fenceClient, ctx, spec, existing.id, reason, 'approval',
        );
      }
      await auditDenial(fenceClient, ctx, spec, reason, 'approval');
      return { kind: 'denied', reason };
    }
  }

  const receipt =
    (pendingRecovery ? existing : null) ??
    (await withClientTransaction(fenceClient, async (tx) => {
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
  const receiptCreatedNow = !pendingRecovery;

  await assertCurrentActionOwner(fenceClient, ctx);
  await spec.beforeDispatch?.();
  if (usableGrant) {
    const stillAuthorized = await withClientTransaction(fenceClient, (tx) =>
      revalidateGrantForDispatch(tx, {
        grantId: usableGrant.id,
        runId: ctx.run.id,
        action: spec.action,
        resource: spec.resource,
      }));
    if (!stillAuthorized) {
      const reason = `capability grant expired before dispatch for ${spec.action}`;
      if (receiptCreatedNow || priorOutcomeKnownAbsent) {
        return failUndispatchedReceiptAndDeny(
          fenceClient, ctx, spec, receipt.id, reason, 'policy',
        );
      }
      await auditDenial(fenceClient, ctx, spec, reason, 'policy');
      return { kind: 'denied', reason };
    }
  }
  if (usableGrant?.requires_approval && approvalId) {
    const finalApproval = await withClientTransaction(fenceClient, (tx) =>
      lockApprovalForExecution(tx, {
        approvalId: approvalId!,
        runId: ctx.run.id,
        action: spec.action,
        resource: spec.resource,
        idempotencyKey: key,
      }));
    if (finalApproval?.status === 'EXPIRED') {
      return requestFreshApproval(fenceClient, ctx, spec, key, receipt.id);
    }
    if (finalApproval?.status !== 'APPROVED') {
      const reason = finalApproval?.status === 'DENIED'
        ? `${spec.action} was denied by ${finalApproval.decision_by ?? 'a human'}`
        : `approval no longer authorizes ${spec.action}`;
      if (receiptCreatedNow || priorOutcomeKnownAbsent) {
        return failUndispatchedReceiptAndDeny(
          fenceClient, ctx, spec, receipt.id, reason, 'approval',
        );
      }
      await auditDenial(fenceClient, ctx, spec, reason, 'approval');
      return { kind: 'denied', reason };
    }
  }
  await assertCurrentActionOwner(fenceClient, ctx);
  let dispatched: Awaited<ReturnType<typeof spec.dispatch>>;
  try {
    dispatched = await spec.dispatch({ idempotencyKey: key, credential, signal });
  } catch (error) {
    if (spec.recovery === 'reconcile' && !spec.reconcile) {
      await markReconciliationRequired(
        fenceClient,
        ctx,
        spec,
        receipt.id,
        'dispatch failed with an uncertain external outcome',
      );
    } else {
      await auditRetryableFailure(fenceClient, ctx, spec, receipt.id, 'dispatch');
    }
    throw error;
  }
  spec.afterDispatch?.();
  try {
    await withClientTransaction(fenceClient, async (tx) => {
      await assertCurrentActionOwner(tx, ctx);
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
  } catch (error) {
    if (spec.recovery === 'reconcile' && !spec.reconcile) {
      await markReconciliationRequired(
        fenceClient,
        ctx,
        spec,
        receipt.id,
        'local receipt commit failed after remote success',
      );
    } else {
      await auditRetryableFailure(fenceClient, ctx, spec, receipt.id, 'receipt_commit');
    }
    throw error;
  }
  spec.afterCommit?.();
  return { kind: 'completed', value: dispatched.value, deduplicated: false };
}
