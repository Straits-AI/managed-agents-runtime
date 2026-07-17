import { describe, it, expect } from 'vitest';
import {
  evaluate,
  initialSupervisorState,
  DEFAULT_THRESHOLDS,
  type SupervisorInput,
  type SupervisorState,
} from '../src/harness/supervisor.js';

/** Build an input, defaulting to a healthy step, and let tests override. */
function input(over: Partial<SupervisorInput> & { state: SupervisorState }): SupervisorInput {
  return {
    proposedSignature: 'noop()',
    proposedTargets: [],
    completedItems: [],
    remainingItems: 3,
    step: 1,
    maxSteps: 100,
    tokensUsed: 0n,
    tokenBudget: null,
    ...over,
  };
}

describe('semantic supervisor', () => {
  it('lets a healthy, progressing run continue', () => {
    let state = initialSupervisorState();
    for (let i = 0; i < 6; i++) {
      const r = evaluate(input({ state, proposedSignature: `act-${i}`, completedItems: Array(i).fill('x') }));
      expect(r.directive.kind).toBe('continue');
      expect(r.detections).toHaveLength(0);
      state = r.state;
    }
  });

  it('detects a loop and climbs recover → escalate_model → terminate', () => {
    let state = initialSupervisorState();
    const kinds: string[] = [];
    // Same action every step; grow completed so stagnation does not confound.
    for (let i = 0; i < 6; i++) {
      const r = evaluate(input({ state, proposedSignature: 'read(file.txt)', completedItems: Array(i).fill('x') }));
      kinds.push(r.directive.kind);
      state = r.state;
    }
    // 3 repeats trips the loop; then the escalation ladder.
    expect(kinds).toEqual(['continue', 'continue', 'recover', 'escalate_model', 'escalate_model', 'terminate']);
    const last = evaluate(input({ state, proposedSignature: 'read(file.txt)' }));
    expect(last.directive.kind).toBe('terminate');
    expect(last.directive).toMatchObject({ reason: 'loop_unrecovered' });
  });

  it('escalates the model exactly maxEscalations times before terminating', () => {
    let state = initialSupervisorState();
    let escalations = 0;
    let terminated = false;
    for (let i = 0; i < 8 && !terminated; i++) {
      const r = evaluate(input({ state, proposedSignature: 'loop()', completedItems: Array(i).fill('x') }));
      if (r.directive.kind === 'escalate_model') escalations++;
      if (r.directive.kind === 'terminate') terminated = true;
      state = r.state;
    }
    expect(escalations).toBe(DEFAULT_THRESHOLDS.maxEscalations);
    expect(terminated).toBe(true);
    expect(state.escalationLevel).toBe(DEFAULT_THRESHOLDS.maxEscalations);
  });

  it('detects stagnation when the progress ledger stays flat', () => {
    let state = initialSupervisorState();
    let detected: string | undefined;
    // Distinct actions each step (no loop) but completed count never grows.
    for (let i = 0; i < DEFAULT_THRESHOLDS.stagnationSteps; i++) {
      const r = evaluate(input({ state, proposedSignature: `act-${i}`, completedItems: ['done-1'] }));
      state = r.state;
      if (r.detections.some((d) => d.kind === 'stagnation')) detected = r.directive.kind;
    }
    expect(detected).toBe('recover'); // first stagnation → soft recovery
  });

  it('resets the recovery ladder once progress resumes', () => {
    let state = initialSupervisorState();
    // Stagnate enough to trigger one recovery.
    for (let i = 0; i < DEFAULT_THRESHOLDS.stagnationSteps; i++) {
      state = evaluate(input({ state, proposedSignature: `a-${i}`, completedItems: ['x'] })).state;
    }
    expect(state.recoveries).toBeGreaterThan(0);
    // Now make real progress: completed grows and window refills with rising counts.
    for (let i = 0; i < DEFAULT_THRESHOLDS.window; i++) {
      state = evaluate(input({ state, proposedSignature: `b-${i}`, completedItems: Array(i + 2).fill('x') })).state;
    }
    expect(state.recoveries).toBe(0);
  });

  it('flags context loss when an action redoes a completed item', () => {
    const state = initialSupervisorState();
    const r = evaluate(
      input({
        state,
        proposedSignature: 'write(migration schema)',
        proposedTargets: ['Created the migration schema'],
        completedItems: ['Created the migration schema'],
      }),
    );
    expect(r.detections.some((d) => d.kind === 'context_loss')).toBe(true);
    expect(r.directive.kind).toBe('recover');
  });

  it('winds down (not escalates) when step budget runs low with work remaining', () => {
    const state = initialSupervisorState();
    const r = evaluate(input({ state, step: 95, maxSteps: 100, remainingItems: 2, proposedSignature: 'act' }));
    expect(r.directive.kind).toBe('wind_down');
    const bl = r.detections.find((d) => d.kind === 'budget_low');
    expect(bl).toMatchObject({ basis: 'steps' });
    if (r.directive.kind === 'wind_down') expect(r.directive.note).toMatch(/budget/i);
  });

  it('winds down on low token budget too', () => {
    const state = initialSupervisorState();
    const r = evaluate(
      input({ state, step: 2, maxSteps: 100, tokensUsed: 950n, tokenBudget: 1000n, remainingItems: 1 }),
    );
    expect(r.detections.find((d) => d.kind === 'budget_low')).toMatchObject({ basis: 'tokens' });
    expect(r.directive.kind).toBe('wind_down');
  });

  it('does not warn about budget when no work remains', () => {
    const state = initialSupervisorState();
    const r = evaluate(input({ state, step: 99, maxSteps: 100, remainingItems: 0 }));
    expect(r.detections.some((d) => d.kind === 'budget_low')).toBe(false);
    expect(r.directive.kind).toBe('continue');
  });

  it('ignores no-tool steps for loop detection', () => {
    let state = initialSupervisorState();
    for (let i = 0; i < 6; i++) {
      const r = evaluate(input({ state, proposedSignature: null, completedItems: Array(i).fill('x') }));
      expect(r.detections.some((d) => d.kind === 'loop')).toBe(false);
      state = r.state;
    }
  });
});
