# Managed Agents Runtime — Tutorial & Course Material

Hands-on results from running the runtime against real-world agent workloads on
the **live BytePlus stack** (RDS Postgres ledger, ModelArk inference, veFaaS
Cloud Sandbox via an APIG gateway, TOS workspace storage). Every run in this
document actually executed end-to-end — the event timelines, artifacts, and
token counts are captured, not illustrative.

Raw per-scenario captures live in [`scenarios/results/`](../scenarios/results/)
(`<id>.md` human-readable, `<id>.json` machine-readable). Re-run any of them:

```bash
python3 scripts/refresh-creds.py           # 15-min STS creds into .env
node --env-file=.env --import tsx scenarios/run.ts <scenario-id>
```

Model used throughout: **Dola-Seed-2.0-lite** (ModelArk) — deliberately a small,
cheap model, to show the *runtime* carries the reliability, not the model.

---

## What was tested, at a glance

| Scenario | Domain | Result | Wall-clock | Model calls | Tokens (in/out) | Teaches |
| --- | --- | --- | --- | --- | --- | --- |
| `data-analysis` | Data → report | ✅ COMPLETED | 41 s | 5 | 8329 / 1263 | The core run loop + artifact verification |
| `code-gen` | Software eng | ✅ COMPLETED | 32 s | 5 | 8438 / 827 | Objective, command-based verification |
| `approval-gated` | Governed ops | ✅ COMPLETED | 44 s | 4 | 5988 / 553 | Human-in-the-loop + exactly-once side effects |
| `doc-processing` | Knowledge work | ✅ COMPLETED | 38 s | 4 | 6163 / 865 | Workload-agnostic structured extraction |
| **survival benchmark** | Coding + chaos | ✅ PASSED (57 events) | ~6 min | — | Durability: crash / sandbox loss / approval / exactly-once recovery |

Every workload completed correctly on the first *properly-configured* attempt.
The one failure encountered (`code-gen` with `pytest`) was a **verifier
integrity success**, not a runtime fault — see Lesson 5.

---

## The mental model (teach this first)

A **run** is a durable process, not an API call. You give the runtime a goal,
seed files, and capability grants; it then drives an agent loop across
**execution epochs** that can move between workers and sandboxes without losing
state:

```
POST /v1/runs ─▶ QUEUED ─▶ worker claims (lease) ─▶ epoch:
    restore workspace from TOS  →  model step (ModelArk)  →  propose action
      →  capability + approval check  →  tool exec (idempotent, receipted)
      →  checkpoint workspace to TOS  →  repeat / suspend / complete
Every state change is one Postgres transaction: run row + gapless event + outbox.
```

Two properties make it a *platform* rather than a script:

1. **The sandbox filesystem is never authoritative.** Workspaces are tar
   snapshots in TOS; a run survives its sandbox being destroyed.
2. **External side effects are governed and exactly-once.** Writes flow through
   capability grants → optional human approval → a durable receipt with an
   idempotency key. A crash after the write never repeats it.

---

## Lesson 1 — The core loop (`data-analysis`)

**Goal given:** compute total revenue, per-region revenue, and the best month
from a seeded `sales.csv`, then write `REPORT.md`.

**What happened:** 19 events, 5 model calls, 41 s. The agent used real shell/
python computation in the sandbox and produced:

```markdown
## Total Revenue
The total revenue across all regions and months is **$13,600**.
## Revenue by Region
- AMER: $5,800   - APAC: $4,500   - EMEA: $3,300
## Best Month by Total Revenue
The single best month by total revenue is **March**, with a total revenue of $5,200.
```

All figures are arithmetically correct. **Teaching point:** the runtime seeds
files into the durable workspace, the agent computes with real tools (not by
guessing), and the required artifact is verified to exist and fetched back from
TOS. This is the minimal shape every workload builds on. Full capture:
[`data-analysis.md`](../scenarios/results/data-analysis.md).

---

## Lesson 2 — Objective verification (`code-gen`)

**Goal given:** implement `roman.py::to_roman(n)` and make a seeded test file
pass. **Verifier policy:** `requiredArtifacts: ["roman.py"]` plus the command
`python3 -m unittest test_roman`.

**What happened:** 20 events, 32 s, COMPLETED. Completion was **not** granted
because the model said "done" — it was granted because the test command exited
0 inside the sandbox. **Teaching point:** the verifier (`src/harness/verifier.ts`)
is the gate between the agent's *claim* and the run's *completion*. Wire your
acceptance criteria into a real command and the platform enforces them for you.
Full capture: [`code-gen.md`](../scenarios/results/code-gen.md).

---

## Lesson 3 — Human-in-the-loop governance (`approval-gated`)

**Goal given:** compute a sum, then `POST {"sum": N}` to an external service —
where the external call is granted with `requiresApproval: true`.

**What happened (28 events, 44 s):** the event sequence tells the whole story —

```
ApprovalRequested → (run suspends, ZERO active compute) → ApprovalReceived
  → ToolInvocationStarted → ToolInvocationCommitted
```

The external system recorded the write **exactly once**:

```json
{ "method": "POST", "path": "/results", "body": { "sum": 110 }, "receivedCount": 1 }
```

and the durable ledger shows one receipt: `external.http.request | COMMITTED |
irreversible`. **Teaching points:**

- A capability grant is the unit of authority. `requiresApproval` turns any
  action into a gated one.
- While waiting for a human, the run holds **no compute** — the worker and
  sandbox are released and the run is a durable row. It can wait an hour or a
  week at zero cost.
- The idempotency key + receipt guarantee the side effect happens exactly once,
  even across a crash immediately after the external call (proven separately in
  the survival benchmark). Full capture:
  [`approval-gated.md`](../scenarios/results/approval-gated.md).

---

## Lesson 4 — The runtime is workload-agnostic (`doc-processing`)

**Goal given:** read prose meeting notes, extract action items into
`actions.json`, validate it parses.

**What happened (18 events, 38 s):** correct structured extraction of all three
action items —

```json
[{"owner":"Wei","task":"finalise the pricing page","due":"Friday"},
 {"owner":"Hana","task":"send the updated contract to legal","due":"18 July"},
 {"owner":"Jayden","task":"migrating the database","due":"end of month"}]
```

verified with `python3 -m json.tool`. **Teaching point:** nothing about the
runtime is coding-specific. The same durable-run + verify + artifact machinery
serves data work, knowledge work, and operations. Full capture:
[`doc-processing.md`](../scenarios/results/doc-processing.md).

---

## Lesson 5 — When verification *should* fail (a real war story)

The first `code-gen` attempt used `python3 -m pytest -q` as the verifier
command. It **failed three times** and the run ended `FAILED
(verification_retries_exhausted)` — because the AIO sandbox image ships no
`pytest`:

```
verification command failed (exit 1): python3 -m pytest -q
/opt/veskill-sandbox/.venv/bin/python3: No module named pytest
```

Notably, the model *argued its way around the failure* —

> "All test cases pass when executed directly in Python. The environment's
> missing pytest installation is not a flaw in the implementation…"

— and the verifier **correctly refused to accept that reasoning**, because
completion is gated on an exit code, not a narrative. Two lessons for students:

1. **Objective verification is doing its job precisely when it's inconvenient.**
   A self-reporting agent would have declared success here.
2. **Match verification to the runtime.** Prefer tools guaranteed to exist
   (stdlib `unittest`, `json.tool`) or install dependencies as an explicit
   `initCommand`/build step before relying on them. Switching to `unittest`
   turned this into the clean pass in Lesson 2.

Preserved capture:
[`code-gen-pytest-failure.md`](../scenarios/results/code-gen-pytest-failure.md).

---

## Lesson 6 — Durability under chaos (the survival benchmark)

`npm run bench:survival` runs one coding agent through the full memo §24
gauntlet and it **passes on the live stack**. In order, a single run survives:

1. worker `SIGKILL` mid-execution → orphan detected → **new attempt resumes**;
2. its sandbox destroyed → **workspace reconstructed from TOS** into a fresh one;
3. an approval suspension held for 90 s with **zero active attempts**;
4. resume → external write executed **once**;
5. worker killed *immediately after the commit* → **recovery without
   duplicating** the write;
6. verification → `COMPLETED` with a **57-event gapless history** and a
   TOS-verified artifact.

**Teaching point:** this is the property you cannot get from an agent framework
alone. Model quality determines whether the task is done *well*; the runtime
determines whether the task *survives* infrastructure failure and never double-
executes a side effect.

---

## Practical notes for course authors

- **Cost & speed.** Simple workloads finish in **30–45 s** and **4–5 model
  calls** (~6–9k input / <1.5k output tokens) on Seed-2.0-lite. Cheap enough to
  run live in a lecture. The survival benchmark is ~6 min (dominated by the 90 s
  approval wait + sandbox re-creations).
- **Credentials.** The dev stack uses 15-minute STS credentials; a single run
  fits comfortably inside that window. `scripts/refresh-creds.py` before each.
- **Sandbox environment.** Runs as unprivileged user `gem`; the workspace is
  `/home/gem/workspace`. `python3`, `node`, and shell tools are present;
  `pytest` is not (Lesson 5).
- **Where the pieces live.** Runner: [`scenarios/runner.ts`](../scenarios/runner.ts).
  Cases: [`scenarios/cases.ts`](../scenarios/cases.ts). Provisioned cloud
  resources + teardown: [`infra/resources.md`](../infra/resources.md).
- **Suggested course arc.** Lesson 1 (loop) → 4 (workload-agnostic) → 2 (verify)
  → 5 (verify failure) → 3 (governance) → 6 (durability). Build to durability;
  it's the payoff that justifies the architecture.

---

## Ideas for further scenarios (not yet run)

- **Multi-file refactor** with a build+test gate (larger `code-gen`).
- **Long-horizon research** using the sandbox browser + retrieval (the AIO
  image ships a browser and MCP servers).
- **Denied approval** — show the agent adapting its plan when a human *rejects*
  an action (`decision: "deny"`), not just approves.
- **Budget exhaustion** — set a low `tokenBudget` and show graceful `FAILED
  (budget_exhausted)` rather than an unbounded loop.
