# Managed Agents Runtime — Tutorial & Course Material

Hands-on results from running the runtime against real-world agent workloads on
the **live BytePlus stack** (RDS Postgres ledger, ModelArk inference, veFaaS
Cloud Sandbox via an APIG gateway, TOS workspace storage). Every run in this
document actually executed end-to-end — the event timelines, artifacts, and
token counts are captured, not illustrative.

Standalone, ready-to-publish tutorial articles — each with the real input
prompt, the agent’s message-by-message execution, and the verified output — are
in **[`articles/`](./articles/)**. This document is the consolidated course that
ties them together. Raw per-scenario captures live in
[`scenarios/results/`](../scenarios/results/) (`<id>.md` human-readable,
`<id>.json` machine-readable). Re-run any of them:

```bash
python3 scripts/refresh-creds.py           # 15-min STS creds into .env
node --env-file=.env --import tsx scenarios/run.ts <scenario-id>
```

Model used throughout: **Dola-Seed-2.0-lite** (ModelArk) — deliberately a small,
cheap model, to show the *runtime* carries the reliability, not the model.

---

## What was tested, at a glance

**Production use cases** (Part B — the main event):

| Scenario | Industry | Result | Wall-clock | Governed write? | Teaches |
| --- | --- | --- | --- | --- | --- |
| `sre-incident` | SRE / AIOps | ✅ COMPLETED | 58 s | ✅ approved, once | Autonomous on-call: RCA + gated remediation |
| `support-refund` | Support / Fintech | ✅ COMPLETED | 49 s | ✅ approved, once | Money movement with policy + approval |
| `invoice-reconcile` | Finance / AP | ✅ COMPLETED | 53 s | — | 3-way invoice↔PO match with discrepancy flags |
| `dep-audit` | DevSecOps | ✅ COMPLETED | 43 s | — | Vuln audit + **security gate** certifies the fix |
| `etl-clean` | Data engineering | ✅ COMPLETED | 50 s | — | Messy-CSV cleaning behind a schema gate |

**Capability fundamentals** (Part A — isolate one feature each):

| Scenario | Domain | Result | Wall-clock | Teaches |
| --- | --- | --- | --- | --- |
| `data-analysis` | Data → report | ✅ COMPLETED | 41 s | The core run loop + artifact verification |
| `code-gen` | Software eng | ✅ COMPLETED | 32 s | Objective, command-based verification |
| `approval-gated` | Governed ops | ✅ COMPLETED | 44 s | Human-in-the-loop + exactly-once side effects |
| `doc-processing` | Knowledge work | ✅ COMPLETED | 38 s | Workload-agnostic structured extraction |
| **survival benchmark** | Coding + chaos | ✅ PASSED (57 events) | ~6 min | Durability under crash / sandbox loss / recovery |

All nine scenarios completed correctly and produced verified outputs. The two
governed writes (SRE remediation, refund payout) each hit the external system
**exactly once**. The one failure encountered along the way (`code-gen` with
`pytest`) was a **verifier integrity success**, not a runtime fault — Lesson 5.

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

# Part B — Production use cases

These map to workflows enterprises actually pay to automate. The pattern that
recurs — and that justifies a *durable* runtime over a plain agent framework —
is a **risky, irreversible side effect gated by human approval and guaranteed
exactly-once**. Lead your course here; the fundamentals in Part A are the
mechanics that make these safe.

## Use case 1 — Autonomous on-call / AIOps (`sre-incident`)

**Business context:** an SRE agent that triages production incidents and
executes remediation — the dream of AIOps, but only safe if the remediation is
governed.

**Goal given:** diagnose the incident from `app-errors.log`, write an RCA, and
execute the runbook's remediation via an approval-gated webhook.

**What happened (30 events, 58 s):** the agent correctly identified DB
connection-pool exhaustion from the log, wrote a professional RCA (Summary /
Root Cause / Impact / Remediation citing the runbook), and — after approval —
POSTed the **exact** runbook action:

```json
POST /remediate  { "action": "scale_pool", "service": "api", "target_pool_size": 40 }
receivedCount: 1     receipt: external.http.request | COMMITTED | irreversible
```

**Teaching points:** the agent acts on *evidence in the logs*, the remediation
is a real production side effect held behind human approval, and the exactly-once
receipt means a worker crash right after the POST never scales the pool twice.
Full capture: [`sre-incident.md`](../scenarios/results/sre-incident.md).

## Use case 2 — Support automation with a money guardrail (`support-refund`)

**Business context:** support agents that resolve tickets end-to-end, including
issuing refunds — where a double-refund is real money lost and a compliance
incident.

**Goal given:** decide refund eligibility strictly per `refund-policy.md`, draft
the customer reply, and issue the payout only if eligible (approval-gated).

**What happened (31 events, 49 s):** the agent checked all three policy
conditions (delivered ✓, within 30 days ✓, unused ✓), wrote a customer reply
that explains each, and issued the refund exactly once:

```json
POST /refunds  { "order_id": "K-4471", "amount": 129 }
receivedCount: 1     receipt: COMMITTED | irreversible
```

**Teaching points:** this is *the* canonical argument for the platform — policy
applied by the agent, decision approved by a human, money moved exactly once,
and the whole thing survives a crash. Contrast with a naive agent that could
retry the payout after a timeout and double-charge. Full capture:
[`support-refund.md`](../scenarios/results/support-refund.md).

## Use case 3 — Accounts-payable reconciliation (`invoice-reconcile`)

**Business context:** AP teams matching supplier invoices against purchase
orders before payment — high volume, error-prone, audit-sensitive.

**Goal given:** match `invoice.json` against `purchase-order.json` by SKU and
emit a structured reconciliation.

**What happened (24 events, 53 s):** correct 3-way match with real arithmetic —

```json
{ "overall_match": false, "invoice_total": 1080.0, "po_total": 940.0,
  "lines": [ {"sku":"A-1","status":"match"},
             {"sku":"B-2","status":"qty_mismatch","detail":"Invoice qty 60, PO qty 50"},
             {"sku":"C-3","status":"price_mismatch","detail":"Invoice unit price 1.45, PO unit price 1.2"} ],
  "discrepancies": 2 }
```

Both discrepancies were caught and totals were exact. **Teaching point:** a
machine-readable artifact (not prose) lets a downstream system act — approve for
payment, or route the two flagged lines to a human. Full capture:
[`invoice-reconcile.md`](../scenarios/results/invoice-reconcile.md).

## Use case 4 — Dependency vulnerability management (`dep-audit`)

**Business context:** DevSecOps automation that audits dependencies and opens
remediation — where "the agent says it's fixed" is not good enough for security.

**Goal given:** audit `requirements.txt` against `advisories.json`, write an
audit report, and produce a patched manifest.

**What happened (27 events, 43 s):** the agent bumped exactly the three
vulnerable packages (flask 2.0.1→2.3.2, pyyaml 5.3.1→5.4, urllib3 1.26.4→1.26.5),
left the two unaffected ones untouched, and wrote an `AUDIT.md` table with CVE
IDs. **The completion gate is itself a security control:** a script that fails if
*any* advisory-listed version still appears in the fixed manifest. Completion
means that script passed — the runtime certified the remediation, not the model.
Full capture: [`dep-audit.md`](../scenarios/results/dep-audit.md).

## Use case 5 — Data-quality ETL (`etl-clean`)

**Business context:** data-engineering pipelines that clean messy inbound data
before it reaches the warehouse.

**Goal given:** clean `raw_customers.csv` (dedupe by email, drop rows missing
required fields, lowercase emails, normalise dates) and emit a quality report.

**What happened (25 events, 50 s):** 7 rows in → 3 out; the 2 rows missing
name/email dropped, 2 email-duplicates removed, dates normalised
(`3/2/2026`→`2026-02-03`, `15/3/2026`→`2026-03-15`), with an accurate report
`{"rows_in":7,"rows_out":3,"dropped_missing":2,"duplicates_removed":2}`. It
passed a schema-validation gate that asserts the header, non-empty required
fields, and lowercase emails. **Teaching point:** the objective gate encodes the
data contract, so a malformed clean is rejected automatically. Full capture:
[`etl-clean.md`](../scenarios/results/etl-clean.md).

---

# Part A — Capability fundamentals

Smaller scenarios that isolate one platform mechanism each. Use them to explain
*how* the production use cases above are made safe.

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
  Cases: [`scenarios/cases.ts`](../scenarios/cases.ts). Keep provisioned cloud
  resource IDs and teardown state in the deployment's private operator inventory.
- **Suggested course arc.** Lesson 1 (loop) → 4 (workload-agnostic) → 2 (verify)
  → 5 (verify failure) → 3 (governance) → 6 (durability). Build to durability;
  it's the payoff that justifies the architecture.

---

## Observations across all nine runs

- **The runtime, not the model, carries reliability.** Every correct outcome
  came from a small, cheap model (Seed-2.0-lite) because the platform supplies
  the durability, the approval gates, and the objective verification. Swapping in
  a stronger model would improve task *quality*, not these guarantees.
- **Governed writes are the differentiator.** The two use cases with real side
  effects (SRE remediation, refund) are exactly where a plain agent framework is
  dangerous and this runtime is safe: approval + exactly-once + crash-survival.
- **Objective gates encode the contract.** `dep-audit` (security), `etl-clean`
  (schema), `code-gen` (tests), `invoice-reconcile` (valid JSON) all push the
  definition of "done" out of the model's self-report and into a command.
- **Cost is lecture-friendly.** Production use cases ran in 43–58 s and
  ~10–16 k input tokens each — cheap enough to demo live.

## Ideas for further scenarios (not yet run)

- **Denied approval** — show the agent adapting its plan when a human *rejects*
  an action (`decision: "deny"`), not just approves.
- **Budget exhaustion** — set a low `tokenBudget` and show graceful `FAILED
  (budget_exhausted)` rather than an unbounded loop.
- **Long-horizon research** using the sandbox browser + retrieval (the AIO image
  ships a browser and MCP servers).
- **Ineligible refund** — a variant of `support-refund` where the policy fails,
  proving the agent withholds the payout (no external write at all).
