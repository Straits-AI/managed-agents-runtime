# Kertas ↔ managed runtime contract

**Contract family:** `kertas.runtime`  
**Target version:** `v1alpha1`  
**Status:** architecture accepted; ManagedSession API not yet implemented  
**Last reviewed:** 2026-07-19

Implementation is tracked by
[Issue #31](https://github.com/Straits-AI/managed-agents-runtime/issues/31) and
its scoped dependencies.

## Purpose

This document defines the public seam between Kertas and the Managed Agents
Runtime. It is a contract specification, not a claim that every target resource
already exists in the current API.

The contract must support:

- attached-to-detached agent handoff;
- future events resuming durable agent continuity;
- bounded executions with retries and recovery;
- Kertas-owned outcome and release evaluation;
- provider and harness replacement; and
- independent runtime deployment and versioning.

## Normative language

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative requirements.

## Resource model

### Project

`Project` is owned by Kertas and MUST NOT be persisted as a runtime aggregate.
The runtime MAY retain an opaque, tenant-scoped correlation reference supplied by
Kertas. It MUST NOT infer authorization from that reference.

### ManagedSession

A `ManagedSession` is the stable runtime address for an agent objective over
time. It owns:

- tenant and agent/harness binding;
- ordered inbound event persistence and deduplication;
- current runtime workspace lineage;
- budgets and execution policy;
- credential-grant references;
- linked Runs, approvals, artifacts, and lifecycle events; and
- `IDLE`, `ACTIVE`, `WAITING`, `REQUIRES_ACTION`, `CANCELLED`, and `ARCHIVED`
  lifecycle state.

A session MAY outlive any process, sandbox, model context, or Run.

### Run

A `Run` is one bounded execution episode created from a session objective or
inbound event. It owns:

- immutable input snapshot references;
- pinned agent/harness and policy versions;
- run-level budget and deadline;
- runtime events, checkpoints, receipts, and artifacts;
- a terminal execution disposition; and
- child/replacement lineage when the harness delegates work.

A `Run` MUST NOT be reused for a later unrelated event.

### Attempt

An `Attempt` is a leased execution of a Run. Attempts are disposable. They MUST
be fenced so stale workers cannot commit state after lease loss. Retrying an
Attempt MUST NOT create a second logical Run or duplicate a committed mutation.

## Cardinality and concurrency

```text
Project 1 ──▶ 0..n ManagedSessions
ManagedSession 1 ──▶ 0..n Runs
Run 1 ──▶ 0..n Attempts
Run 1 ──▶ 0..n child Runs
```

`v1alpha1` permits at most one active top-level Run per ManagedSession. Events
received while active are durably queued in canonical receipt order after
deduplication. Child Runs inherit the session ID and are session members; they are
allowed as part of the active top-level Run and do not violate that limit. A Run
may have zero Attempts while queued or when cancelled before its first claim.

## Current compatibility mapping

The current runtime exposes `Run` as the top-level durable object and has no
ManagedSession endpoint.

Until the target resource is implemented:

- Kertas MAY map one runtime Run to one temporary ManagedSession;
- Kertas MUST persist that mapping in Kertas, not in runtime internals;
- follow-up input MAY resume the same Run only where the current API explicitly
  supports it;
- callers MUST NOT assume multi-Run session history; and
- this compatibility mode MUST be identified as `run-as-session/v1`.

No database migration or internal table access is part of this compatibility
contract.

## Current versus target capability

| Capability | Current controlled-alpha runtime | `v1alpha1` target |
| --- | --- | --- |
| Top-level continuity | `Run` is the top-level durable object | `ManagedSession` contains multiple Runs |
| Session API | Not implemented | Versioned create/read/event/cancel/list routes |
| Active execution admission | Tenant-level atomic Run admission | One active top-level Run per session plus child Runs |
| Inbound session event queue | Signals target an existing Run | Deduplicated ordered session events create/resume Runs |
| Run/Attempt execution | Implemented internally with leases and fencing | Existing behavior exposed through versioned schemas; Attempt need not be a direct public mutation surface |
| Runtime event ledger | Implemented per Run | Versioned session/Run events with resource sequence, correlation, and causation |
| Workspace recovery | Run checkpoint/snapshot implemented | Session workspace lineage plus explicit Kertas snapshot transfer |
| Artifact output | Workspace paths mapped to object-store keys | First-class content-addressed Artifact resources |
| Child delegation | Child Runs, replacement, and parent wake-up implemented | Bounded results, artifact/evidence refs, usage, and queryable lineage |
| Public schemas/client fixtures | TypeScript/API behavior exists without a published machine-readable contract | Discoverable schemas, compatibility fixtures, and Kertas SDK conformance |

Normative requirements below describe the target unless the table marks them as
implemented. They do not retroactively claim a current public endpoint.

## API envelope

Every tenant-scoped contract request MUST include:

- authenticated tenant identity;
- a caller-generated `Idempotency-Key` for creation or mutation;
- `X-Request-Id` or equivalent correlation identifier when the caller has one;
  otherwise the server MUST generate and return one; and
- an explicit contract version through the route or media type.

Operational health/readiness endpoints MAY be unauthenticated when they expose no
tenant or internal diagnostic data. They are outside the tenant resource contract.

Every resource response MUST include:

```json
{
  "apiVersion": "kertas.runtime/v1alpha1",
  "kind": "ManagedSession",
  "id": "ses_...",
  "tenantId": "ten_...",
  "version": 7,
  "createdAt": "2026-07-19T00:00:00Z",
  "updatedAt": "2026-07-19T00:01:00Z"
}
```

Identifiers are opaque. Clients MUST NOT derive resource type, tenant,
authorization, ordering, or timestamps from identifier contents.

## Command semantics

Commands that create external effects MUST be idempotent. The uniqueness scope is
the tuple `(tenant, authenticated principal, operation, target resource or
collection, Idempotency-Key)`. The server MUST persist a canonical request digest
with the first accepted command.

- The same tuple and digest returns the original resource, receipt, or current
  in-flight status rather than dispatching a duplicate.
- The same tuple with a different digest fails with `409 idempotency_conflict`.
- Concurrent first deliveries serialize so exactly one becomes authoritative.
- The server publishes its replay-retention window, which MUST be at least the
  maximum supported caller retry window. Creation and irreversible-action
  records SHOULD be retained with the resulting resource/receipt lifecycle.

The target session surface is:

```text
POST   /v1alpha1/sessions
GET    /v1alpha1/sessions/{sessionId}
POST   /v1alpha1/sessions/{sessionId}/events
POST   /v1alpha1/sessions/{sessionId}/cancel
GET    /v1alpha1/sessions/{sessionId}/runs
GET    /v1alpha1/sessions/{sessionId}/events
```

This route list reserves semantics; implementation requires separate reviewed
tickets and contract tests.

## Inbound event contract

An event delivered to a session MUST contain:

```json
{
  "apiVersion": "kertas.runtime/v1alpha1",
  "eventId": "evt_source_stable_id",
  "type": "kertas.feedback.received",
  "occurredAt": "2026-07-19T00:00:00Z",
  "source": {
    "type": "kertas",
    "id": "deployment-or-connector-id",
    "sequence": 42
  },
  "subject": { "type": "project", "ref": "opaque-kertas-reference" },
  "data": {},
  "inputSnapshotRefs": [],
  "correlationId": "cor_..."
}
```

- Source identity MUST be authenticated or bound to the caller's configured
  connection; a payload cannot grant itself another source identity.
- The deduplication tuple is `(tenant, source.type, source.id, eventId)`.
- The first accepted payload stores a canonical digest. An exact replay returns
  the original receipt; a different payload for the same tuple fails with
  `409 event_conflict`.
- `occurredAt` is source time; runtime receipt time is recorded separately.
- `source.sequence` is required when the source promises ordering and optional
  otherwise. It is retained for gap/out-of-order detection, not used as trusted
  authorization or a global clock.
- Each accepted event receives a monotonic session `receivedSequence` under the
  session lock. That sequence, with serialized concurrent receipt, is the
  canonical processing order.
- `data` is bounded and schema-validated by event type.
- large inputs MUST be immutable references with content digests.
- unknown event types MUST fail closed or enter an explicit unhandled state.
- receipt MUST be acknowledged only after durable persistence.

## Outbound event contract

Runtime events are append-only observations. They MUST include:

- globally unique delivery/event ID;
- session ID and optional Run/Attempt IDs;
- per-resource monotonic sequence;
- event type and schema version;
- occurred and recorded timestamps;
- correlation and causation IDs;
- bounded redacted payload; and
- current resource version.

Delivery is at least once and MAY be out of order across resources. Kertas MUST
deduplicate by event ID and fetch current resource state before making a final
product decision.

The runtime MUST NOT emit credentials, authorization headers, signed URLs,
unredacted provider responses, or unrestricted model transcripts.

## State and failure semantics

The session state vocabulary for `v1alpha1` is:

```text
IDLE · ACTIVE · WAITING · REQUIRES_ACTION · CANCELLED · ARCHIVED
```

`COMPLETED`, `FAILED`, and `CANCELLED` are Run dispositions, not automatic
session dispositions. When a top-level Run completes or fails and no accepted
event remains queued, a nonterminal session returns to `IDLE`. A `CANCELLED`
session rejects later work. `ARCHIVED` rejects new events until an explicit,
audited restore operation permitted by policy. Events accepted while `ACTIVE`,
`WAITING`, or `REQUIRES_ACTION` remain queued; they do not silently resurrect or
replace the current Run.

Every event type declares one dispatch class:

- `current-run`: it MUST match the current Run's durable wait type, correlation,
  and schema. It resolves that wait in the existing Run and is consumed exactly
  once. A nonmatching event cannot interrupt or replace the Run.
- `future-run`: it is queued by `receivedSequence` and MUST NOT be delivered to
  the current Run.

When a top-level Run reaches a terminal disposition, the runtime locks the
session. In that transaction it first marks every accepted, unconsumed
`current-run` event terminal as `STALE`, records a stable reason and correlation,
and makes the updated receipt status observable through the session event log.
A stale event is consumed for queue accounting: it cannot remain pending, be
retried, or be reclassified as future work. The runtime then atomically inspects
accepted, unconsumed `future-run` events. If none exist, the session becomes
`IDLE`. Otherwise it dequeues the lowest `receivedSequence`, creates the next Run
from that event, and transitions the session to `ACTIVE` in the same transaction.

Run and Attempt states remain runtime-specific but MUST map to a documented
public state and reason code.

- HTTP success means the command was accepted or the resource was read; it does
  not mean the objective succeeded.
- infrastructure completion MUST NOT be reported as outcome satisfaction.
- terminal failure MUST carry a stable reason code and retriable classification.
- uncertain external mutations MUST enter reconciliation; they MUST NOT be
  blindly retried.
- cancellation MUST be durable and fence later worker commits.

## Workspace transfer

Kertas Project Workspace and runtime workspace are separate resources.

An import/export reference MUST include:

- immutable snapshot ID;
- SHA-256 or stronger content digest;
- byte size and format version;
- producing Project/Release or session/Run reference;
- creation timestamp;
- classification and retention policy; and
- authorized retrieval mechanism.

Signed retrieval URLs are transport details and MUST NOT become durable resource
identifiers.

## Artifact handoff

Declared logical runtime outputs MUST evolve from workspace paths/object keys to
artifact resources containing:

- stable artifact ID and content digest;
- MIME type, byte size, and logical role;
- producing session, Run, Attempt, and step;
- source input references;
- verification state and evidence references;
- storage locator hidden behind an authorized retrieval API; and
- supersession/publication relationships where available.

Kertas MAY ingest or reference runtime artifacts. A Kertas Release is a separate
immutable product object and is never implied by `RunCompleted`.

## Credential and action boundary

Kertas supplies credential-grant references, never secret values in model or
request payloads. The runtime resolves a grant only for the authenticated tenant,
session/Run, purpose, action, resource, approval state, expiry, and usage limit.

Mutating connectors MUST flow through the runtime governed-action protocol or a
Kertas committer with equivalent receipts. Ownership MUST be explicit per action;
the same mutation MUST NOT be independently committed by both systems.

## Versioning

- Routes or media types carry the contract version.
- Events carry independent event schema versions.
- Checkpoints, exports, and artifact manifests carry format versions.
- Additive fields MAY appear within an alpha version; clients MUST ignore unknown
  fields.
- Removing, renaming, or changing semantics MUST use a new version.
- A server MUST publish supported versions and deprecation dates.
- Kertas and runtime releases MUST declare the contract versions they require and
  provide.

## Security invariants

- tenant identity comes from authentication, never caller-supplied resource data;
- cross-tenant resources read as not found;
- non-loopback exposure fails closed without strong authentication;
- input references and provider destinations are allowlisted and bounded;
- all external mutations have durable receipts and stable idempotency keys;
- secrets never enter model context, events, logs, evidence, or artifacts; and
- runtime event history remains reconstructable after process loss.

## Implementation order

This is the authoritative runtime engineering order. The integration sequence in
[the product-boundary document](./KERTAS-PRODUCT-BOUNDARY.md#integration-sequence)
describes the later operational flow after the required runtime capabilities
exist; it is not a competing implementation roadmap.

1. Publish machine-readable schemas for the existing Run API and events.
2. Add contract fixtures and backwards-compatibility tests.
3. Introduce ManagedSession storage and one-active-Run admission.
4. Add idempotent inbound session events and ordered queueing.
5. Introduce first-class runtime artifacts and bounded child results.
6. Add Kertas client SDK conformance against an independently deployed runtime.

## Acceptance boundary

The `v1alpha1` contract is implementable only when:

- no Kertas package imports runtime storage/internal modules;
- a fresh client can discover and validate supported schemas;
- duplicate commands/events produce one logical effect;
- events reconstruct current state despite repeated/out-of-order delivery;
- crash and retry tests preserve session/Run/Attempt lineage;
- artifacts and workspace transfers verify content digests; and
- at least one Kertas integration test uses only the public interface.
