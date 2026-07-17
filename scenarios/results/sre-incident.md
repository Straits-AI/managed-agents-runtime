# SRE agent — incident triage with human-approved remediation

**Scenario id:** `sre-incident`  
**Teaches:** Autonomous on-call: the agent reads production logs, diagnoses a root cause against a runbook, writes an RCA, and only executes the remediation (a real ops side effect) after a human approves — the write happening exactly once even if the worker crashes after it.  
**Result:** COMPLETED in 58s  
**Model usage:** 5 calls, 9978 in / 1471 out tokens

## Goal given to the agent

```
app-errors.log and runbook.md are in your workspace. 1) Identify the root cause of the incident from the log. 2) Write INCIDENT.md with: Summary, Root Cause, Impact, and the Remediation you will take (cite the matching runbook step). 3) Execute that remediation by POSTing the runbook-specified JSON action to http://127.0.0.1:50888/remediate using external_http_request (this affects production and needs human approval — request it and wait). 4) Then call run_complete with artifacts ["INCIDENT.md"].
```

## Seed files

`app-errors.log`:
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

`runbook.md`:
```
# Runbook: API service

## DB connection pool exhausted
Symptom: repeated "could not get connection from pool: timeout" and HTTP 503.
Remediation: scale up the connection pool by POSTing this action to /remediate:
`{"action":"scale_pool","service":"api","target_pool_size":40}`

## High CPU
Symptom: cpu>90% sustained. Remediation: `{"action":"scale_out","service":"api"}`.

```

## Capability grants

- `external.http.*` on `{{EXTERNAL}}` — **requires human approval**

## Event timeline

| seq | event |
| --- | --- |
| 1 | RunCreated |
| 2 | RunQueued |
| 3 | AttemptStarted |
| 4 | AttemptStarted |
| 5 | SandboxAllocated |
| 6 | WorkspaceRestored |
| 7 | ModelInvocationStarted |
| 8 | ModelInvocationCompleted |
| 9 | ModelInvocationStarted |
| 10 | ModelInvocationCompleted |
| 11 | ModelInvocationStarted |
| 12 | ModelInvocationCompleted |
| 13 | ModelInvocationStarted |
| 14 | ModelInvocationCompleted |
| 15 | ApprovalRequested |
| 16 | WorkspaceCheckpointed |
| 17 | ApprovalReceived |
| 18 | SandboxTerminated |
| 19 | AttemptStarted |
| 20 | AttemptStarted |
| 21 | SandboxAllocated |
| 22 | WorkspaceRestored |
| 23 | ToolInvocationStarted |
| 24 | ToolInvocationCommitted |
| 25 | ModelInvocationStarted |
| 26 | ModelInvocationCompleted |
| 27 | VerificationStarted |
| 28 | WorkspaceCheckpointed |
| 29 | RunCompleted |
| 30 | SandboxTerminated |

## Event summary

| event | count |
| --- | --- |
| ModelInvocationStarted | 5 |
| ModelInvocationCompleted | 5 |
| AttemptStarted | 4 |
| SandboxAllocated | 2 |
| WorkspaceRestored | 2 |
| WorkspaceCheckpointed | 2 |
| SandboxTerminated | 2 |
| RunCreated | 1 |
| RunQueued | 1 |
| ApprovalRequested | 1 |
| ApprovalReceived | 1 |
| ToolInvocationStarted | 1 |
| ToolInvocationCommitted | 1 |
| VerificationStarted | 1 |
| RunCompleted | 1 |

## Side-effect receipts (exactly-once ledger)

| action | status | reversibility |
| --- | --- | --- |
| external.http.request | COMMITTED | irreversible |

## External side effects recorded

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

## Attempts (execution epochs)

| state | sandbox | exit reason |
| --- | --- | --- |
| EXITED | vefaas-jsdzgnxi-0d9v4raq51-d9cql5g07v3l4ko01deg-sandbox | suspended_for_approval |
| EXITED | vefaas-jsdzgnxi-0d9v4raq51-d9cqleg07v3l4ko01df0-sandbox | completed |

## Artifacts produced

### `INCIDENT.md`
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
