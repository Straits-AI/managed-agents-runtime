import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { newId } from '../ids.js';
import { canonicalJson, sha256 } from './receipts.js';
import { createRun } from './runs.js';
import { transitionRun } from '../core/transition.js';
import type { ManagedSessionRow } from './sessions.js';
import type {
  RunRow,
  SignalPayloadPrimitiveType,
  SignalPayloadSchema,
} from '../core/types.js';
import { withTransaction } from '../db/tx.js';
import { RunAdmissionRejectedError } from './admissions.js';

type Q = Pool | Tx;

export type SessionEventType =
  | 'kertas.signal.received'
  | 'kertas.objective.requested'
  | 'kertas.feedback.received';

export interface SnapshotReference {
  snapshotId: string;
  digest: string;
  sizeBytes: number;
  formatVersion: string;
}

export interface ManagedSessionEventRow {
  id: string;
  tenant_id: string;
  session_id: string;
  source_type: string;
  source_id: string;
  source_event_id: string;
  source_sequence: string | null;
  payload_digest: string;
  received_sequence: string;
  api_version: string;
  type: SessionEventType;
  occurred_at: Date;
  subject: Record<string, unknown> | null;
  data: Record<string, unknown>;
  input_snapshot_refs: SnapshotReference[];
  correlation_id: string | null;
  dispatch_class: 'current-run' | 'future-run';
  status: 'PENDING' | 'CONSUMED' | 'DISPATCHED' | 'STALE';
  status_reason: string | null;
  run_id: string | null;
  dispatch_after: Date;
  created_at: Date;
  consumed_at: Date | null;
}

export class SessionEventConflictError extends Error {
  constructor() {
    super('event ID was already used with a different payload');
    this.name = 'SessionEventConflictError';
  }
}

export class SessionEventDeliveryError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'SessionEventDeliveryError';
  }
}

export interface ReceiveSessionEventInput {
  tenantId: string;
  sessionId: string;
  sourceType: string;
  sourceId: string;
  sourceEventId: string;
  sourceSequence?: number;
  apiVersion: 'kertas.runtime/v1alpha1';
  type: SessionEventType;
  occurredAt: string;
  subject?: Record<string, unknown>;
  data: Record<string, unknown>;
  inputSnapshotRefs: SnapshotReference[];
  correlationId?: string;
}

function dispatchClass(type: SessionEventType): 'current-run' | 'future-run' {
  return type === 'kertas.signal.received' ? 'current-run' : 'future-run';
}

const SESSION_EVENT_DEDUP_LOCK_SEED = 0x53455654;

function matchesPrimitive(value: unknown, type: SignalPayloadPrimitiveType): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  return typeof value === type;
}

function matchesSignalPayload(value: unknown, schema: SignalPayloadSchema | null): boolean {
  if (!schema || schema.type === 'any') return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  if ((schema.required ?? []).some((name) => !(name in record))) return false;
  for (const [name, item] of Object.entries(record)) {
    const expected = properties[name];
    if (!expected) {
      if (schema.additionalProperties === false) return false;
      continue;
    }
    if (!matchesPrimitive(item, expected.type)) return false;
  }
  return true;
}

export async function receiveManagedSessionEvent(
  tx: Tx,
  input: ReceiveSessionEventInput,
): Promise<{ event: ManagedSessionEventRow; replayed: boolean } | null> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, $2))', [
    canonicalJson([
      input.tenantId,
      input.sourceType,
      input.sourceId,
      input.sourceEventId,
    ]),
    SESSION_EVENT_DEDUP_LOCK_SEED,
  ]);
  const { rows: sessions } = await tx.query<ManagedSessionRow>(
    'SELECT * FROM managed_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [input.sessionId, input.tenantId],
  );
  const session = sessions[0];
  if (!session) return null;
  const digest = sha256(canonicalJson({
    sessionId: input.sessionId,
    sourceSequence: input.sourceSequence ?? null,
    apiVersion: input.apiVersion,
    type: input.type,
    occurredAt: input.occurredAt,
    subject: input.subject ?? null,
    data: input.data,
    inputSnapshotRefs: input.inputSnapshotRefs,
    correlationId: input.correlationId ?? null,
  }));
  const { rows: existingRows } = await tx.query<ManagedSessionEventRow>(
    `SELECT * FROM managed_session_events
     WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3 AND source_event_id = $4
     FOR UPDATE`,
    [input.tenantId, input.sourceType, input.sourceId, input.sourceEventId],
  );
  const existing = existingRows[0];
  if (existing) {
    if (existing.payload_digest !== digest) throw new SessionEventConflictError();
    return { event: existing, replayed: true };
  }
  if (session.state === 'CANCELLED' || session.state === 'ARCHIVED') {
    throw new SessionEventDeliveryError(`session_${session.state.toLowerCase()}`);
  }

  const classification = dispatchClass(input.type);
  let currentRun: RunRow | null = null;
  if (classification === 'current-run') {
    if (!session.current_top_level_run_id) {
      throw new SessionEventDeliveryError('no_current_run');
    }
    const { rows } = await tx.query<RunRow>('SELECT * FROM runs WHERE id = $1', [
      session.current_top_level_run_id,
    ]);
    currentRun = rows[0] ?? null;
    const signalName = input.data.name;
    if (
      !currentRun
      || currentRun.status !== 'WAITING_SIGNAL'
      || typeof signalName !== 'string'
      || currentRun.awaited_signal !== signalName
      || currentRun.awaited_signal_correlation_id !== (input.correlationId ?? null)
      || !matchesSignalPayload(input.data.payload, currentRun.awaited_signal_schema)
    ) {
      throw new SessionEventDeliveryError('current_run_wait_mismatch');
    }
  }

  const { rows: sequenceRows } = await tx.query<{ received_event_seq: string }>(
    `UPDATE managed_sessions
     SET received_event_seq = received_event_seq + 1,
         version = version + 1, updated_at = now()
     WHERE id = $1
     RETURNING received_event_seq`,
    [session.id],
  );
  const receivedSequence = sequenceRows[0]!.received_event_seq;
  const eventId = newId('sevt');
  const initialStatus = classification === 'current-run' ? 'CONSUMED' : 'PENDING';
  const { rows: inserted } = await tx.query<ManagedSessionEventRow>(
    `INSERT INTO managed_session_events
       (id, tenant_id, session_id, source_type, source_id, source_event_id,
        source_sequence, payload_digest, received_sequence, api_version, type,
        occurred_at, subject, data, input_snapshot_refs, correlation_id,
        dispatch_class, status, run_id, consumed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             CASE WHEN $18 = 'CONSUMED' THEN now() ELSE NULL END)
     RETURNING *`,
    [
      eventId, input.tenantId, session.id, input.sourceType, input.sourceId,
      input.sourceEventId, input.sourceSequence ?? null, digest, receivedSequence,
      input.apiVersion, input.type, input.occurredAt,
      input.subject ? JSON.stringify(input.subject) : null, JSON.stringify(input.data),
      JSON.stringify(input.inputSnapshotRefs), input.correlationId ?? null,
      classification, initialStatus, currentRun?.id ?? null,
    ],
  );
  const accepted = inserted[0]!;

  if (classification === 'current-run') {
    await transitionRun(tx, currentRun!.id, {
      expectFrom: ['WAITING_SIGNAL'],
      to: 'QUEUED',
      event: {
        type: 'SignalReceived',
        payload: {
          name: input.data.name as string,
          payload: input.data.payload ?? null,
          sessionEventId: eventId,
        },
      },
      patch: {
        current_attempt_id: null,
        awaited_signal: null,
        awaited_signal_correlation_id: null,
        awaited_signal_schema: null,
      },
    });
  }
  return { event: accepted, replayed: false };
}

export async function listManagedSessionEvents(
  q: Q,
  sessionId: string,
  tenantId: string,
  input: { afterReceivedSequence?: string; limit: number },
): Promise<{ events: ManagedSessionEventRow[]; nextCursor: string | null }> {
  const { rows } = await q.query<ManagedSessionEventRow>(
    `SELECT e.* FROM managed_session_events e
     JOIN managed_sessions s ON s.id = e.session_id
     WHERE e.session_id = $1 AND s.tenant_id = $2
       AND e.received_sequence > $3
     ORDER BY e.received_sequence
     LIMIT $4`,
    [sessionId, tenantId, input.afterReceivedSequence ?? '0', input.limit + 1],
  );
  const hasMore = rows.length > input.limit;
  const events = hasMore ? rows.slice(0, input.limit) : rows;
  return {
    events,
    nextCursor: hasMore ? events.at(-1)!.received_sequence : null,
  };
}

export async function dispatchPendingSessionEvents(
  pool: Pool,
  options: { candidateLimit?: number; retryDelayMs?: number; now?: Date } = {},
): Promise<string[]> {
  const candidateLimit = options.candidateLimit ?? 32;
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const dispatchNow = options.now ?? new Date();
  const { rows: candidates } = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT s.id, s.tenant_id
     FROM managed_sessions s
     JOIN LATERAL (
       SELECT e.created_at, e.dispatch_after
       FROM managed_session_events e
       WHERE e.session_id = s.id AND e.status = 'PENDING'
         AND e.dispatch_class = 'future-run'
       ORDER BY e.received_sequence LIMIT 1
     ) next_event ON next_event.dispatch_after <= $2::timestamptz
     WHERE s.state = 'IDLE'
     ORDER BY next_event.created_at, s.id
     LIMIT $1`,
    [candidateLimit, dispatchNow],
  );
  const dispatched: string[] = [];
  for (const candidate of candidates) {
    let runId: string | null;
    try {
      runId = await withTransaction(pool, async (tx) => {
        const { rows: sessions } = await tx.query<ManagedSessionRow>(
          `SELECT * FROM managed_sessions
           WHERE id = $1 AND tenant_id = $2 AND state = 'IDLE'
           FOR UPDATE SKIP LOCKED`,
          [candidate.id, candidate.tenant_id],
        );
        const session = sessions[0];
        if (!session) return null;
        const { rows: events } = await tx.query<ManagedSessionEventRow>(
          `SELECT * FROM managed_session_events
           WHERE session_id = $1 AND status = 'PENDING'
             AND dispatch_class = 'future-run' AND dispatch_after <= $2::timestamptz
           ORDER BY received_sequence
           LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [session.id, dispatchNow],
        );
        const event = events[0];
        if (!event) return null;
        const goal = typeof event.data.goal === 'string'
          ? event.data.goal
          : `${session.objective}\n\nInbound event: ${event.type}`;
        const run = await createRun(tx, {
          tenantId: session.tenant_id,
          managedSessionId: session.id,
          agentVersionId: session.agent_version_id,
          goal,
          input: {
            sessionEventId: event.id,
            eventType: event.type,
            data: event.data,
            inputSnapshotRefs: event.input_snapshot_refs,
          },
        });
        await tx.query(
          `UPDATE managed_session_events
           SET status = 'DISPATCHED', run_id = $2, consumed_at = now()
           WHERE id = $1`,
          [event.id, run.id],
        );
        return run.id;
      });
    } catch (error) {
      if (error instanceof RunAdmissionRejectedError) {
        await pool.query(
          `UPDATE managed_session_events
           SET dispatch_after = $3::timestamptz + ($2::double precision * interval '1 millisecond')
           WHERE session_id = $1 AND status = 'PENDING'
             AND dispatch_class = 'future-run'
             AND dispatch_after < $3::timestamptz + ($2::double precision * interval '1 millisecond')`,
          [candidate.id, retryDelayMs, dispatchNow],
        );
        continue;
      }
      throw error;
    }
    if (runId) dispatched.push(runId);
  }
  return dispatched;
}
