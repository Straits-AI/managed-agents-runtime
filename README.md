# Managed Agents Runtime (Phase 1)

A durable, serverless execution kernel for long-running agents on BytePlus —
the Phase 1 prototype specified in [`memo.md`](./memo.md). An agent run is a
durable identity and event history whose execution moves across replaceable
workers and sandboxes: it survives worker death, sandbox loss, redeployment,
and long approval waits without losing progress or duplicating irreversible
actions.

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
  veFaaS sandbox with our own HMAC signer, TOS) are adapters.

## Getting started (no BytePlus credentials needed)

```bash
npm install
docker compose up -d   # local Postgres 16 on :5433
npm run migrate
npm test               # 37 tests: state machine, crash recovery, approvals,
                       # exactly-once side effects — all against local Postgres
```

## Connecting to BytePlus

Copy `.env.example` to `.env` and fill it in. The live dev stack is provisioned
and documented in [`infra/resources.md`](./infra/resources.md); provisioning and
credential helpers live in [`scripts/`](./scripts/):

| Setting | How to obtain (see `scripts/` + `infra/resources.md`) |
| --- | --- |
| `BYTEPLUS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN` | `python3 scripts/refresh-creds.py` syncs STS creds from `bp login` (~15 min TTL; rerun before a cloud batch) |
| `TOS_BUCKET` | `scripts/provision-tos.ts` (idempotent create + roundtrip verify) |
| `ARK_API_KEY` / `ARK_MODEL` | activate a model in the console, then `scripts/get-ark-key.py --endpoint-id ep-…` (key + endpoint id → `.env`) |
| `VEFAAS_SANDBOX_FUNCTION_ID` | sandbox application created in the console (only surface that sets `FunctionType: sandbox`); instances are then fully programmatic |
| `SANDBOX_GATEWAY_DOMAIN` / `SANDBOX_GATEWAY_API_KEY` | APIG serverless gateway + Key Auth route fronting the sandbox; key registered via `bp apig CreateConsumerCredential` |

> **Provisioning notes learned the hard way** (all in `infra/resources.md`):
> sandbox applications and the APIG gateway are console-only to create;
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
npm run api         # public API (set API_PORT if 8080 is taken)
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
| M0–M3 kernel (schema, transitions, scheduler, API) | ✅ built + tested locally (38 tests) |
| M4 signer + preflight | ✅ built + run against live BytePlus |
| M5–M8 real epoch, receipts, verifier | ✅ built + exercised end-to-end |
| M9 survival benchmark | ✅ **PASSED on the live stack** (TOS + ModelArk + Cloud Sandbox via APIG), 2026-07-17 — 57-event gapless history, exactly-once external write |
| Phase 2A: harden what we own | ✅ tool-level observability, budget-exhaustion enforcement, denied-approval, external signals + scheduled runs — all tested (45 tests) |
| Phase 2: AgentKit (Memory/Knowledge/Skills/MCP) | 🚧 in progress |

Phase 1 scope cuts (per memo §22.4): subagents, Kafka/RocketMQ (outbox is
in-process), AgentKit Memory/Knowledge/Identity, KMS/FileNAS, multi-tenancy,
streaming events (long-poll only), `fork`/`signals` endpoints. AgentKit
Skills/MCP are deferred to a thin adapter milestone (M10).
