# Cost of running agents

What a real agent run actually costs on this runtime, from **measured** token
usage across the nine production scenarios in [`scenarios/`](../scenarios), priced
against current BytePlus rates. The runtime also computes these figures live per
run and per tenant — see [`GET /v1/runs/{id}/usage` and `GET /v1/usage`](#the-usage-api).

> **Headline:** a typical real-world agent run costs **≈ half a US cent** in model
> tokens (Seed-2.0-lite). Model tokens dominate; sandbox compute is a smaller
> component; storage, database, and gateway costs are negligible per run or
> amortized across the fleet. Because waiting states hold **zero compute**, a run
> that waits hours for a human approval adds essentially nothing to its cost.

## 1. Model tokens — the dominant cost (measured)

Prices are BytePlus ModelArk **Seed-2.0-lite**, the model these scenarios ran on:
**$0.25 per million input tokens, $2.00 per million output tokens** (0–128K input
tier, July 2026). Token counts below are the real figures recorded in each
scenario's result JSON (`scenarios/results/*.json`).

| Scenario | Model calls | Input tok | Output tok | Model cost (USD) |
| --- | ---: | ---: | ---: | ---: |
| dependency vuln audit (`dep-audit`) | 8 | 15,425 | 1,025 | $0.00591 |
| invoice ↔ PO reconcile (`invoice-reconcile`) | 7 | 16,193 | 1,937 | $0.00792 |
| ETL messy-CSV clean (`etl-clean`) | 7 | 15,336 | 1,893 | $0.00762 |
| SRE incident RCA (`sre-incident`) | 5 | 9,978 | 1,471 | $0.00544 |
| support refund (policy-gated) (`support-refund`) | 6 | 10,518 | 1,054 | $0.00474 |
| data analysis (`data-analysis`) | 5 | 8,329 | 1,263 | $0.00461 |
| code generation (`code-gen`) | 5 | 8,438 | 827 | $0.00376 |
| document processing (`doc-processing`) | 4 | 6,163 | 865 | $0.00327 |
| approval-gated write (`approval-gated`) | 4 | 5,988 | 553 | $0.00260 |
| **Average** | **~6** | **~10,700** | **~1,210** | **≈ $0.0051** |

So across a realistic mix of coding, data, ops, and finance agents, **one run ≈
$0.003–$0.008 in model spend**. Output tokens cost 8× input, but agents here read
far more than they write, so input volume and output volume contribute roughly
equally.

### If you use a larger model

Model choice is per-agent (`model_policy.model`) and the supervisor can escalate
a stuck run to a stronger model (`escalationModel`). Costs scale with the model's
rate — e.g. seed-1.6 at a 16K input tier is ~$0.80/M input and ~$8/M output, ~10×
Seed-2.0-lite, so the same run would cost ~$0.03–0.08. Adaptive routing keeps the
cheap model as the default and only pays for the expensive one on the few steps
that need it.

## 2. Sandbox compute (estimate)

Each executing epoch runs in a veFaaS Cloud Sandbox. The scenarios completed in
**~30–60 s** of wall-clock each. Serverless compute is billed by GB-second (plus
vCPU-second); at a representative serverless rate of ~$1.7×10⁻⁵ per GB-second, a
60 s run at 2 GB is:

```
60 s × 2 GB × $0.000017/GB-s ≈ $0.002 per run
```

So sandbox compute adds roughly **$0.001–0.003 per run** — smaller than, and the
same order as, model cost. Exact veFaaS pay-as-you-go rates are published in the
BytePlus console pricing pages (they are not machine-fetchable here); confirm them
there and override the estimate for your region.

**The key lever:** waiting states (`WAITING_APPROVAL`, `WAITING_SIGNAL`,
`WAITING_CHILDREN`) hold **no sandbox and no worker** — the run is durable state in
Postgres only. A run that waits 6 hours for an approval burns **zero** compute
during those 6 hours; it pays sandbox cost only while actually executing.

## 3. Storage, database, gateway (negligible or amortized)

| Component | What it stores | Per-run cost |
| --- | --- | --- |
| **TOS** (object store) | workspace checkpoint tarballs + transcript JSON, a few MB/run | ~$0.0002/run·month at ~$0.02/GB-month; effectively rounding error |
| **RDS PostgreSQL** | the authoritative ledger (runs, events, receipts) | a **fixed** monthly instance cost amortized over all runs — see below |
| **APIG** | fronts the public API and the sandbox gateway | per-request, ~$10⁻⁶/request; a handful of requests per run → negligible |

RDS is shared infrastructure, not per-run. A small instance amortized:

| Runs / month | RDS amortized/run (at ~$45/mo) |
| ---: | ---: |
| 1,000 | ~$0.045 |
| 10,000 | ~$0.0045 |
| 100,000 | ~$0.00045 |

At low volume the fixed database cost dominates the per-run total; past ~10K
runs/month it drops below model cost.

## 4. All-in monthly projections

Combining measured model cost (~$0.005/run), estimated sandbox (~$0.002/run),
negligible storage/gateway, and a ~$45/mo small RDS instance:

| Runs / month | Model | Sandbox | RDS (fixed) | **Total/month** | **Per run** |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | ~$5 | ~$2 | ~$45 | **~$52** | ~$0.052 |
| 10,000 | ~$50 | ~$20 | ~$45 | **~$115** | ~$0.012 |
| 100,000 | ~$500 | ~$200 | ~$90¹ | **~$790** | ~$0.008 |

¹ a larger DB instance at higher volume. Model + sandbox scale linearly; fixed
infrastructure amortizes away, so **unit cost falls with scale** toward the
~$0.007–0.008/run compute+model floor.

## 5. Cost controls built into the runtime

- **Durable waits are free.** Long human-in-the-loop or event waits cost only
  storage, never compute (memo §12/§13).
- **Token budgets + the semantic supervisor.** Per-run `tokenBudget` and
  `maxSteps` are hard ceilings; the supervisor detects loops/stagnation and
  **terminates a stuck run** instead of letting it burn tokens indefinitely
  (memo §25) — this directly caps worst-case cost.
- **Adaptive model routing.** Default to the cheap model; escalate to a stronger
  (pricier) one only for steps that are actually stuck.
- **Bounded context.** The context compiler sends the progress ledger + a recent
  transcript tail, not the full history, so input tokens per step stay bounded
  even on long runs.
- **Exactly-once side effects + checkpoint reuse.** Crash recovery restores from
  the last checkpoint and never re-runs committed work, so failures don't
  multiply cost.
- **Per-tenant quotas.** `max_concurrent_runs` and `daily_token_budget` cap a
  tenant's spend (429 on exceed).
- **Prompt/context caching.** ModelArk offers discounted cache-hit input tokens;
  agents with stable system prompts/instructions can cut input cost further.

## The `/usage` API

The runtime attributes cost live using the same model prices (configurable via
`MODEL_PRICE_INPUT_PER_MTOK` / `MODEL_PRICE_OUTPUT_PER_MTOK`):

- `GET /v1/runs/{id}/usage` → `{ inputTokens, outputTokens, totalTokens,
  modelCalls, attempts, estimatedCostUsd }` for one run.
- `GET /v1/usage?since=<ISO>` → tenant-wide rollup (defaults to the current UTC
  day): `{ runs, inputTokens, outputTokens, totalTokens, estimatedCostUsd }`.

Both are tenant-scoped. Estimates are for planning and attribution, not a
billing-authoritative invoice.

## Sources & caveats

- ModelArk Seed-2.0-lite pricing: BytePlus ModelArk pricing / model pages
  (`docs.byteplus.com/en/docs/ModelArk`), July 2026 — $0.25/M input, $2.00/M
  output (0–128K tier).
- Token counts: measured, from `scenarios/results/*.json` on the live BytePlus
  stack (Seed-2.0-lite).
- Sandbox/TOS/RDS/APIG rates are representative estimates; exact BytePlus
  pay-as-you-go rates live in the console pricing pages and should be confirmed
  per region. Model cost is exact; infrastructure cost is an estimate.
