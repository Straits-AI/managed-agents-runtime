# Kertas product boundary

**Status:** adopted architecture boundary  
**Applies from:** controlled-alpha runtime `0.1.x`  
**Last reviewed:** 2026-07-19

## Decision

This repository remains the separately deployable **Kertas Managed Execution
Kernel**. It is not the Kertas product repository.

Kertas is the project and product plane. This runtime is the durable execution
plane that Kertas and other clients may call through a versioned public API and
event protocol.

```text
Kertas
  Project · Project Workspace · Knowledge · Outcome · Release
  Deployment · Routine · Connector · CLI · Skill · Studio
                              │
                    public API / events
                              │
Managed Agents Runtime
  ManagedSession · Run · Attempt · Runtime Workspace
  checkpoint · approval · receipt · event · usage
                              │
                       provider adapters
                              │
  BytePlus · local/private · future provider implementations
```

The repositories may become packages in a larger monorepo later, but the module,
ownership, storage, and protocol boundaries in this document must remain intact.

## Why the boundary exists

The two systems optimize for different truths.

Kertas must preserve user intent and product history across agents, models,
workspaces, deployments, and operational routines. The runtime must preserve
execution correctness across worker death, retries, sandbox loss, approval waits,
and uncertain external side effects.

Coupling them through internal tables would make:

- Kertas depend on runtime migrations and state-machine implementation details;
- the runtime mistake a provider namespace or agent conversation for a Project;
- provider replacement and private deployment materially harder;
- retries or recovery mutate product truth accidentally; and
- independent testing and release of the execution boundary impossible.

The integration rule is therefore:

> Kertas references runtime resources by stable public identifiers and consumes
> versioned events. It never imports runtime database tables or internal modules.

## Ownership

| Concept | Owner | Boundary |
| --- | --- | --- |
| Project, objective, requirements, decisions | Kertas | Durable user/product truth |
| Project Knowledge and source provenance | Kertas | Context is selected and supplied to a session/run |
| Project Workspace | Kertas | Long-lived interactive build environment |
| ManagedSession | Runtime | Durable agent continuity addressed by future events |
| Run | Runtime | One bounded execution episode within a session |
| Attempt | Runtime | One leased execution of a Run; replaceable and fenced |
| Runtime Workspace | Runtime | Checkpointed execution state; not the Project Workspace |
| Agent Plan and subagent decomposition | Selected harness | Runtime child Runs are an optional implementation |
| Runtime events, waits, approvals, receipts | Runtime | Execution truth and governed side effects |
| Outcome Contract and evidence decision | Kertas | May consume runtime verifier evidence |
| Runtime artifact | Runtime | Content-addressed execution output and lineage source |
| Immutable Release | Kertas | Verified product/automation version promoted from outputs |
| Routine and trigger subscription | Kertas | Release-pinned operational automation |
| Deployment and rollback | Kertas | May invoke runtime/container/component providers |
| Provider infrastructure | Adapter/provider | BytePlus is one provider, not the runtime identity |

## Resource hierarchy

The canonical relationship is:

```text
Kertas Project
  └─ references zero or more runtime ManagedSessions
       └─ contains zero or more Runs
            └─ executes through zero or more Attempts
```

For the first session contract, a ManagedSession permits at most one active
top-level Run. Child Runs created by that Run are members of the same session and
may execute concurrently. New events are deduplicated and queued while the
top-level Run is active. A later protocol version may add explicit parallel
top-level lanes; concurrency must never be inferred from implementation accidents.

The current API exposes `Run` as its top-level durable object. Until the
ManagedSession resource is implemented, Kertas may use a one-session/one-Run
compatibility mapping. That mapping is transitional and must not be promoted as
the final product model.

See [Kertas ↔ runtime contract](./KERTAS-RUNTIME-CONTRACT.md).

## Workspace distinction

The runtime workspace is execution state:

- scoped to a runtime lineage;
- restored across Attempts;
- checkpointed for recovery;
- bounded by runtime policy; and
- suitable for detached agent execution.

The Kertas Project Workspace is an interactive development environment:

- prepared TypeScript/Python profiles;
- warm processes and dependency caches;
- preview URLs and reusable browser sessions;
- patch synchronization, diagnostics, tests, snapshots, and clones; and
- explicit promotion into a verified Release.

Transfer between the two requires an explicit snapshot/import operation with
content hashes and provenance. They are never two names for the same mutable
directory.

## What remains in this repository

This runtime owns:

- state transitions, leases, fencing, retry and recovery;
- append-only execution events and transactional outbox;
- checkpoints and runtime workspace restoration;
- bounded harness/model/tool execution;
- approval, signal, and child-run waits;
- governed mutations, idempotency, reconciliation, and receipts;
- runtime credential grants;
- tenant isolation, admission, usage, and budgets;
- runtime artifacts and execution lineage;
- provider interfaces and conformance tests; and
- exportable runtime histories.

## What must not be added here

- the Kertas Project aggregate;
- interactive Project Workspace UX or preview orchestration;
- Project Knowledge/provenance;
- Outcome Contract ownership;
- immutable Releases and application deployment;
- Routines, trigger subscriptions, or a visual workflow builder;
- broad SaaS connector product UX;
- Kertas CLI/Skill/Studio product state; or
- a mandatory proprietary agent-planning framework.

This runtime may expose primitives used by those planes. It must not own their
product semantics.

## Provider and harness policy

Pi, DeerFlow, Claude, Codex, VeADK, and future harnesses are adapters or callers.
No harness defines the Kertas data model.

BytePlus is a serious first provider for models, sandboxing, memory, knowledge,
MCP, and infrastructure. It is not an architectural identity. Public interfaces
must be tested against local/private execution and at least one materially
different provider before broad portability is claimed.

## Build-versus-integrate policy

Kertas and this runtime may rebuild a layer when measured evidence shows that an
existing component limits:

- the agent iteration loop;
- correctness or recovery;
- security or governance;
- provider portability;
- cost or operational control; or
- compounding product value.

This is not permission to reinvent commodity foundations. It is permission to
own critical interfaces and replace their implementations behind conformance
tests.

## Repository roadmap

### Runtime controlled alpha

- keep the P0 release gate green;
- close public-beta runtime risks in the risk register;
- add live provider conformance evidence;
- publish a reproducible container and migration/rollback contract; and
- version the public API, event, checkpoint, and artifact formats.

### Kertas Phase 1 in the product repository

- Project identity and product history;
- canonical CLI and agent Skill;
- attached Project Workspace;
- local plus two remote workspace providers;
- TypeScript and Python profiles;
- preview/browser/log/test feedback; and
- the first sales-operations application vertical.

### Integration sequence

1. Kertas creates or resolves a runtime ManagedSession.
2. Kertas supplies a scoped context bundle, objective, policy, and credential
   references.
3. The runtime executes Runs and emits versioned lifecycle events.
4. Kertas records runtime references, not internal runtime state.
5. Runtime artifacts and evidence are ingested into Kertas provenance.
6. Kertas evaluates the Outcome Contract and promotes an immutable Release.
7. Kertas Routines invoke released activities or wake a nonterminal
   ManagedSession later.

## Decision tests

A proposed change belongs in this repository only if all are true:

1. It is necessary to execute, suspend, recover, govern, or account for agent
   work.
2. Its correctness must survive replacement of the calling product.
3. It can be described without introducing Kertas Project/Release/Routine state.
4. It can be exposed through a versioned public contract.

If those tests fail, the change belongs in Kertas or another provider/service.
