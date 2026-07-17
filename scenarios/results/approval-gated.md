# Governed operations agent — human-approved external write

**Scenario id:** `approval-gated`  
**Teaches:** The governance story: a side-effecting external call is gated by a capability grant that requires human approval; the run suspends with zero compute, resumes on approval, and the write is recorded exactly once via a durable receipt.  
**Result:** COMPLETED in 44s  
**Model usage:** 4 calls, 5988 in / 553 out tokens

## Goal given to the agent

```
Compute the sum of the integers in numbers.txt (one per line). Then register it by POSTing {"sum": <the sum>} to http://127.0.0.1:50734/results using external_http_request (this needs human approval — request it and wait for the decision). After it succeeds, call run_complete with artifacts [].
```

## Seed files

`numbers.txt`:
```
11
22
33
44

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
| 13 | ApprovalRequested |
| 14 | ApprovalReceived |
| 15 | WorkspaceCheckpointed |
| 16 | SandboxTerminated |
| 17 | AttemptStarted |
| 18 | AttemptStarted |
| 19 | SandboxAllocated |
| 20 | WorkspaceRestored |
| 21 | ToolInvocationStarted |
| 22 | ToolInvocationCommitted |
| 23 | ModelInvocationStarted |
| 24 | ModelInvocationCompleted |
| 25 | VerificationStarted |
| 26 | WorkspaceCheckpointed |
| 27 | RunCompleted |
| 28 | SandboxTerminated |

## Event summary

| event | count |
| --- | --- |
| AttemptStarted | 4 |
| ModelInvocationStarted | 4 |
| ModelInvocationCompleted | 4 |
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
    "id": "txn_316bef199cd36e62",
    "idempotencyKey": "1fa087ec1686b835619c8135d368b1e8c9fa4b7ed525c82a329816f386d84906",
    "method": "POST",
    "path": "/results",
    "body": {
      "sum": 110
    },
    "receivedCount": 1,
    "firstReceivedAt": "2026-07-17T04:01:11.993Z"
  }
]
```

## Attempts (execution epochs)

| state | sandbox | exit reason |
| --- | --- | --- |
| EXITED | vefaas-jsdzgnxi-0d9v4raq51-d9cqhoo0d2stlmo028eg-sandbox | suspended_for_approval |
| EXITED | vefaas-jsdzgnxi-0d9v4raq51-d9cqhuo0d2stlmo028f0-sandbox | completed |
