# Support agent — policy-driven refund with money-movement approval

**Scenario id:** `support-refund`  
**Teaches:** The canonical case for exactly-once + approval: a refund moves real money. The agent applies the written policy, drafts the customer reply, and the payout POST is both human-approved and guaranteed to execute exactly once — a crash never double-refunds.  
**Result:** COMPLETED in 49s  
**Model usage:** 6 calls, 10518 in / 1054 out tokens

## Goal given to the agent

```
ticket.txt, order.json, and refund-policy.md are in your workspace. 1) Decide whether the refund is eligible strictly per refund-policy.md. 2) Write reply.txt: a polite customer response stating the decision and reason. 3) If and only if eligible, issue the refund by POSTing {"order_id": <id>, "amount": <amount>} to http://127.0.0.1:50935/refunds using external_http_request (moves money — request human approval and wait). 4) Call run_complete with artifacts ["reply.txt"].
```

## Seed files

`ticket.txt`:
```
Subject: Wrong size, want my money back

Hi, I ordered the trail runners but they arrived a full size too small and I can't wear them. I'd like a refund please. Order K-4471.

— Dana
```

`order.json`:
```
{
  "order_id": "K-4471",
  "item": "Trail Runner shoes",
  "amount": 129.00,
  "currency": "USD",
  "ordered_at": "2026-07-02",
  "delivered_at": "2026-07-09",
  "status": "delivered",
  "used": false
}

```

`refund-policy.md`:
```
# Refund policy

A refund is eligible if ALL of the following hold:
- the order status is "delivered";
- it is within 30 days of delivered_at;
- the item is unused (used = false).

Today is 2026-07-17. If any condition fails, the refund is not eligible.

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
| 15 | ModelInvocationStarted |
| 16 | ModelInvocationCompleted |
| 17 | ApprovalRequested |
| 18 | ApprovalReceived |
| 19 | WorkspaceCheckpointed |
| 20 | SandboxTerminated |
| 21 | AttemptStarted |
| 22 | AttemptStarted |
| 23 | SandboxAllocated |
| 24 | WorkspaceRestored |
| 25 | ToolInvocationStarted |
| 26 | ToolInvocationCommitted |
| 27 | ModelInvocationStarted |
| 28 | ModelInvocationCompleted |
| 29 | VerificationStarted |
| 30 | WorkspaceCheckpointed |
| 31 | RunCompleted |

## Event summary

| event | count |
| --- | --- |
| ModelInvocationStarted | 6 |
| ModelInvocationCompleted | 6 |
| AttemptStarted | 4 |
| SandboxAllocated | 2 |
| WorkspaceRestored | 2 |
| WorkspaceCheckpointed | 2 |
| RunCreated | 1 |
| RunQueued | 1 |
| ApprovalRequested | 1 |
| ApprovalReceived | 1 |
| SandboxTerminated | 1 |
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
    "id": "txn_262d62c4d9f68b28",
    "idempotencyKey": "0b9e4c27b284f46d895bca70ee0b023c4b81d75503f3f255b2de8b76bdb91612",
    "method": "POST",
    "path": "/refunds",
    "body": {
      "amount": 129,
      "order_id": "K-4471"
    },
    "receivedCount": 1,
    "firstReceivedAt": "2026-07-17T04:10:08.093Z"
  }
]
```

## Attempts (execution epochs)

| state | sandbox | exit reason |
| --- | --- | --- |
| EXITED | vefaas-jsdzgnxi-0d9v4raq51-d9cqlu007v3l4ko01dfg-sandbox | suspended_for_approval |
| ACTIVE | vefaas-jsdzgnxi-0d9v4raq51-d9cqm5807v3l4ko01dg0-sandbox | - |

## Artifacts produced

### `reply.txt`
```
Hi Dana,
Thank you for contacting us about your refund request for order K-4471. I'm happy to confirm your request is eligible for a full refund per our policy. Your order was delivered on 2026-07-09, which falls within our 30-day refund window, your order status is "delivered", and the item is marked as unused, so all conditions for a refund have been met. We will process your full refund of $129.00 USD immediately.
Please let us know if you need any further assistance.
Best regards,
Customer Support Team
```
