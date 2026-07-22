// Core resource model types (memo §8, §11, §12, §16, §18).

export const RUN_STATUSES = [
  'CREATED',
  'RESOLVING',
  'QUEUED',
  'STARTING',
  'RUNNING',
  'WAITING_APPROVAL',
  'WAITING_SIGNAL', // defined per memo §12; unreachable in Phase 1
  'WAITING_CHILDREN', // unreachable in Phase 1
  'SLEEPING', // unreachable in Phase 1
  'SUSPENDED', // unreachable in Phase 1
  'RETRY_PENDING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type AttemptState = 'ACTIVE' | 'EXITED' | 'ORPHANED';

export type EpochExitReason =
  | 'completed'
  | 'suspended_for_approval'
  | 'suspended_for_signal'
  | 'suspended_for_children'
  | 'budget_exhausted'
  | 'error'
  // The epoch already wrote a terminal FAILED transition (e.g. the supervisor
  // gave up on a stuck run). settleAttempt must NOT retry — unlike 'error'.
  | 'failed'
  | 'lease_lost'
  | 'cancelled';

export type EventType =
  | 'RunCreated'
  | 'AgentVersionResolved'
  | 'CapabilitiesResolved'
  | 'RunQueued'
  | 'AttemptStarted'
  | 'AttemptExited'
  | 'AttemptOrphaned'
  | 'SandboxAllocated'
  | 'SandboxTerminated'
  | 'WorkspaceRestored'
  | 'WorkspaceCheckpointed'
  | 'ContextCompiled'
  | 'ModelInvocationStarted'
  | 'ModelInvocationCompleted'
  | 'ActionProposed'
  | 'ActionAuthorized'
  | 'ActionDenied'
  | 'ToolInvoked'
  | 'ToolInvocationStarted'
  | 'ToolInvocationCommitted'
  | 'ToolInvocationFailed'
  | 'ProgressUpdated'
  | 'LoopDetected'
  | 'StagnationDetected'
  | 'ContextLossDetected'
  | 'SemanticRecoveryApplied'
  | 'ModelEscalated'
  | 'BudgetPlanUpdated'
  | 'SignalReceived'
  | 'ChildRunSpawned'
  | 'ChildRunReplaced'
  | 'ChildReplacementDeferred'
  | 'ChildrenResolved'
  | 'ApprovalRequested'
  | 'ApprovalReceived'
  | 'ApprovalDenied'
  | 'UserMessageReceived'
  | 'RetryScheduled'
  | 'VerificationStarted'
  | 'VerificationPassed'
  | 'VerificationFailed'
  | 'RunCompleted'
  | 'RunFailed'
  | 'RunCancelled';

export interface RunRow {
  id: string;
  tenant_id: string;
  agent_version_id: string;
  parent_run_id: string | null;
  /** The failed child run this run replaces (memo §25 subagent replacement). */
  replaces_run_id: string | null;
  /** 0 for an original child; N for its Nth replacement. */
  replacement_generation: number;
  /** The source run this run was forked from (memo §20 fork). */
  forked_from_run_id: string | null;
  goal: string;
  input: Record<string, unknown>;
  status: RunStatus;
  status_reason: string | null;
  result: import('./delegatedResults.js').DurableRunResult | null;
  result_size_bytes: number | null;
  progress: ProgressLedger | Record<string, never>;
  workspace_id: string | null;
  current_attempt_id: string | null;
  last_event_seq: string; // BIGINT comes back as string from pg
  max_steps: number;
  token_budget: string | null;
  tokens_used: string;
  awaited_signal: string | null;
  scheduled_for: Date | null;
  debug_fault_points: string[];
  created_at: Date;
  updated_at: Date;
}

export interface RunEventRow {
  run_id: string;
  seq: string;
  type: EventType;
  payload: Record<string, unknown>;
  attempt_id: string | null;
  created_at: Date;
}

export interface RunAttemptRow {
  id: string;
  run_id: string;
  attempt_no: number;
  worker_id: string;
  state: AttemptState;
  lease_expires_at: Date;
  heartbeat_at: Date;
  sandbox_id: string | null;
  sandbox_domain: string | null;
  started_from_checkpoint_id: string | null;
  exit_reason: string | null;
  created_at: Date;
}

/** Structured progress state (memo §16.2) — survives compaction and recovery. */
export interface ProgressLedger {
  objective?: string;
  completed?: string[];
  active?: string[];
  blocked?: { item: string; reason: string }[];
  remaining?: string[];
}

/** Model-proposed semantic action (memo §17). */
export interface SemanticAction {
  action: string;
  resource?: string;
  arguments: Record<string, unknown>;
  risk?: 'read' | 'workspace_write' | 'external_write';
}

export type CheckpointAgentState = import('./checkpoints.js').CheckpointEnvelopeV2;
