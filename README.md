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
  through a single choke point (`transitionRun`).
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

Copy `.env.example` to `.env` and fill in (console prerequisites: a ModelArk
API key + model, an IAM keypair with veFaaS/APIG/TOS access, a deployed
**Code Sandbox Agent** application (its FunctionId), and a TOS bucket):

```
ARK_API_KEY / ARK_MODEL
BYTEPLUS_ACCESS_KEY_ID / BYTEPLUS_SECRET_ACCESS_KEY
VEFAAS_SANDBOX_FUNCTION_ID
TOS_BUCKET
```

Then verify every surface:

```bash
npm run preflight   # PASS/FAIL per provider; also settles whether the
                    # vefaas sandbox actions are exposed on
                    # open.byteplusapi.com (fallback: open.volcengineapi.com
                    # via BYTEPLUS_OPENAPI_HOST/BYTEPLUS_REGION)
```

Run the platform:

```bash
npm run api         # public API on :8080
npm run worker      # harness worker (WORKER_EPOCH=scripted for no-model runs)
```

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
| M4 signer + preflight | ✅ built; awaiting credentials to run |
| M5–M8 real epoch, receipts, verifier | ✅ built; router logic tested locally |
| M9 survival benchmark | ⏳ script ready; blocked on credentials |

Phase 1 scope cuts (per memo §22.4): subagents, Kafka/RocketMQ (outbox is
in-process), AgentKit Memory/Knowledge/Identity, KMS/FileNAS, multi-tenancy,
streaming events (long-poll only), `fork`/`signals` endpoints. AgentKit
Skills/MCP are deferred to a thin adapter milestone (M10).
