import type { ProgressLedger } from './types.js';

export const CHECKPOINT_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_CHECKPOINT_VERSIONS = [1, 2] as const;

export interface CheckpointToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CheckpointEnvelopeV2 {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  step: number;
  transcriptTosKey?: string;
  contextSummary?: string;
  supervisor?: unknown;
  pendingToolCall?: CheckpointToolCall;
  commitments: {
    awaitedSignal: string | null;
    pendingApprovalIds: string[];
    activeChildRunIds: string[];
    pendingWork: Pick<ProgressLedger, 'active' | 'blocked' | 'remaining'>;
  };
  references: {
    childRunIds: string[];
    artifactIds: string[];
    evidence: Array<{ runId: string; eventSeq: string }>;
  };
  contextSelection: {
    strategyVersion: 'context-compiler/v1';
    transcriptTailLimit: number;
    transcriptMessagesAvailable: number;
    transcriptMessagesSelected: number;
    memoryIds: string[];
    userMessageCount: number;
    approvalOutcomeCount: number;
    skillRefs: string[];
  };
}

export class UnsupportedCheckpointVersionError extends Error {
  constructor(public readonly version: number) {
    super(`unsupported checkpoint schema version: ${version}`);
    this.name = 'UnsupportedCheckpointVersionError';
  }
}

export function createCheckpointEnvelope(
  input: Pick<CheckpointEnvelopeV2, 'step'> & Partial<Omit<CheckpointEnvelopeV2, 'schemaVersion' | 'step'>>,
): CheckpointEnvelopeV2 {
  const envelope: CheckpointEnvelopeV2 = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    step: input.step,
    ...(input.transcriptTosKey ? { transcriptTosKey: input.transcriptTosKey } : {}),
    ...(input.contextSummary ? { contextSummary: input.contextSummary } : {}),
    ...('supervisor' in input ? { supervisor: input.supervisor } : {}),
    ...(input.pendingToolCall ? { pendingToolCall: input.pendingToolCall } : {}),
    commitments: input.commitments ?? emptyCommitments(),
    references: input.references ?? emptyReferences(),
    contextSelection: input.contextSelection ?? emptyContextSelection(),
  };
  validateCheckpointEnvelope(envelope);
  return envelope;
}

export function decodeCheckpointEnvelope(
  schemaVersion: number,
  raw: unknown,
): CheckpointEnvelopeV2 {
  if (schemaVersion === 1) {
    const legacy = record(raw, 'legacy checkpoint state');
    return createCheckpointEnvelope({
      step: nonNegativeInteger(legacy.step, 'checkpoint step'),
      ...(stringOrUndefined(legacy.transcriptTosKey, 'transcriptTosKey')
        ? { transcriptTosKey: String(legacy.transcriptTosKey) }
        : {}),
      ...(stringOrUndefined(legacy.contextSummary, 'contextSummary')
        ? { contextSummary: String(legacy.contextSummary) }
        : {}),
      ...('supervisor' in legacy ? { supervisor: legacy.supervisor } : {}),
      ...(legacy.pendingToolCall
        ? { pendingToolCall: toolCall(legacy.pendingToolCall) }
        : {}),
    });
  }
  if (schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new UnsupportedCheckpointVersionError(schemaVersion);
  }
  const envelope = record(raw, 'checkpoint envelope') as unknown as CheckpointEnvelopeV2;
  validateCheckpointEnvelope(envelope);
  return envelope;
}

export function validateCheckpointEnvelope(envelope: CheckpointEnvelopeV2): void {
  if (envelope.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new UnsupportedCheckpointVersionError(Number(envelope.schemaVersion));
  }
  nonNegativeInteger(envelope.step, 'checkpoint step');
  optionalString(envelope.transcriptTosKey, 'transcriptTosKey');
  optionalString(envelope.contextSummary, 'contextSummary');
  if (envelope.pendingToolCall) toolCall(envelope.pendingToolCall);

  const commitments = record(envelope.commitments, 'checkpoint commitments');
  if (commitments.awaitedSignal !== null && typeof commitments.awaitedSignal !== 'string') {
    throw new Error('checkpoint awaitedSignal is invalid');
  }
  stringArray(commitments.pendingApprovalIds, 'checkpoint pendingApprovalIds');
  stringArray(commitments.activeChildRunIds, 'checkpoint activeChildRunIds');
  const pendingWork = record(commitments.pendingWork, 'checkpoint pendingWork');
  stringArray(pendingWork.active, 'checkpoint pendingWork.active');
  stringArray(pendingWork.remaining, 'checkpoint pendingWork.remaining');
  const blocked = array(pendingWork.blocked, 'checkpoint pendingWork.blocked');
  for (const [index, entry] of blocked.entries()) {
    const item = record(entry, `checkpoint pendingWork.blocked[${index}]`);
    requiredString(item.item, `checkpoint pendingWork.blocked[${index}].item`);
    requiredString(item.reason, `checkpoint pendingWork.blocked[${index}].reason`);
  }

  const references = record(envelope.references, 'checkpoint references');
  stringArray(references.childRunIds, 'checkpoint childRunIds');
  stringArray(references.artifactIds, 'checkpoint artifactIds');
  const evidence = array(references.evidence, 'checkpoint evidence');
  for (const [index, entry] of evidence.entries()) {
    const ref = record(entry, `checkpoint evidence[${index}]`);
    requiredString(ref.runId, `checkpoint evidence[${index}].runId`);
    const eventSeq = requiredString(ref.eventSeq, `checkpoint evidence[${index}].eventSeq`);
    if (!/^\d+$/.test(eventSeq)) {
      throw new Error(`checkpoint evidence[${index}].eventSeq is invalid`);
    }
  }

  const selection = record(envelope.contextSelection, 'checkpoint contextSelection');
  if (selection.strategyVersion !== 'context-compiler/v1') {
    throw new Error('checkpoint contextSelection.strategyVersion is invalid');
  }
  const tailLimit = nonNegativeInteger(
    selection.transcriptTailLimit,
    'checkpoint contextSelection.transcriptTailLimit',
  );
  const available = nonNegativeInteger(
    selection.transcriptMessagesAvailable,
    'checkpoint contextSelection.transcriptMessagesAvailable',
  );
  const selected = nonNegativeInteger(
    selection.transcriptMessagesSelected,
    'checkpoint contextSelection.transcriptMessagesSelected',
  );
  if (selected > available || selected > tailLimit) {
    throw new Error('checkpoint contextSelection transcript selection is inconsistent');
  }
  nonNegativeInteger(selection.userMessageCount, 'checkpoint contextSelection.userMessageCount');
  nonNegativeInteger(
    selection.approvalOutcomeCount,
    'checkpoint contextSelection.approvalOutcomeCount',
  );
  stringArray(selection.memoryIds, 'checkpoint contextSelection.memoryIds');
  stringArray(selection.skillRefs, 'checkpoint contextSelection.skillRefs');
  assertSafeCheckpointValue(envelope);
}

/** Reject secrets and ephemeral signed transport URLs before durable storage. */
export function assertSafeCheckpointValue(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    if (looksLikeCredentialValue(value)) {
      throw new Error(`checkpoint contains a credential-like value at ${path}`);
    }
    const urls = value.match(/(?:https?|wss?):\/\/[^\s\"'<>]+/gi) ?? [];
    for (const url of urls) {
      let parsed: URL;
      try {
        parsed = new URL(url.replace(/[),.;]+$/, ''));
      } catch {
        throw new Error(`checkpoint contains invalid URL at ${path}`);
      }
      if (parsed.username || parsed.password) {
        throw new Error(`checkpoint contains a credential-bearing URL at ${path}`);
      }
      for (const key of parsed.searchParams.keys()) {
        if (isCredentialQueryParameter(key)) {
          throw new Error(`checkpoint contains a signed or credential-bearing URL at ${path}`);
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeCheckpointValue(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (/(?:secret|password|authorization|cookie|api[_-]?key|access[_-]?key|session[_-]?token|signed[_-]?url)/i.test(key)) {
        throw new Error(`checkpoint contains forbidden secret field at ${path}.${key}`);
      }
      assertSafeCheckpointValue(entry, `${path}.${key}`);
    }
  }
}

function looksLikeCredentialValue(value: string): boolean {
  return /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/i.test(value)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(value)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(value)
    || /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/.test(value)
    || /\bAIza[0-9A-Za-z_-]{30,}\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)
    || /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/.test(value);
}

function isCredentialQueryParameter(key: string): boolean {
  return /(?:signature|credential|token|ticket|authorization|cookie|expires)/i.test(key)
    || /^(?:sig|se|sv|sp|sr|skoid|sktid|skt|ske|sks|skv|policy|key-pair-id)$/i.test(key);
}

function emptyCommitments(): CheckpointEnvelopeV2['commitments'] {
  return {
    awaitedSignal: null,
    pendingApprovalIds: [],
    activeChildRunIds: [],
    pendingWork: { active: [], blocked: [], remaining: [] },
  };
}

function emptyReferences(): CheckpointEnvelopeV2['references'] {
  return { childRunIds: [], artifactIds: [], evidence: [] };
}

function emptyContextSelection(): CheckpointEnvelopeV2['contextSelection'] {
  return {
    strategyVersion: 'context-compiler/v1',
    transcriptTailLimit: 60,
    transcriptMessagesAvailable: 0,
    transcriptMessagesSelected: 0,
    memoryIds: [],
    userMessageCount: 0,
    approvalOutcomeCount: 0,
    skillRefs: [],
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  const values = array(value, label);
  if (values.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must contain only strings`);
  }
  return values as string[];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${label} is invalid`);
  return value;
}

function stringOrUndefined(value: unknown, label: string): boolean {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${label} is invalid`);
  return value !== undefined;
}

function toolCall(value: unknown): CheckpointToolCall {
  const candidate = record(value, 'pending tool call');
  if (typeof candidate.id !== 'string'
    || typeof candidate.name !== 'string'
    || !candidate.arguments
    || typeof candidate.arguments !== 'object'
    || Array.isArray(candidate.arguments)) {
    throw new Error('pending tool call is invalid');
  }
  return candidate as unknown as CheckpointToolCall;
}
