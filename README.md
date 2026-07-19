# Managed Agents Runtime

A durable, serverless execution kernel for long-running agents on BytePlus —
specified in [`memo.md`](./memo.md) and built out through the full roadmap
(durable kernel, Phase 2 enterprise capabilities, Phase 3 subagents, Phase 5
semantic operations, productionization, and the deferral features). An agent run
is a durable identity and event history whose execution moves across replaceable
workers and sandboxes: it survives worker death, sandbox loss, redeployment,
and long approval waits without losing progress or duplicating irreversible
actions.

> **Built with the [byteplus-cloud skill](https://github.com/Straits-AI/byteplus-cloud-skill).**
> Every BytePlus resource here — ModelArk, veFaaS Cloud Sandbox, TOS, APIG, RDS
> PostgreSQL, VikingDB/Viking Memory, Message Queue for Kafka, and KMS — was
> provisioned and verified live through that skill.

📘 **New here? Start with the [Usage Guide](./docs/GUIDE.md)** — how to run it,
drive agents through the API, multi-tenancy, credentials, streaming/Kafka, and
best practices. Cost is in [docs/COST.md](./docs/COST.md).

Architecture and release boundaries:

- [Kertas product boundary](./docs/KERTAS-PRODUCT-BOUNDARY.md)
- [Kertas ↔ runtime contract](./docs/KERTAS-RUNTIME-CONTRACT.md)
- [Engineering risk register](./docs/ENGINEERING-RISK-REGISTER.md)

> **Release status:** the automated
> [controlled multi-tenant alpha gate](./docs/CONTROLLED-ALPHA-RELEASE-GATE.md)
> passes for this source revision. It checks the full suite plus named P0
> configuration, tenancy, admission, knowledge, HTTP/MCP, credential,
> concurrency, and crash-recovery assertions, and retains commit-bound JSON
> evidence in CI. This is a controlled-alpha claim only: live provider
> conformance, the P1 register, and explicit production approval remain open.

## Architecture

```
POST /v1/runs ──▶ Fastify API ──▶ Postgres (runs, gapless run_events,
                                  attempts+leases, checkpoints, receipts,
                                  approvals, grants, outbox)
                                        ▲
 worker: claim (SKIP LOCKED) ── heartbeat/fence ── reaper (orphan → requeue)
    │
    └─ epoch: veFaaS Cloud Sandbox ── restore workspace from TOS
              ── ModelArk tool loop ── tool router (grants → approvals →
              exactly-once receipts) ── checkpoint to TOS ── verify → COMPLETE
```

- **State machine** (`src/core/`): every transition is one Postgres
  transaction — row lock, gapless event append, run update, outbox insert —
  through a single choke point (`transitionRun`). Waiting states: approval,
  **external signal** (`wait_for_signal` tool ⇄ `POST /v1/runs/{id}/signals`),
  and delayed start (`scheduledFor`).
- **Observability** (`src/harness/`): every tool call is auditable in the
  ledger — external writes via receipts (`ToolInvocationStarted/Committed`),
  workspace tools via `ToolInvoked` events.
- **Subagents** (`src/scheduler/children.ts`): a run's `delegate` tool spawns
  child runs that execute in **parallel** (each with an isolated
  copy-on-write workspace seeded from the parent, and a carved share of the
  parent's token budget). The parent suspends to `WAITING_CHILDREN` with zero
  compute and resumes with the children's outcomes to merge. A child that
  **fails is replaced** with a fresh attempt for the same subtask (memo §25,
  bounded by `MAX_CHILD_REPLACEMENTS`) before the parent resumes — the
  replacement lineage is durable (`replaces_run_id` / `replacement_generation`)
  and every swap is a `ChildRunReplaced` ledger event.
- **Scheduler** (`src/scheduler/`): lease-based claims with
  `FOR UPDATE SKIP LOCKED`; heartbeat fencing; a reaper requeues orphaned
  attempts (bounded by `MAX_ATTEMPTS`).
- **Harness** (`src/harness/`): execution epochs restore the latest
  checkpoint (workspace tarball + transcript from TOS), run the ModelArk
  function-calling loop, and checkpoint continuously. Waiting runs hold
  **zero compute**.
- **Side effects** (`src/harness/toolRouter.ts`): external writes flow
  through capability grants → human approval (run suspends) → PENDING
  receipt → execute with idempotency key → COMMITTED receipt. Recovery
  never re-executes a committed action.
- **Providers** (`src/providers/`): the kernel sees only provider
  interfaces; BytePlus implementations (ModelArk via the `openai` package,
  veFaaS sandbox with our own HMAC signer, TOS) are adapters — and so are the
  **local, no-BytePlus** ones (`src/providers/local/`): a child-process
  `LocalSandbox` + filesystem `ObjectStore` let the whole runtime execute
  without any cloud dependency (memo §21 portability).
- **Portability** (`src/export/runBundle.ts`): a run exports as a
  self-contained bundle — gapless events, receipts, grants, and the workspace
  snapshot — so customer execution state is owned and movable across
  deployments (`GET /v1/runs/{id}/export`).
- **Memory** (`src/providers/pgMemory.ts`): cross-run `MemoryProvider` —
  an agent recalls what it learned in earlier runs and writes new memories
  with the `remember` tool. Postgres (full-text ranked) by default; the
  AgentKit Memory binding is a drop-in adapter (`MEMORY_PROVIDER=agentkit`).
- **Semantic supervisor** (`src/harness/supervisor.ts`): a provider-neutral,
  pure evaluator that watches each run's own durable signals — the sequence of
  proposed actions, the progress ledger, and the remaining budget — to detect
  **loops**, **stagnation**, **context loss**, and **low budget**. It steers a
  stuck run through a bounded ladder — corrective note → **adaptive model
  routing** to a stronger model (`src/harness/modelRouter.ts`) → definitive
  terminate — so a run can never spin forever burning budget. State is
  checkpointed, so detection survives crashes; every decision is a ledger event
  (`LoopDetected`, `StagnationDetected`, `ModelEscalated`, …).
- **Multi-tenancy & authorization** (`src/api/auth.ts`, `src/store/tenants.ts`):
  every request authenticates to a **tenant** — the operator token maps to a
  built-in `default` tenant, and per-tenant API keys (`mak_…`, stored only as
  SHA-256 hashes) map to their own. All run/agent reads and writes are
  tenant-scoped (a cross-tenant id reads as *not-found*, never leaking
  existence), and per-tenant **quotas** (`max_concurrent_runs`,
  `daily_token_budget`) cap spend. Mint tenants/keys with `npm run admin`.
- **Cost attribution** (`src/core/costs.ts`, `src/store/usage.ts`): per-run and
  per-tenant token/cost rollups at `GET /v1/runs/{id}/usage` and `GET /v1/usage`.
  See [`docs/COST.md`](./docs/COST.md) — a real run costs ≈ half a cent in model
  tokens, and durable waits cost zero compute.
- **Operations** (`src/log.ts`, `src/api/`): structured JSON logging,
  unauthenticated `/healthz` + `/readyz` (DB-checked) probes, per-tenant rate
  limiting (in-process or Postgres-backed cross-instance via
  `RATE_LIMIT_SCOPE=global`), request body limits, and bounded graceful shutdown
  on the API and worker.
- **Event streaming** (`GET /v1/runs/{id}/events/stream`): real-time
  Server-Sent Events alongside the long-poll endpoint, with `Last-Event-ID`
  resume (events are durable, so a reconnect replays with no gap).
- **Forking** (`POST /v1/runs/{id}/fork`): branch a new run from a source run's
  checkpoint + workspace — copy-on-write workspace seed + resume from the
  source's step, inheriting its progress ledger and grants (`src/store/runs.ts`).
- **Event transport** (`src/store/outbox.ts`, `src/bin/relay.ts`): every event
  writes a transactional outbox row; the `relay` process drains it to a pluggable
  `EventPublisher` (`FOR UPDATE SKIP LOCKED`, at-least-once). In-process by
  default; `PUBLISHER=kafka` uses the real `KafkaPublisher` (kafkajs) — verified
  end-to-end against a live BytePlus Message Queue for Kafka cluster
  (publish→consume roundtrip) (`npm run relay`).
- **Credential broker** (`src/providers/credentialBroker.ts`): per-tenant secrets
  encrypted at rest, released to a run's outbound tool call only after verifying
  tenant + action + resource + expiry + call-limit, and injected into the tool
  adapter — **never** the model context, tool result, or audit ledger (memo §9.5).
  Encryption is a pluggable `SecretCipher`: `LocalCipher` (AES-256-GCM key in
  config) or `KmsCipher` (BytePlus KMS, `CREDENTIAL_PROVIDER=kms`). Manage with
  `npm run admin credential …`.

## Getting started (no BytePlus credentials needed)

```bash
npm install
docker compose up -d   # local Postgres 16 on :5433
npm run migrate
npm test               # full state-machine and integration suite
npm run release:gate   # dependency audit + controlled-alpha P0 evidence
```

Then read the [Usage Guide](./docs/GUIDE.md) to drive agents through the API.

## Connecting to BytePlus

Copy `.env.example` to `.env` and fill it in. Provisioning and credential helpers
live in [`scripts/`](./scripts/). Keep deployment-specific resource IDs in a
private operator inventory rather than committing them to this repository:

| Setting | How to obtain |
| --- | --- |
| `BYTEPLUS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN` | `python3 scripts/refresh-creds.py` syncs STS creds from `bp login` (~15 min TTL; rerun before a cloud batch) |
| `TOS_BUCKET` | `scripts/provision-tos.ts` (idempotent create + roundtrip verify) |
| `ARK_API_KEY` / `ARK_MODEL` | activate a model in the console, then `scripts/get-ark-key.py --endpoint-id ep-…` (key + endpoint id → `.env`) |
| `VEFAAS_SANDBOX_FUNCTION_ID` | sandbox application created in the console (only surface that sets `FunctionType: sandbox`); instances are then fully programmatic |
| `SANDBOX_GATEWAY_DOMAIN` / `SANDBOX_GATEWAY_API_KEY` | APIG serverless gateway + Key Auth route fronting the sandbox; key registered via `bp apig CreateConsumerCredential` |

> **Provisioning notes learned the hard way:** sandbox applications and the
> APIG gateway are console-only to create;
> `CreateSandbox` uses `InstanceImageInfo.{Image,Command}` (not `ImageUrl`) and
> inherits the released app image when omitted; the AIO sandbox runs as user
> `gem`, so the workspace lives under `/home/gem/workspace`.

Then verify every surface:

```bash
npm run preflight       # control-plane PASS/FAIL per provider
node --env-file=.env --import tsx scripts/smoke-ark.ts       # ModelArk chat (≤32 tokens)
node --env-file=.env --import tsx scripts/smoke-sandbox.ts   # sandbox create→exec→file r/w→terminate via gateway
```

Run the platform:

```bash
npm run api         # API on 127.0.0.1:8080 (set API_HOST/API_PORT to override)
npm run worker      # harness worker (WORKER_EPOCH=scripted for no-model runs)
```

## Real-world scenarios & course material

Beyond the acceptance benchmark, the runtime is exercised across **production
use cases** and capability fundamentals, with every run captured for teaching:

```bash
# Production use cases (industry workflows)
node --env-file=.env --import tsx scenarios/run.ts sre-incident       # SRE: RCA + gated remediation
node --env-file=.env --import tsx scenarios/run.ts support-refund     # Fintech: policy refund, money-movement approval
node --env-file=.env --import tsx scenarios/run.ts invoice-reconcile  # AP: invoice↔PO 3-way match
node --env-file=.env --import tsx scenarios/run.ts dep-audit          # DevSecOps: vuln audit + security gate
node --env-file=.env --import tsx scenarios/run.ts etl-clean          # Data eng: messy-CSV cleaning + schema gate

# Capability fundamentals
node --env-file=.env --import tsx scenarios/run.ts data-analysis
node --env-file=.env --import tsx scenarios/run.ts code-gen
node --env-file=.env --import tsx scenarios/run.ts approval-gated
node --env-file=.env --import tsx scenarios/run.ts doc-processing
```

Each writes a structured result (event timeline, artifacts, receipts, token
usage) to `scenarios/results/`. Two write-ups are generated from these live runs:

- **[`docs/articles/`](./docs/articles/)** — standalone tutorial articles, one
  per production use case, each with the real input prompt, the agent’s
  message-by-message execution (from the TOS-persisted transcript), and the
  verified output.
- **[`docs/COURSE-MATERIAL.md`](./docs/COURSE-MATERIAL.md)** — the consolidated
  course, with cross-cutting teaching on durability, governance, and objective
  verification.

All nine scenarios completed correctly on the live BytePlus stack (Seed-2.0-lite,
~30–60 s each); the two governed writes each hit the external system exactly once.

## The acceptance benchmark (memo §24)

```bash
npm run bench:survival              # 90s approval suspension
npm run bench:survival -- --full-hour
```

One coding run survives: worker SIGKILL → recovery on a new worker → sandbox
killed → workspace reconstructed from TOS → approval suspension with zero
active attempts → resume → external write executed exactly once → worker
killed immediately after the commit → recovery without duplication →
verification → COMPLETED with a gapless event history and TOS-verifiable
artifacts. Exit code 0 = Phase 1 accepted.

## Status

| Milestone | State |
| --- | --- |
| M0–M3 kernel (schema, transitions, scheduler, API) | ✅ built + tested locally |
| M4 signer + preflight | ✅ built + run against live BytePlus |
| M5–M8 real epoch, receipts, verifier | ✅ built + exercised end-to-end |
| M9 survival benchmark | ✅ **PASSED on the live stack** (TOS + ModelArk + Cloud Sandbox via APIG), 2026-07-17 — 57-event gapless history, exactly-once external write |
| Controlled multi-tenant alpha | ✅ automated P0 gate: fail-closed configuration, tenant inheritance, atomic admission, knowledge isolation, governed HTTP/MCP, credentials, concurrency, and crash recovery. Machine-readable evidence is retained by CI. This is not a public-beta or production-ready claim. |
| Phase 2A: harden what we own | ✅ tool-level observability, budget-exhaustion enforcement, denied-approval, external signals + scheduled runs — all tested |
| Phase 2 — long-term memory | ✅ cross-run memory: `remember` tool + auto-recall into context, per-agent scoped, full-text ranked. Postgres adapter (default) behind a provider-neutral `MemoryProvider`; the AgentKit adapter (`src/providers/agentkitMemory.ts`) is proven live (next row). |
| Phase 2 — AgentKit Memory binding | ✅ **live**: `MEMORY_PROVIDER=agentkit` writes/recalls via Viking Memory (AgentKit's memory backend) through a path-based SignerV4 client. Confirmed end-to-end (write → async AI extraction → recall). |
| Phase 2 — Knowledge / Skills / MCP | ✅ Postgres knowledge, registry Skills, and policy-classified registry MCP are implemented. The AgentKit Knowledge adapter is tenant-bound but remains fail-closed in shared deployments until live conformance is attested; AgentKit Skills/MCP remain adapter seams, not live-verified integrations. |
| Phase 3 — managed subagents | ✅ `delegate` tool → parallel child runs, `WAITING_CHILDREN` suspend + wake, parent→child budget carving, copy-on-write isolated workspaces. |
| Phase 4 — private deployment & portability | ✅ no-BytePlus local stack (`LocalSandbox` + FS `ObjectStore`) runs the full durable workspace cycle; run-bundle export (`GET /v1/runs/{id}/export`). |
| Phase 5A — semantic agent operations | ✅ semantic supervisor: loop / stagnation / context-loss / budget-low detection → corrective note → adaptive model routing → definitive terminate (no infinite spins); crash-safe (checkpointed) and fully auditable via events. Unit-tested + live-epoch integration test on the local stack. |
| Phase 5B — subagent replacement | ✅ a failed delegated child is replaced with a fresh attempt for the same subtask (durable lineage, bounded by `MAX_CHILD_REPLACEMENTS`) before the parent resumes. |
| Controlled-alpha operations | ✅ multi-tenant auth, atomic per-tenant admission, cost attribution + `/usage`, health/readiness probes, structured logging, per-tenant rate limiting, graceful-shutdown timeouts, and an admin CLI for tenants/keys. Public-beta and production gates remain open. Cost reference in [`docs/COST.md`](./docs/COST.md). |
| Deferrals | ✅ SSE event streaming, run forking, Postgres-backed global rate limiting, outbox relay + `EventPublisher` with a **live-verified** Kafka adapter, and a credential broker (encrypted per-tenant secrets injected into tool calls, never the model) with **local + BytePlus KMS** ciphers. |

Built well beyond the original Phase 1 cut: subagents (Phase 3), signals +
scheduling, AgentKit Memory/Knowledge/Skills/MCP (Phase 2), the semantic
supervisor (Phase 5), multi-tenant auth + quotas + cost attribution
(Productionization), and the full deferral sweep — streaming, forking, global
rate limiting, the event-publisher relay with a **Kafka adapter proven live**
against a real BytePlus cluster (provisioned, publish→consume verified, torn
down), and the credential broker with a **BytePlus KMS** cipher. Remaining
external-infra items: FileNAS, and RocketMQ (the Kafka adapter covers the
event-bus case). The KMS cipher requires the KMS service enabled on the account
before use.
