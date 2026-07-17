/**
 * Semantic supervisor (memo §25, Phase 5). A provider-neutral, PURE evaluator
 * that watches a run's own durable signals — the sequence of proposed actions,
 * the progress ledger, and the remaining budget — and decides whether the agent
 * is making progress or is stuck, and what to do about it.
 *
 * It detects:
 *   - loop:         the same action proposed over and over;
 *   - stagnation:   the progress ledger not advancing for many steps;
 *   - context_loss: an action re-doing work the ledger already records as done;
 *   - budget_low:   little step/token budget left relative to remaining work.
 *
 * and escalates a stuck run through a bounded ladder — soft corrective note →
 * stronger model → terminate — so a run can never spin forever burning budget.
 * The epoch owns all side effects (events, context injection, transitions); this
 * module only computes, which keeps it deterministic and fully unit-testable.
 */

export interface SupervisorThresholds {
  /** Same action signature repeated this many times in a row → loop. */
  loopThreshold: number;
  /** Progress ledger flat for this many consecutive steps → stagnation. */
  stagnationSteps: number;
  /** Rolling window kept for the action/progress histories. */
  window: number;
  /** Below this fraction of step/token budget remaining → budget_low. */
  budgetHeadroom: number;
  /** Consecutive stuck steps escalate; beyond this the run terminates. */
  maxEscalations: number;
}

export const DEFAULT_THRESHOLDS: SupervisorThresholds = {
  loopThreshold: 3,
  stagnationSteps: 5,
  window: 8,
  budgetHeadroom: 0.15,
  maxEscalations: 2,
};

/** Rolling supervisor state, persisted in the checkpoint so it survives crashes. */
export interface SupervisorState {
  /** Recent action signatures, most-recent last (∅ = a no-tool step). */
  actionWindow: string[];
  /** Recent progress-ledger completed counts, most-recent last. */
  progressWindow: number[];
  /** How many times we have escalated the model for this run. */
  escalationLevel: number;
  /** Consecutive stuck steps for which recovery has been applied. */
  recoveries: number;
}

export function initialSupervisorState(): SupervisorState {
  return { actionWindow: [], progressWindow: [], escalationLevel: 0, recoveries: 0 };
}

export interface SupervisorInput {
  state: SupervisorState;
  /** This step's proposed-action signature, or null if the step used no tools. */
  proposedSignature: string | null;
  /** Resources/targets this step's actions touch, for context-loss detection. */
  proposedTargets: string[];
  /** The ledger's current `completed` items. */
  completedItems: string[];
  /** Count of `active` + `remaining` ledger items (work still to do). */
  remainingItems: number;
  step: number;
  maxSteps: number;
  tokensUsed: bigint;
  tokenBudget: bigint | null;
}

export type Detection =
  | { kind: 'loop'; signature: string; repeats: number }
  | { kind: 'stagnation'; steps: number }
  | { kind: 'context_loss'; item: string }
  | { kind: 'budget_low'; fraction: number; basis: 'steps' | 'tokens' };

export type Directive =
  | { kind: 'continue' }
  | { kind: 'recover'; note: string }
  | { kind: 'escalate_model'; note: string }
  | { kind: 'wind_down'; note: string }
  | { kind: 'terminate'; reason: string };

export interface SupervisorResult {
  detections: Detection[];
  directive: Directive;
  /** Updated state the caller must persist for the next step. */
  state: SupervisorState;
}

function push<T>(arr: T[], v: T, cap: number): T[] {
  const next = [...arr, v];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Trailing count of identical entries at the end of the window. */
function trailingRepeats(window: string[]): number {
  if (window.length === 0) return 0;
  const last = window[window.length - 1]!;
  let n = 0;
  for (let i = window.length - 1; i >= 0 && window[i] === last; i--) n++;
  return n;
}

/**
 * Evaluate one step. Advances the rolling windows with this step's observation,
 * runs the detectors, and picks a directive via a bounded escalation ladder.
 */
export function evaluate(
  input: SupervisorInput,
  t: SupervisorThresholds = DEFAULT_THRESHOLDS,
): SupervisorResult {
  const signature = input.proposedSignature ?? '∅';
  const actionWindow = push(input.state.actionWindow, signature, t.window);
  const progressWindow = push(input.state.progressWindow, input.completedItems.length, t.window);

  const detections: Detection[] = [];

  // --- loop: the same real action repeated consecutively ---
  if (signature !== '∅') {
    const repeats = trailingRepeats(actionWindow);
    if (repeats >= t.loopThreshold) {
      detections.push({ kind: 'loop', signature, repeats });
    }
  }

  // --- stagnation: completed-count flat across a full window of steps ---
  if (progressWindow.length >= t.stagnationSteps) {
    const recent = progressWindow.slice(progressWindow.length - t.stagnationSteps);
    if (recent.every((c) => c === recent[0])) {
      detections.push({ kind: 'stagnation', steps: t.stagnationSteps });
    }
  }

  // --- context_loss: proposing work the ledger already records as completed ---
  const completedLower = input.completedItems.map((c) => c.toLowerCase());
  for (const target of input.proposedTargets) {
    const tl = target.toLowerCase();
    const hit = completedLower.find((c) => c.length > 0 && (c.includes(tl) || tl.includes(c)));
    if (hit) {
      detections.push({ kind: 'context_loss', item: hit });
      break;
    }
  }

  // --- budget_low: little runway left relative to remaining work ---
  const stepFraction = input.maxSteps > 0 ? (input.maxSteps - input.step) / input.maxSteps : 1;
  let tokenFraction = 1;
  if (input.tokenBudget !== null && input.tokenBudget > 0n) {
    const remaining = Number(input.tokenBudget - input.tokensUsed);
    tokenFraction = Math.max(0, remaining / Number(input.tokenBudget));
  }
  const basis: 'steps' | 'tokens' = stepFraction <= tokenFraction ? 'steps' : 'tokens';
  const fraction = Math.min(stepFraction, tokenFraction);
  if (fraction < t.budgetHeadroom && input.remainingItems > 0) {
    detections.push({ kind: 'budget_low', fraction, basis });
  }

  const stuck = detections.filter(
    (d) => d.kind === 'loop' || d.kind === 'stagnation' || d.kind === 'context_loss',
  );

  let directive: Directive;
  let escalationLevel = input.state.escalationLevel;
  let recoveries = input.state.recoveries;

  if (stuck.length > 0) {
    if (escalationLevel >= t.maxEscalations) {
      directive = { kind: 'terminate', reason: terminalReason(stuck) };
    } else if (recoveries >= 1) {
      // Already tried a soft nudge and still stuck → escalate the model.
      escalationLevel += 1;
      recoveries += 1;
      directive = { kind: 'escalate_model', note: recoveryNote(stuck, true) };
    } else {
      recoveries += 1;
      directive = { kind: 'recover', note: recoveryNote(stuck, false) };
    }
  } else if (detections.some((d) => d.kind === 'budget_low')) {
    // Not stuck, just running low — a planning nudge, not an escalation.
    recoveries = 0;
    directive = { kind: 'wind_down', note: budgetNote(input) };
  } else {
    recoveries = 0; // progress resumed; reset the consecutive-stuck counter
    directive = { kind: 'continue' };
  }

  return {
    detections,
    directive,
    state: { actionWindow, progressWindow, escalationLevel, recoveries },
  };
}

function terminalReason(stuck: Detection[]): string {
  const d = stuck[0]!;
  if (d.kind === 'loop') return 'loop_unrecovered';
  if (d.kind === 'stagnation') return 'stagnation_unrecovered';
  return 'context_loss_unrecovered';
}

function recoveryNote(stuck: Detection[], escalated: boolean): string {
  const kinds = stuck.map((d) => d.kind);
  const parts: string[] = [];
  if (kinds.includes('loop')) {
    parts.push('You are repeating the same action without effect.');
  }
  if (kinds.includes('stagnation')) {
    parts.push('Your progress ledger has not advanced for several steps.');
  }
  if (kinds.includes('context_loss')) {
    parts.push('You are redoing work your progress ledger already marks as completed.');
  }
  const lead = parts.join(' ');
  const tail = escalated
    ? 'A stronger model is now assisting. Re-read your progress ledger, choose a genuinely different approach, and if the goal is already met call run_complete.'
    : 'Stop and re-read your progress ledger. Change your approach — do not repeat the previous action — and if the goal is already met call run_complete.';
  return `${lead} ${tail}`;
}

function budgetNote(input: SupervisorInput): string {
  const stepsLeft = Math.max(0, input.maxSteps - input.step);
  const tokensLeft =
    input.tokenBudget !== null ? Number(input.tokenBudget - input.tokensUsed) : null;
  const budget =
    tokensLeft !== null
      ? `~${stepsLeft} steps and ~${tokensLeft} tokens`
      : `~${stepsLeft} steps`;
  return `Budget is running low: ${budget} remaining for ${input.remainingItems} outstanding item(s). Prioritize the most important remaining work, produce partial results, and call run_complete before the budget is exhausted rather than leaving the run to fail.`;
}
