import type { RunStatus } from './types.js';

/**
 * Allowed run-state transitions (memo §12). WAITING_SIGNAL /
 * WAITING_CHILDREN / SLEEPING / SUSPENDED are in the enum but have no
 * inbound edges in Phase 1.
 */
const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  CREATED: ['RESOLVING', 'FAILED', 'CANCELLED'],
  RESOLVING: ['QUEUED', 'FAILED', 'CANCELLED'],
  QUEUED: ['STARTING', 'FAILED', 'CANCELLED'],
  STARTING: ['RUNNING', 'QUEUED', 'RETRY_PENDING', 'FAILED', 'CANCELLED'],
  RUNNING: [
    'WAITING_APPROVAL',
    'WAITING_SIGNAL',
    'RETRY_PENDING',
    'VERIFYING',
    'QUEUED', // clean epoch exit that should immediately reschedule
    'FAILED',
    'CANCELLED',
  ],
  WAITING_APPROVAL: ['QUEUED', 'FAILED', 'CANCELLED'],
  WAITING_SIGNAL: ['QUEUED', 'FAILED', 'CANCELLED'],
  WAITING_CHILDREN: ['QUEUED', 'FAILED', 'CANCELLED'],
  SLEEPING: ['QUEUED', 'FAILED', 'CANCELLED'],
  SUSPENDED: ['QUEUED', 'FAILED', 'CANCELLED'],
  RETRY_PENDING: ['QUEUED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'RUNNING', 'QUEUED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly runId: string,
    public readonly from: RunStatus,
    public readonly to: RunStatus,
  ) {
    super(`Invalid transition for ${runId}: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function isTransitionAllowed(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RunStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
