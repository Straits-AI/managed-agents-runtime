# Decision Memo: BytePlus-Native Durable Managed Agents Platform

**Date:** 16 July 2026
**Status:** Architecture and product-direction recommendation
**Working product description:** A durable, serverless execution layer for BytePlus AgentKit agents

---

## 1. Executive Summary

BytePlus AgentKit provides many of the capabilities required to build sophisticated enterprise agents, including:

* managed agent application runtimes;
* reusable Skills and Skills Spaces;
* MCP services, gateways, and toolsets;
* short-term sessions;
* long-term memory;
* knowledge bases;
* identity and credential management;
* A2A agent registration;
* sandbox tools;
* observability and lifecycle operations.

BytePlus infrastructure further provides:

* ModelArk and model endpoints;
* veFaaS serverless compute;
* asynchronous task execution;
* Cloud Sandbox instances;
* autoscaling and event triggers;
* PostgreSQL, Kafka, RocketMQ, TOS, FileNAS, IAM, and KMS.

AgentKit is therefore a strong **agent capability platform**, while BytePlus infrastructure supplies a credible **serverless execution substrate**. AgentKit is explicitly positioned as a platform for building, deploying, and operating AI agents, and its current resource catalogue includes runtimes, sessions, memory, knowledge, Skills, MCP, identity, and observability.

However, BytePlus does not currently expose a clearly documented equivalent to the central abstraction offered by Claude Managed Agents:

> A durable, session-oriented managed agent process that can run for a long period, survive infrastructure replacement, suspend while waiting, resume safely, and retain an authoritative execution history.

Claude Managed Agents provides a pre-built managed harness for long-running and asynchronous work. A session references a versioned agent and an environment, maintains conversation history, and receives an isolated sandbox when provisioned.

The recommended product is therefore:

> **A durable Managed Agents runtime built around BytePlus AgentKit and BytePlus infrastructure.**

The product should use AgentKit as its default capability plane, but it must own the durable process model itself.

The final strategic decision is:

> **Launch BytePlus-native and AgentKit-centered, while keeping the durable kernel, public API, and customer execution state portable and owned by us.**

This avoids two bad extremes:

1. Building a fully generic multi-cloud platform before product-market fit.
2. Hard-coding the product so deeply into AgentKit that the core runtime has no independent value.

---

## 2. The Problem

Enterprise agents are evolving beyond ordinary request-response chat applications.

A modern agent may:

* work continuously for minutes or hours;
* execute code;
* use browsers and external systems;
* create and modify files;
* delegate work to subagents;
* wait for human approval;
* suspend until an external event occurs;
* recover from model, worker, or sandbox failures;
* maintain knowledge and memory across sessions;
* operate under strict permissions and budgets;
* produce auditable artifacts and side effects.

A conventional agent application usually runs as:

```text
Request
   ↓
Application container
   ↓
Model and tool loop
   ↓
Response
```

This is insufficient for long-running autonomous execution.

If the container dies, several questions arise:

* What work was already completed?
* Which model or tool call was last committed?
* Was an external action executed?
* Can the task safely resume?
* Was a payment, email, deployment, or pull request already created?
* Which workspace files are authoritative?
* Which skills and tools were used?
* Which permissions remain valid?
* What should happen to active subagents?

The product must therefore treat an agent as a durable process rather than as a transient API request.

---

## 3. Market Context

The broader durable managed-agent category already exists.

Anthropic’s Claude Managed Agents offers a configurable harness running on managed infrastructure for long-running and asynchronous work. Sessions are explicit resources, agents are versioned, and each cloud session gets an isolated Linux sandbox.

AWS AgentCore Runtime similarly provides isolated per-session execution. Each user session receives a dedicated microVM with isolated CPU, memory, and filesystem resources, and the microVM is destroyed after session termination.

Consequently, “durable managed agents” is not itself a unique global product category.

The credible wedge is narrower:

> **BytePlus currently has the agent capabilities and serverless infrastructure, but does not publicly expose a complete durable Managed Agents abstraction that unifies them.**

The opportunity is therefore not to claim invention of durable agents. The opportunity is to provide the missing product layer in the BytePlus ecosystem.

---

## 4. Product Thesis

The proposed platform virtualizes the lifecycle of an autonomous agent process.

The agent process must remain logically alive even when:

* no worker is running;
* its sandbox has been released;
* the task is waiting for approval;
* a worker crashes;
* the system is redeployed;
* the workload moves to another compute instance;
* the process is sleeping until a timer or event;
* one execution attempt fails and another takes over.

The product thesis is:

> **An agent process is a durable identity and event history whose execution may move across replaceable models, harness workers, and sandboxes.**

This is analogous to how virtual machines separate a logical machine from physical hardware, or how durable workflow engines separate workflow state from worker processes.

The runtime virtualizes more than compute. It virtualizes:

* model access;
* agent harness;
* execution environment;
* tool access;
* memory and knowledge;
* credentials;
* context;
* workspace;
* process hierarchy;
* approvals;
* budget;
* recovery state.

---

## 5. Final Product Positioning

The recommended external positioning is:

> **Managed Agents for BytePlus AgentKit**

A fuller description is:

> **A durable, serverless execution platform that turns BytePlus AgentKit agents into long-running, resumable, policy-controlled agent processes with isolated sandboxes, persistent workspaces, approvals, recovery, and complete execution histories.**

It should not be positioned as:

* another generic agent framework;
* another MCP gateway;
* another memory system;
* another OpenClaw hosting product;
* another persistent ECS agent appliance;
* a replacement for AgentKit.

The product completes AgentKit rather than replacing it.

```text
AgentKit
= capabilities available to agents

Our Managed Agents runtime
= durable lifecycle and safe execution of agents

Combined platform
= enterprise-grade managed autonomous agents
```

---

## 6. Strategic Platform Decision

### 6.1 Recommended approach

The product should be:

* **BytePlus-native in deployment;**
* **AgentKit-centered in capability integration;**
* **provider-neutral in its durable process model;**
* **portable at carefully designed architectural seams.**

### 6.2 Why not fully platform-agnostic in V1

Supporting multiple clouds from the beginning would require normalizing:

* function execution;
* sandbox lifecycle;
* model APIs;
* streaming;
* storage;
* queues;
* networking;
* secrets;
* identity;
* memory semantics;
* skill packaging;
* tool discovery;
* observability;
* billing;
* quotas;
* regional behaviour.

These are not superficial API differences. They have different reliability, lifecycle, security, and consistency semantics.

A multi-cloud V1 would consume engineering effort in compatibility work rather than addressing the central product risk: whether the runtime can reliably execute and recover long-horizon agent tasks.

### 6.3 Why not tightly couple everything to BytePlus

Hard coupling creates several risks:

* BytePlus may eventually launch the missing feature itself.
* AgentKit APIs and resource models may evolve.
* Some AgentKit functionality remains under beta billing documentation.
* Customers may require private deployment or additional regions.
* The runtime could lose value outside a BytePlus partnership.

AgentKit’s documentation currently includes a broad and actively evolving platform surface, including runtimes, monitoring, identity, memory, MCP, Skills, and beta billing references.

The durable kernel must therefore use our own canonical resources, state model, and external API.

---

## 7. Product Architecture

The platform should contain four major planes.

```text
                    Managed Agents API
             SDK / CLI / Console / Webhooks
                           │
                           ▼
┌──────────────────────────────────────────────────────┐
│                 Agent Control Plane                  │
│                                                      │
│ Agent Registry        Run Service                    │
│ Scheduler             Resource Resolver              │
│ Approval Service      Capability Policy Engine       │
│ Budget Controller     Evaluation Service             │
│ Timer/Signal Service  Subagent Coordinator           │
└──────────────────────────┬───────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────┐
│                 Durable State Plane                  │
│                                                      │
│ Run Ledger            Append-Only Events             │
│ Attempts and Leases   Checkpoints                    │
│ Workspace Revisions   Tool Receipts                  │
│ Progress Ledgers      Artifact Provenance            │
│ Capability Grants     Approval History               │
└──────────────────────────┬───────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────┐
│                   Execution Plane                    │
│                                                      │
│ Harness Workers       Context Compiler               │
│ Sandbox Controller    Model Gateway                  │
│ Tool Gateway          Credential Broker              │
│ Verifier              Recovery Controller            │
│ Subagent Workers      Workspace Manager              │
└──────────────────────────┬───────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────┐
│            AgentKit and BytePlus Services            │
│                                                      │
│ AgentKit Skills       AgentKit MCP                    │
│ AgentKit Memory       AgentKit Knowledge              │
│ AgentKit Sessions     AgentKit Identity               │
│ AgentKit A2A          AgentKit Observability          │
│ ModelArk              veFaaS                          │
│ Cloud Sandbox         RDS / Kafka / TOS / KMS         │
└──────────────────────────────────────────────────────┘
```

---

## 8. Core Resource Model

The word “session” is overloaded and should not be the central internal abstraction.

The platform should explicitly separate the following resources.

### 8.1 Agent definition

A mutable logical agent identity.

```text
AgentDefinition
├── name
├── description
├── ownership
├── default policies
├── supported workloads
└── version history
```

### 8.2 Agent version

An immutable execution configuration.

```text
AgentVersion
├── instructions
├── harness version
├── model policy
├── skill references
├── MCP toolset references
├── memory configuration
├── knowledge configuration
├── sandbox image
├── context strategy
├── verifier policy
└── capability requirements
```

Immutability is required for auditability and replay. A run must not silently receive a different prompt, skill, toolset, or policy after resuming.

### 8.3 Conversation session

A continuing interaction between a user and one or more agents.

It may contain many runs.

```text
ConversationSession
├── participants
├── conversation history
├── current active runs
└── AgentKit Session reference
```

AgentKit Sessions are suitable for short-term conversational context. BytePlus describes Sessions as short-term memory that maintains persistent session connections and manages context.

### 8.4 Run

The central durable process.

```text
Run
├── run ID
├── goal
├── agent version
├── status
├── execution plan
├── event sequence
├── progress state
├── active attempt
├── workspace revision
├── pending approvals
├── child runs
├── capabilities
├── budgets
└── deadlines
```

### 8.5 Run attempt

One execution epoch assigned to a worker.

```text
RunAttempt
├── attempt ID
├── worker lease
├── sandbox ID
├── start time
├── heartbeat
├── checkpoint
├── exit reason
└── resource consumption
```

A run may contain multiple attempts:

```text
Run R-1842
├── Attempt 1 — worker crashed
├── Attempt 2 — sandbox expired
├── Attempt 3 — suspended for approval
└── Attempt 4 — completed
```

### 8.6 Workspace

The durable logical filesystem of a run.

It is independent of any specific sandbox.

### 8.7 Checkpoint

A recoverable execution state including:

* workspace revision;
* progress ledger;
* context summary;
* active plan;
* unresolved commitments;
* child-run states;
* pending external actions;
* model and tool history pointers.

---

## 9. AgentKit’s Role

AgentKit should be a first-class dependency in V1, but it should not own the durable process.

AgentKit’s documented platform includes:

* managed runtimes and runtime versions;
* sandbox tools and tool instances;
* Sessions;
* Memory;
* knowledge bases;
* Skills;
* MCP services and toolsets;
* identity and permission management;
* observability;
* A2A capabilities.

### 9.1 Skills

AgentKit defines Skills as reusable, modular, filesystem-based capability units. Skills may combine knowledge, processes, scripts, and related resources, and may be published into Skills Spaces.

Skills should represent procedural knowledge:

* how to analyse a repository;
* how to prepare a board memo;
* how to operate a business system;
* how to perform code review;
* how to deploy an application;
* how to conduct a compliance check.

Each run should pin exact Skill versions.

```yaml
skills:
  - provider: agentkit
    skill_space: engineering-production
    skill: repository-analysis
    version: 4.2.0
```

A running process must not resolve `latest` after suspension because behaviour could change between attempts.

### 9.2 MCP services and toolsets

AgentKit’s MCP layer acts as a gateway between agents and external tools, APIs, and systems. It supports MCP services, toolsets, semantic retrieval, tag retrieval, and tool-management APIs.

AgentKit MCP should be used as the default integration registry and gateway.

However, the model should not directly invoke unrestricted MCP tools. Calls should flow through our policy and durability layer:

```text
Model proposes semantic action
          ↓
Capability policy evaluation
          ↓
Approval evaluation
          ↓
Tool implementation resolution
          ↓
Credential brokering
          ↓
AgentKit MCP invocation
          ↓
Durable tool receipt
```

MCP supplies integration. It does not supply complete authorization, side-effect correctness, or run durability.

### 9.3 Long-term memory

AgentKit Memory should store semantic and episodic information across runs:

* user preferences;
* organization conventions;
* previous project decisions;
* repository-specific practices;
* recurring business context.

It must not store authoritative execution state.

The distinction is:

```text
AgentKit Memory
= what the agent may remember

Run Ledger
= what definitively happened
```

Whether a payment, deployment, email, or database update occurred must come from an exact transactional record, not semantic retrieval.

### 9.4 Knowledge bases

AgentKit Knowledge should provide enterprise retrieval over:

* policies;
* documentation;
* contracts;
* manuals;
* research;
* product information;
* historical reports.

AgentKit exposes knowledge-base import, document and chunk inspection, retrieval, Q&A, and agent integration within its documented platform structure.

Kertas may later complement or replace parts of this layer where stronger provenance, semantic spaces, agent-native CRUD, and shared memory spaces are required.

### 9.5 Identity and credentials

AgentKit includes identity integration and outbound credential escrow capabilities, alongside IAM and permission management.

The runtime should add purpose-bound, run-level capability grants:

```text
Human
  delegates to
Primary run
  delegates to
Subrun
  requests
Capability
  releases
Scoped credential
  accesses
Resource
```

A credential should only be released after verifying:

* tenant;
* user;
* agent version;
* run;
* subrun;
* purpose;
* requested action;
* target resource;
* approval status;
* expiry and call limits.

---

## 10. BytePlus Infrastructure Mapping

BytePlus veFaaS is the main execution substrate.

Its current documentation exposes:

* task functions;
* event functions;
* web applications;
* microservice applications;
* autoscaling;
* serverless GPU;
* Kafka and RocketMQ triggers;
* timer triggers;
* asynchronous tasks;
* Cloud Sandbox instances;
* sandbox image management;
* sandbox timeout and termination APIs;
* function revisions and releases;
* TOS integration.

### Recommended mapping

| Platform component               | BytePlus implementation        |
| -------------------------------- | ------------------------------ |
| Control-plane APIs               | veFaaS web applications        |
| Scheduler workers                | veFaaS event or task functions |
| Harness execution                | veFaaS task workers            |
| Isolated active workspace        | veFaaS Cloud Sandbox           |
| Model inference                  | ModelArk/model endpoints       |
| Durable run state                | RDS PostgreSQL                 |
| Event transport                  | Kafka or RocketMQ              |
| Artifact storage                 | TOS                            |
| Shared filesystem where required | FileNAS                        |
| Secrets                          | KMS                            |
| Infrastructure authorization     | IAM                            |
| Capability services              | AgentKit                       |
| Infrastructure telemetry         | veFaaS and AgentKit monitoring |

Cloud Sandbox exposes explicit lifecycle operations such as creating, describing, listing, timing out, and terminating sandbox instances, alongside image precaching and image management.

This makes it suitable for session-oriented execution without allocating a permanent ECS host to every agent.

---

## 11. Durable Execution Model

The run should be event-sourced.

An example event sequence:

```text
0001 RunCreated
0002 AgentVersionResolved
0003 CapabilitiesResolved
0004 ExecutionPlanCreated
0005 RunQueued
0006 AttemptStarted
0007 SandboxAllocated
0008 WorkspaceRestored
0009 ContextCompiled
0010 ModelInvocationStarted
0011 ModelInvocationCompleted
0012 ActionProposed
0013 ActionAuthorized
0014 ToolInvocationStarted
0015 ToolInvocationCommitted
0016 ProgressUpdated
0017 WorkspaceCheckpointed
0018 ApprovalRequested
0019 AttemptSuspended
0020 ApprovalReceived
0021 AttemptStarted
...
0046 VerificationStarted
0047 VerificationPassed
0048 RunCompleted
```

The event log must be:

* append-only;
* durably ordered;
* tenant-isolated;
* idempotent;
* replayable;
* queryable;
* auditable.

PostgreSQL should initially remain the authoritative ledger.

Kafka or RocketMQ should distribute events but should not be the sole authoritative state store. A transactional outbox pattern should be used:

```text
PostgreSQL transaction
├── write run transition
└── append outbox event
           ↓
      event publisher
           ↓
     Kafka/RocketMQ
```

This prevents state transitions from being lost when a database update succeeds but queue publication fails.

---

## 12. Run State Machine

```text
CREATED
   ↓
RESOLVING
   ↓
QUEUED
   ↓
STARTING
   ↓
RUNNING
   ├── WAITING_APPROVAL
   ├── WAITING_SIGNAL
   ├── WAITING_CHILDREN
   ├── SLEEPING
   ├── SUSPENDED
   ├── RETRY_PENDING
   └── VERIFYING
          ↓
   ┌──────┼────────┐
COMPLETED FAILED CANCELLED
```

Waiting states should not require active harness compute.

Depending on expected wait duration:

* retain the sandbox briefly;
* checkpoint and terminate the sandbox;
* preserve only workspace deltas;
* reconstruct the sandbox when the run resumes.

---

## 13. Execution Epochs

A long-running agent should not depend on one uninterrupted serverless invocation.

Instead, it should operate through execution epochs:

```text
Run lasting 12 hours

Epoch 1 — inspect inputs
Checkpoint

Epoch 2 — conduct research
Checkpoint

Epoch 3 — wait for approval
No active worker

Epoch 4 — perform approved operation
Checkpoint

Epoch 5 — verify and produce artifact
Complete
```

This architecture provides:

* worker replacement;
* controlled resource consumption;
* safe deployment updates;
* reduced idle cost;
* improved recovery;
* opportunities to reevaluate policy and budget;
* migration between worker instances.

BytePlus’s asynchronous task mode is explicitly intended for long-running and compute-intensive workloads, and its API surface includes asynchronous-task listing and termination.

Our runtime must nevertheless own task continuity beyond individual veFaaS execution records.

---

## 14. Recovery Architecture

Workers acquire time-limited execution leases.

```text
Worker claims run
     ↓
Lease recorded
     ↓
Worker heartbeats
     ↓
Worker crashes
     ↓
Lease expires
     ↓
Scheduler detects orphaned attempt
     ↓
New attempt created
     ↓
New worker restores checkpoint
     ↓
Execution continues
```

Recovery should use:

* durable events from PostgreSQL;
* workspace checkpoint from TOS;
* current AgentVersion;
* pinned AgentKit dependencies;
* progress ledger;
* unresolved commitments;
* tool receipts;
* pending approvals;
* child-run states.

The new worker should never reconstruct state solely by asking the model to infer what happened.

---

## 15. Workspace Architecture

The active sandbox filesystem must not be authoritative.

Recommended structure:

```text
Workspace
├── Base revision
├── Copy-on-write overlay
├── Generated artifacts
├── Tool receipts
├── Command logs
├── Checkpoints
└── Revision metadata
```

The logical workspace is reconstructed from:

```text
Immutable base
+ ordered workspace deltas
+ latest committed checkpoint
```

Storage mapping:

* Cloud Sandbox local disk: active working set;
* TOS: durable snapshots, deltas, and artifacts;
* FileNAS: optional live shared files where required;
* PostgreSQL: workspace metadata and revision graph.

### Multi-agent workspace isolation

Subagents should receive separate copy-on-write overlays.

```text
Parent workspace W10
├── Research subrun overlay W11
├── Backend subrun overlay W12
└── Frontend subrun overlay W13
```

The parent process merges accepted outputs into a new workspace revision.

This reduces unintended interference and enables deterministic provenance.

---

## 16. Harness Architecture

The harness should be modular rather than one monolithic loop.

```text
Agent Harness
├── Goal Interpreter
├── Context Compiler
├── Planner/Controller
├── Action Interface
├── Tool Router
├── Progress Ledger
├── Delegation Manager
├── Context Compactor
├── Budget Controller
├── Verifier
├── Recovery Controller
└── Completion Detector
```

### 16.1 Context compiler

The model should not receive the complete event history.

The context compiler assembles:

* current goal;
* active plan;
* progress ledger;
* recent observations;
* pinned evidence;
* relevant workspace files;
* retrieved knowledge;
* retrieved memory;
* pending commitments;
* capabilities;
* remaining budget;
* deadline.

Context operations should include:

* retrieve;
* pin;
* expand;
* compress;
* refresh;
* evict;
* delegate.

### 16.2 Progress ledger

Progress should exist as explicit structured state:

```json
{
  "objective": "Implement the authentication migration",
  "completed": [
    "Mapped the current authentication flow",
    "Created migration schema"
  ],
  "active": [
    "Updating API middleware"
  ],
  "blocked": [
    {
      "item": "Production OAuth secret",
      "reason": "Requires approval"
    }
  ],
  "remaining": [
    "Update frontend",
    "Run integration tests",
    "Prepare migration report"
  ]
}
```

This state survives context compaction, model changes, and worker replacement.

### 16.3 Verifier

Completion should be independently assessed.

```text
Agent claims completion
          ↓
Verifier checks
├── acceptance criteria
├── required artifacts
├── tests and validations
├── unresolved errors
├── evidence coverage
├── policy violations
└── budget compliance
          ↓
Complete / Continue / Escalate
```

The verifier may be:

* deterministic;
* model-based;
* tool-based;
* human-assisted;
* domain-specific.

---

## 17. Semantic Action Layer

The runtime should not expose raw tools as the primary internal abstraction.

The harness should propose semantic actions:

```json
{
  "action": "repository.pull_request.create",
  "resource": "github://company/project",
  "arguments": {
    "branch": "agent/auth-migration",
    "draft": true
  },
  "risk": "external_write"
}
```

The platform then resolves the implementation:

```text
Semantic action
       ↓
Capability policy
       ↓
Approval policy
       ↓
Tool resolver
├── AgentKit MCP
├── native SDK
├── CLI
├── REST API
└── browser automation
```

This creates several advantages:

* MCP implementations can be replaced.
* A CLI can be used where it is more token-efficient.
* Authorization remains consistent across tools.
* Tool implementations can evolve without rewriting skills.
* Auditing records semantic intent, not merely low-level calls.

---

## 18. Side-Effect Correctness

Exactly-once execution cannot generally be guaranteed across arbitrary external systems.

The platform should provide:

* at-least-once delivery;
* idempotency keys;
* durable action receipts;
* external transaction identifiers;
* prepare/approve/commit flows;
* post-action verification.

Each external action should create a `ToolReceipt`:

```text
ToolReceipt
├── invocation ID
├── semantic action
├── request digest
├── idempotency key
├── authorization decision
├── approval reference
├── start time
├── result status
├── external transaction ID
├── result digest
└── reversibility classification
```

After a crash, the runtime checks the receipt or external provider before retrying.

Irreversible actions should use:

```text
Propose
   ↓
Authorize
   ↓
Approve where required
   ↓
Commit
   ↓
Verify
   ↓
Record receipt
```

---

## 19. Security Model

The platform should implement capability-based authorization.

A run should not receive broad ambient credentials.

A capability grant should specify:

```json
{
  "principal": "run:R-1842/subrun:S-3",
  "action": "repository.read",
  "resource": "github://company/project",
  "purpose": "review authentication implementation",
  "expires_at": "2026-07-16T18:00:00+08:00",
  "max_calls": 100
}
```

Subagents must receive no more authority than their parent and should usually receive significantly less.

Security layers:

1. Human and tenant identity.
2. Agent identity.
3. Run and subrun identity.
4. Capability authorization.
5. Credential brokering.
6. Network policy.
7. Sandbox isolation.
8. Tool-level restrictions.
9. Approval policy.
10. Audit trail.

Secrets must not be inserted into model context unless strictly necessary. They should be injected into the execution environment or transmitted directly to the tool adapter.

---

## 20. External API

The public API should be ours.

```http
POST /v1/agents
POST /v1/agents/{agent_id}/versions

POST /v1/runs
GET  /v1/runs/{run_id}
GET  /v1/runs/{run_id}/events

POST /v1/runs/{run_id}/messages
POST /v1/runs/{run_id}/signals
POST /v1/runs/{run_id}/approvals/{approval_id}
POST /v1/runs/{run_id}/cancel
POST /v1/runs/{run_id}/fork

GET  /v1/runs/{run_id}/artifacts
GET  /v1/runs/{run_id}/children
GET  /v1/runs/{run_id}/usage
```

Customers should not need to directly orchestrate:

* AgentKit runtime instances;
* veFaaS functions;
* sandbox APIs;
* AgentKit Memory calls;
* MCP service calls;
* TOS checkpoints.

Provider references may appear in configuration, but the run lifecycle remains stable.

---

## 21. Provider Abstraction Strategy

V1 should have only one officially supported production stack: BytePlus.

Nevertheless, internal interfaces should separate the kernel from providers.

```rust
trait SkillProvider {
    async fn resolve(&self, reference: SkillRef)
        -> Result<ResolvedSkill>;
}

trait MemoryProvider {
    async fn search(&self, query: MemoryQuery)
        -> Result<Vec<MemoryRecord>>;

    async fn write(&self, entries: Vec<MemoryEntry>)
        -> Result<MemoryWriteReceipt>;
}

trait KnowledgeProvider {
    async fn retrieve(&self, query: KnowledgeQuery)
        -> Result<Vec<Evidence>>;
}

trait ToolProvider {
    async fn resolve(&self, action: SemanticAction)
        -> Result<ToolBinding>;
}

trait SandboxProvider {
    async fn create(&self, request: SandboxRequest)
        -> Result<SandboxHandle>;

    async fn terminate(&self, handle: SandboxHandle)
        -> Result<()>;
}
```

Initial implementations:

```text
SkillProvider       → AgentKit Skills
MemoryProvider      → AgentKit Memory
KnowledgeProvider   → AgentKit Knowledge
ToolProvider        → AgentKit MCP
IdentityProvider    → AgentKit Identity
ModelProvider       → ModelArk
ComputeProvider     → veFaaS
SandboxProvider     → veFaaS Cloud Sandbox
ObjectProvider      → TOS
SecretProvider      → KMS
```

Portability should mean:

* our core schemas are provider-neutral;
* customer run history remains exportable;
* the workspace can be exported;
* the provider can be replaced without rewriting the kernel;
* private deployment can be added later.

It should not mean that every in-progress run can move between clouds transparently in V1.

---

## 22. V1 Scope

### 22.1 Build ourselves

* Agent registry.
* Immutable AgentVersion model.
* Run and RunAttempt resources.
* Append-only RunEvent ledger.
* Lease-based scheduler.
* Execution-plan resolver.
* Harness worker.
* Context compiler.
* Progress ledger.
* Checkpoint and recovery service.
* Workspace revision manager.
* Approval API.
* Capability policy engine.
* Tool receipts.
* Artifact service.
* Basic verifier.
* Run-level observability.

### 22.2 Use from AgentKit

* Skills and Skills Spaces.
* MCP gateway and toolsets.
* Memory.
* Knowledge bases.
* Sessions where conversational context is needed.
* Identity and credential escrow.
* A2A where independently deployed agents must interoperate.
* Existing monitoring where useful.

### 22.3 Use from BytePlus infrastructure

* ModelArk.
* veFaaS.
* Cloud Sandbox.
* RDS PostgreSQL.
* Kafka or RocketMQ.
* TOS.
* FileNAS where necessary.
* KMS.
* IAM and VPC networking.

### 22.4 Exclude from V1

* generic visual workflow builder;
* custom distributed database;
* multi-cloud production support;
* arbitrary Kubernetes orchestration;
* universal agent framework compatibility;
* unrestricted agent swarms;
* reinforcement-learning scheduler;
* live cross-cloud run migration;
* complete replacement for AgentKit Memory or Knowledge;
* broad marketplace of third-party skills.

---

## 23. Initial Workload Focus

The first runtime should support one or two workloads that expose the full durability problem.

Recommended candidates:

### Coding and repository agents

They require:

* filesystem state;
* shell commands;
* long-running execution;
* tests;
* external repository actions;
* approvals;
* resumable work;
* artifact verification.

### Enterprise research agents

They require:

* large source collections;
* browser and retrieval tools;
* evidence tracking;
* context compaction;
* multiple subagents;
* long-duration work;
* report artifacts;
* citation verification.

Coding agents are likely the better first technical benchmark because correctness can be evaluated through repository diffs, test results, and build outcomes.

---

## 24. Core Validation Benchmark

The first decisive benchmark should not be a generic model-quality test.

It should be:

> Can one run survive worker death, sandbox loss, platform redeployment, context compaction, and a long approval wait without losing progress or repeating an irreversible action?

Test scenario:

1. Start a repository task.
2. Execute several model and tool steps.
3. Commit a workspace checkpoint.
4. Kill the harness worker.
5. Recover on a new worker.
6. Kill the sandbox.
7. Reconstruct it from durable workspace state.
8. Request approval for an external write.
9. Suspend the run for one hour.
10. Resume after approval.
11. Perform the action once.
12. Kill the worker immediately after the external action.
13. Recover without duplicating the action.
14. Verify the output.
15. Complete with a full event and artifact history.

Passing this benchmark demonstrates the actual value of the runtime.

---

## 25. Roadmap

### Phase 0: Technical validation

* Confirm Cloud Sandbox limits and lifecycle.
* Confirm region availability.
* Benchmark startup latency.
* Test custom images.
* Test TOS workspace restoration.
* Test AgentKit Skill and MCP integration.
* Confirm identity and credential flows.
* Confirm private networking between required services.

### Phase 1: Durable single-agent runtime

* AgentVersion.
* Run.
* RunAttempt.
* RunEvent.
* scheduler and leases;
* sandbox controller;
* checkpoint and recovery;
* AgentKit Skills and MCP;
* approval API;
* artifact output;
* basic verifier.

### Phase 2: Enterprise capability integration

* AgentKit Memory.
* AgentKit Knowledge.
* identity and credential escrow;
* policy packs;
* tenant quotas;
* cost attribution;
* enhanced observability;
* scheduled runs and signals.

### Phase 3: Managed subagents

* child-run hierarchy;
* isolated contexts;
* copy-on-write workspaces;
* delegation policies;
* parallel execution;
* parent-child budget allocation;
* merge and verification.

### Phase 4: Private deployment and portability

* Kubernetes/private-cloud execution adapter;
* S3-compatible storage;
* self-hosted MCP;
* Git/OCI Skill provider;
* external model providers;
* enterprise identity providers;
* exportable run bundles.

### Phase 5: Semantic agent operations

* loop detection;
* stagnation detection;
* context-loss detection;
* adaptive model routing;
* subagent replacement;
* semantic recovery;
* automatic escalation;
* budget-aware execution planning.

---

## 26. Commercial Strategy

### Phase 1 positioning

> Managed Agents for BytePlus AgentKit

Primary buyers:

* enterprises already evaluating AgentKit;
* BytePlus regional customers;
* organizations requiring serverless autonomous agents;
* system integrators building agent applications;
* customers needing long-running coding, research, or operations agents.

### Partnership proposition to BytePlus

The platform:

* increases consumption of AgentKit resources;
* increases ModelArk usage;
* increases veFaaS and Cloud Sandbox usage;
* provides an answer to Claude Managed Agents and AWS AgentCore;
* fills an execution-layer gap without replacing AgentKit;
* creates a stronger enterprise story for AgentKit;
* supplies a reference architecture for long-running autonomous agents.

The ideal route is to become:

* a BytePlus technology partner;
* a co-development partner;
* an AgentKit managed-runtime solution;
* a reference implementation;
* or eventually an acquired/embedded platform component.

---

## 27. Risks

### 27.1 BytePlus builds the same product

This is the largest strategic risk.

Mitigation:

* own the durable kernel;
* own the public API;
* own customer run history;
* build portability seams;
* move faster on enterprise policy and semantic operations;
* pursue partnership rather than compete silently.

### 27.2 Cloud Sandbox does not meet security requirements

BytePlus documents sandbox lifecycle APIs, but isolation strength, snapshot semantics, and enterprise security guarantees must be validated directly.

Mitigation:

* obtain written architecture details;
* benchmark isolation;
* support hardened customer-owned sandbox backends later;
* separate trusted and untrusted execution tiers.

### 27.3 Serverless limits constrain long-running agents

Mitigation:

* use execution epochs;
* externalize all authoritative state;
* checkpoint frequently;
* make workers replaceable;
* suspend when idle.

### 27.4 AgentKit APIs evolve

Mitigation:

* provider adapters;
* contract tests;
* version pinning;
* no AgentKit IDs as primary internal IDs;
* exportable run state.

### 27.5 Tool side effects are duplicated

Mitigation:

* semantic actions;
* idempotency keys;
* durable receipts;
* provider reconciliation;
* approval and commit protocols.

### 27.6 Product becomes infrastructure without customer value

Mitigation:

* begin with one high-value agent workload;
* expose outcome-oriented APIs;
* include managed harnesses;
* demonstrate completion and recovery, not merely orchestration;
* sell reliability, governance, and long-duration execution.

---

## 28. Questions Requiring Direct Confirmation from BytePlus

Before final implementation commitment, obtain answers for:

1. Maximum Cloud Sandbox lifetime.
2. Sandbox cold-start latency at p50, p95, and p99.
3. Warm-pool pricing and capacity.
4. Supported CPU, memory, disk, and concurrency configurations.
5. Container, microVM, or other isolation boundary.
6. Filesystem persistence and snapshot support.
7. VPC and private endpoint support.
8. Per-sandbox network egress controls.
9. Availability of AgentKit, veFaaS, Cloud Sandbox, RDS, TOS, and queues in the same target region.
10. Multi-AZ and disaster-recovery guarantees.
11. Quotas for active sandbox instances.
12. Asynchronous execution limits.
13. ModelArk streaming and cancellation behaviour.
14. AgentKit Skill and MCP versioning guarantees.
15. AgentKit Memory indexing and consistency behaviour.
16. Credential escrow and short-lived token support.
17. Service-level agreements for AgentKit and Cloud Sandbox.
18. Roadmap for first-party durable runs or managed harnesses.

---

## 29. Final Decision

The platform should be built around BytePlus AgentKit.

AgentKit should provide the default:

* Skills;
* MCP;
* Memory;
* Knowledge;
* Sessions;
* identity;
* credentials;
* A2A;
* agent-oriented monitoring.

BytePlus infrastructure should provide the default:

* models;
* serverless workers;
* sandboxes;
* databases;
* event transport;
* object storage;
* secrets;
* networking.

Our product should provide:

* durable agent identity;
* immutable agent versions;
* long-running runs;
* attempts and leases;
* event histories;
* checkpoint and recovery;
* workspace durability;
* approval handling;
* capability authorization;
* tool receipts;
* budgets;
* subagent lifecycle;
* completion verification;
* artifact provenance.

The final architecture is therefore:

```text
AgentKit-centered capability plane
                 +
BytePlus-native execution infrastructure
                 +
Our durable agent process kernel
                 =
BytePlus Managed Agents platform
```

The commercial product should be BytePlus-native at launch.

The durable process model, public API, and customer state should remain owned by us and structurally portable.

The concise decision is:

> **Build a durable serverless Managed Agents layer around AgentKit, not inside AgentKit and not independently from it. Launch on BytePlus only, but preserve ownership of the runtime kernel and customer execution state from the first implementation.**

