import type { Pool } from 'pg';
import { withTransaction, type Tx } from '../db/tx.js';
import { appendEvent } from '../core/transition.js';
import type { EventType, ProgressLedger } from '../core/types.js';
import type { ToolCall } from '../providers/types.js';
import type { SupervisorResult } from './supervisor.js';

/**
 * Epoch-side glue for the semantic supervisor (memo §25). Keeps supervisor.ts
 * pure/deterministic: this module derives supervisor inputs from live state and
 * writes the resulting detections/directives to the durable event ledger.
 */

/** Deterministic JSON with sorted keys, so identical calls hash identically. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * A stable signature for this step's proposed actions (for loop detection) plus
 * the string targets they touch (for context-loss detection). Two steps that
 * call the same tools with the same arguments produce the same signature.
 */
export function actionSignature(toolCalls: ToolCall[]): {
  signature: string;
  targets: string[];
} {
  const signature = toolCalls
    .map((c) => `${c.name}(${stableStringify(c.arguments)})`)
    .join('|');
  const targets: string[] = [];
  for (const c of toolCalls) {
    for (const val of Object.values(c.arguments)) {
      if (typeof val === 'string' && val.trim().length > 0) targets.push(val);
    }
  }
  return { signature, targets };
}

export function ledgerCompleted(progress: unknown): string[] {
  const p = progress as ProgressLedger | undefined;
  return Array.isArray(p?.completed) ? p!.completed! : [];
}

export function ledgerRemaining(progress: unknown): number {
  const p = progress as ProgressLedger | undefined;
  return (p?.active?.length ?? 0) + (p?.remaining?.length ?? 0);
}

const DETECTION_EVENT: Record<string, EventType> = {
  loop: 'LoopDetected',
  stagnation: 'StagnationDetected',
  context_loss: 'ContextLossDetected',
  budget_low: 'BudgetPlanUpdated',
};

/**
 * Write the supervisor's detections and its recovery/escalation directive to
 * the ledger (all in one transaction). The caller handles a 'terminate'
 * directive itself (it owns the RUN→FAILED transition) and injects any note
 * into the model context; here we only record what happened.
 */
export async function recordSupervision(
  pool: Pool,
  runId: string,
  attemptId: string,
  sup: SupervisorResult,
): Promise<void> {
  await withTransaction(pool, async (tx: Tx) => {
    for (const d of sup.detections) {
      await appendEvent(tx, runId, { type: DETECTION_EVENT[d.kind]!, payload: d }, { attemptId });
    }
    if (sup.directive.kind === 'escalate_model') {
      await appendEvent(
        tx,
        runId,
        { type: 'ModelEscalated', payload: { escalationLevel: sup.state.escalationLevel } },
        { attemptId },
      );
      await appendEvent(
        tx,
        runId,
        { type: 'SemanticRecoveryApplied', payload: { strategy: 'escalate_model' } },
        { attemptId },
      );
    } else if (sup.directive.kind === 'recover') {
      await appendEvent(
        tx,
        runId,
        { type: 'SemanticRecoveryApplied', payload: { strategy: 'corrective_note' } },
        { attemptId },
      );
    }
    // 'wind_down' is already recorded by its BudgetPlanUpdated detection event;
    // 'terminate' is recorded by the caller's RunFailed transition.
  });
}
