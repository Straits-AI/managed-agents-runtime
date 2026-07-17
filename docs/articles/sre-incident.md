# SRE agent — incident triage with human-approved remediation

*Autonomous on-call that can act on production — safely*

> **Result:** COMPLETED in 58s · 5 model calls · 1 governed external action(s) · model: Dola-Seed-2.0-lite

## The problem

On-call engineers spend nights reading logs, matching symptoms to runbooks, and running remediation commands. An AI agent can do the reading and the matching in seconds — but the *acting* part is terrifying without guardrails: an agent that scales the wrong service or fires a remediation twice can turn a small incident into an outage.

## Why this needs a durable agent runtime

The runtime lets the agent diagnose freely but puts the one dangerous step — the remediation webhook — behind a capability grant that requires human approval, and guarantees it runs exactly once even if the worker crashes the instant after the call.

## The setup (what you give the runtime)

**System prompt (agent instructions):**
```
You are a Site Reliability Engineer on call. Diagnose from evidence in the logs; do not speculate beyond what the logs show. Remediation actions affect production and require human approval via external_http_request.
```

**Goal (the task message):**
```
app-errors.log and runbook.md are in your workspace. 1) Identify the root cause of the incident from the log. 2) Write INCIDENT.md with: Summary, Root Cause, Impact, and the Remediation you will take (cite the matching runbook step). 3) Execute that remediation by POSTing the runbook-specified JSON action to http://127.0.0.1:50888/remediate using external_http_request (this affects production and needs human approval — request it and wait). 4) Then call run_complete with artifacts ["INCIDENT.md"].
```

**Seed files placed in the durable workspace:**

`app-errors.log`
```
2026-07-17T02:14:03Z INFO  api server started, pool size=20
2026-07-17T02:41:11Z WARN  db pool near capacity: 18/20 active
2026-07-17T02:41:average latency 210ms
2026-07-17T02:42:03Z WARN  db pool near capacity: 20/20 active
2026-07-17T02:42:04Z ERROR could not get connection from pool: timeout after 5000ms
2026-07-17T02:42:04Z ERROR HTTP 503 GET /orders (pool exhausted)
2026-07-17T02:42:05Z ERROR could not get connection from pool: timeout after 5000ms
2026-07-17T02:42:06Z ERROR HTTP 503 POST /checkout (pool exhausted)
2026-07-17T02:43:00Z ERROR pool exhausted, 142 requests queued
```

`runbook.md`
```
# Runbook: API service

## DB connection pool exhausted
Symptom: repeated "could not get connection from pool: timeout" and HTTP 503.
Remediation: scale up the connection pool by POSTing this action to /remediate:
`{"action":"scale_pool","service":"api","target_pool_size":40}`

## High CPU
Symptom: cpu>90% sustained. Remediation: `{"action":"scale_out","service":"api"}`.
```

**Capability grants:**

- `external.http.*` — **requires human approval**

## The agent’s execution (real messages)

This is the actual sequence the agent ran — its tool calls and the results it saw, recovered from the run transcript persisted to TOS.

**Agent → tool call:** `file_read`
```json
{
  "path": "app-errors.log"
}
```

**Tool result:**
```
2026-07-17T02:14:03Z INFO  api server started, pool size=20
2026-07-17T02:41:11Z WARN  db pool near capacity: 18/20 active
2026-07-17T02:41:average latency 210ms
2026-07-17T02:42:03Z WARN  db pool near capacity: 20/20 active
2026-07-17T02:42:04Z ERROR could not get connection from pool: timeout after 5000ms
2026-07-17T02:42:04Z ERROR HTTP 503 GET /orders (pool exhausted)
2026-07-17T02:42:05Z ERROR could not get connection from pool: timeout after 5000ms
2026-07-17T02:42:06Z ERROR HTTP 503 POST /checkout (pool exhausted)
2026-07-17T02:43:00Z ERROR pool exhausted, 142 requests queued

```

**Agent → tool call:** `file_read`
```json
{
  "path": "runbook.md"
}
```

**Tool result:**
```
# Runbook: API service

## DB connection pool exhausted
Symptom: repeated "could not get connection from pool: timeout" and HTTP 503.
Remediation: scale up the connection pool by POSTing this action to /remediate:
`{"action":"scale_pool","service":"api","target_pool_size":40}`

## High CPU
Symptom: cpu>90% sustained. Remediation: `{"action":"scale_out","service":"api"}`.

```

**Agent → tool call:** `file_write`
```json
{
  "path": "INCIDENT.md",
  "content": "# Incident Report\n## Summary\nOn 2026-07-17 starting at 02:42 UTC, the API service began returning HTTP 503 errors to client requests after exhausting its database connection pool. The incident caused service degradation for users accessing the /orders and /checkout endpoints, with a backlog of queued requests building as connections remained unavailable.\n\n## Root Cause\nThe API service's database connection pool, initialized with a size of 20 connections, reached 100% utilization (20/20 active connections). This exhaustion caused all new connection acquisition attempts to time out after 5000ms, leading to immediate request failures. The root cause aligns with the runbook's \"DB connection pool exhausted\" symptom pattern.\n\n## Impact\n- Clients sending requests to the /orders (GET) and /checkout (POST) endpoints received HTTP 503 Service Unavailable errors starting at 02:42 UTC.\n- By 02:43 UTC, 142 requests were queued waiting for database connections, leading to widespread user-facing failures and increased latency for any successful requests.\n\n## Remediation\nPer the runbook step for \"DB connection pool exhausted\" (which lists the observed errors \"could not get connection from pool: timeout\" and HTTP 503 as matching symptoms), the remediation action is to scale the connection pool. We will POST the runbook-specified JSON payload `{\"action\":\"scale_pool\",\"service\":\"api\",\"target_pool_size\":40}` to the /remediate endpoint to increase the pool size to 40, resolving the exhaustion."
}
```

**Tool result:**
```
wrote INCIDENT.md
```

**Agent → tool call:** `external_http_request`
```json
{
  "method": "POST",
  "url": "http://127.0.0.1:50888/remediate",
  "body": {
    "action": "scale_pool",
    "service": "api",
    "target_pool_size": 40
  },
  "headers": {
    "Content-Type": "application/json"
  }
}
```

## The governed side effect

The external write was held for human approval, then executed **exactly once** (note `receivedCount: 1`) and recorded in the durable receipt ledger:

```json
[
  {
    "id": "txn_c335d54b2ea108bb",
    "idempotencyKey": "bc47c59dca5fdc1766148a3630b8b56d4b529e7e6eb5dceb1a2ca224b2cd6204",
    "method": "POST",
    "path": "/remediate",
    "body": {
      "action": "scale_pool",
      "service": "api",
      "target_pool_size": 40
    },
    "receivedCount": 1,
    "firstReceivedAt": "2026-07-17T04:08:38.707Z"
  }
]
```

Receipt:

| action | status | reversibility |
| --- | --- | --- |
| external.http.request | COMMITTED | irreversible |

## The verified output

**`INCIDENT.md`:**
```
# Incident Report
## Summary
On 2026-07-17 starting at 02:42 UTC, the API service began returning HTTP 503 errors to client requests after exhausting its database connection pool. The incident caused service degradation for users accessing the /orders and /checkout endpoints, with a backlog of queued requests building as connections remained unavailable.

## Root Cause
The API service's database connection pool, initialized with a size of 20 connections, reached 100% utilization (20/20 active connections). This exhaustion caused all new connection acquisition attempts to time out after 5000ms, leading to immediate request failures. The root cause aligns with the runbook's "DB connection pool exhausted" symptom pattern.

## Impact
- Clients sending requests to the /orders (GET) and /checkout (POST) endpoints received HTTP 503 Service Unavailable errors starting at 02:42 UTC.
- By 02:43 UTC, 142 requests were queued waiting for database connections, leading to widespread user-facing failures and increased latency for any successful requests.

## Remediation
Per the runbook step for "DB connection pool exhausted" (which lists the observed errors "could not get connection from pool: timeout" and HTTP 503 as matching symptoms), the remediation action is to scale the connection pool. We will POST the runbook-specified JSON payload `{"action":"scale_pool","service":"api","target_pool_size":40}` to the /remediate endpoint to increase the pool size to 40, resolving the exhaustion.
```

## Takeaway

The agent read the log, matched the runbook, and proposed the exact remediation — then the platform paused for a human and executed the approved action once. That division of labour (agent reasons, platform governs) is what makes autonomous remediation deployable.

---

*Reproduce: `node --env-file=.env --import tsx scenarios/run.ts sre-incident`. Full event timeline: [`scenarios/results/sre-incident.md`](../../scenarios/results/sre-incident.md).*