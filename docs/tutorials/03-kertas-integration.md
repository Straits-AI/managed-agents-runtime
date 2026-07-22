# Tutorial 3: integrate Kertas through the public runtime contract

Kertas and the Managed Agents Runtime are independently deployable systems.
Kertas owns the user-facing Project lifecycle; this runtime owns durable managed
execution. Their shared seam is an authenticated, versioned HTTP and event
contract.

## Ownership mapping

```text
Kertas Project
  └─ opaque correlation reference
       └─ runtime ManagedSession
            └─ bounded Run
                 └─ disposable Attempt
```

Kertas stores the Project-to-session mapping. The runtime does not persist a
Kertas Project aggregate or infer authorization from the correlation reference.

## Discover the contract

Do not hard-code a route family before checking what the deployment advertises:

```text
GET /v1/contracts
GET /v1/contracts/kertas.runtime/v1alpha1
```

Discovery returns supported and planned contracts, schemas, compatibility
fixtures, and deprecation metadata. A planned contract is not callable. The
controlled alpha advertises the implemented `kertas.runtime/v1alpha1` session
surface and the `run-as-session/v1` compatibility surface.

## Create a ManagedSession

After creating an Agent Version through `/v1/agents`, Kertas sends:

```text
POST /v1alpha1/sessions
Authorization: Bearer <tenant credential>
Idempotency-Key: project-123-session-1
X-Request-Id: request-123
Content-Type: application/json
```

```json
{
  "agentVersionId": "av_...",
  "objective": "Maintain the claims-processing objective over time.",
  "correlationRef": "project-123",
  "start": {
    "goal": "Process the initial bounded batch.",
    "maxSteps": 40,
    "tokenBudget": 200000
  }
}
```

The idempotency key is part of the command identity. Replaying the same command
returns the original session; reusing the key with a different payload fails.

## Deliver a future event

Feedback, a trigger, or another Project event is delivered to the stable
session address:

```text
POST /v1alpha1/sessions/:id/events
```

```json
{
  "apiVersion": "kertas.runtime/v1alpha1",
  "eventId": "sheet-job-123-revision-2",
  "type": "kertas.feedback.received",
  "occurredAt": "2026-07-22T12:00:00+00:00",
  "sourceSequence": 2,
  "subject": { "type": "project", "ref": "project-123" },
  "data": { "instruction": "Revise the rejected claim summary." },
  "inputSnapshotRefs": [],
  "correlationId": "project-123"
}
```

The runtime derives source identity from authentication, deduplicates the event,
and assigns its canonical session receipt sequence. Events accepted while a Run
is active remain durably queued rather than silently replacing it.

## Observe execution

Kertas reads session resources and bounded executions through:

```text
GET /v1alpha1/sessions/:id
GET /v1alpha1/sessions/:id/events
GET /v1alpha1/sessions/:id/runs
GET /v1/runs/:id/events/stream
GET /v1/runs/:id/artifacts
```

Runtime delivery is at least once. Kertas deduplicates by event ID and fetches
current resource state before making a product decision. `RunCompleted` means
execution completed; it does not mean Kertas accepted an Outcome or created a
Release.

## Non-negotiable boundary

**Never import the runtime database**, join its internal tables, or grant Kertas
direct write access to them. Never derive tenant identity, ordering, or resource
type from opaque IDs. Use the API, declared schemas, event sequence, artifact
resources, and idempotency contract.

The full normative contract and compatibility policy are in
[KERTAS-RUNTIME-CONTRACT.md](../KERTAS-RUNTIME-CONTRACT.md).
