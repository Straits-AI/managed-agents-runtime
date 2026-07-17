# Support agent — policy-driven refund with money-movement approval

*Support automation where the agent can move money — exactly once*

> **Result:** COMPLETED in 49s · 6 model calls · 1 governed external action(s) · model: Dola-Seed-2.0-lite

## The problem

Refunds are the highest-value, highest-risk action a support agent takes. Automate them naively and two failure modes appear: the agent misapplies the policy, or a network retry issues the refund twice. Both are real money and real compliance incidents.

## Why this needs a durable agent runtime

The agent applies the written policy and drafts the reply; the payout call is a governed, approval-gated action recorded against a durable idempotency key. A crash after the payout never re-issues it — the receipt already says COMMITTED.

## The setup (what you give the runtime)

**System prompt (agent instructions):**
```
You are a customer support agent. Apply the refund policy exactly as written; do not invent exceptions. Issuing a refund moves money and requires human approval.
```

**Goal (the task message):**
```
ticket.txt, order.json, and refund-policy.md are in your workspace. 1) Decide whether the refund is eligible strictly per refund-policy.md. 2) Write reply.txt: a polite customer response stating the decision and reason. 3) If and only if eligible, issue the refund by POSTing {"order_id": <id>, "amount": <amount>} to http://127.0.0.1:50935/refunds using external_http_request (moves money — request human approval and wait). 4) Call run_complete with artifacts ["reply.txt"].
```

**Seed files placed in the durable workspace:**

`ticket.txt`
```
Subject: Wrong size, want my money back

Hi, I ordered the trail runners but they arrived a full size too small and I can't wear them. I'd like a refund please. Order K-4471.

— Dana
```

`order.json`
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

`refund-policy.md`
```
# Refund policy

A refund is eligible if ALL of the following hold:
- the order status is "delivered";
- it is within 30 days of delivered_at;
- the item is unused (used = false).

Today is 2026-07-17. If any condition fails, the refund is not eligible.
```

**Capability grants:**

- `external.http.*` — **requires human approval**

## The agent’s execution (real messages)

This is the actual sequence the agent ran — its tool calls and the results it saw, recovered from the run transcript persisted to TOS.

**Agent → tool call:** `file_read`
```json
{
  "path": "refund-policy.md"
}
```

**Tool result:**
```
# Refund policy

A refund is eligible if ALL of the following hold:
- the order status is "delivered";
- it is within 30 days of delivered_at;
- the item is unused (used = false).

Today is 2026-07-17. If any condition fails, the refund is not eligible.

```

**Agent → tool call:** `file_read`
```json
{
  "path": "order.json"
}
```

**Tool result:**
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

**Agent → tool call:** `file_read`
```json
{
  "path": "ticket.txt"
}
```

**Tool result:**
```
Subject: Wrong size, want my money back

Hi, I ordered the trail runners but they arrived a full size too small and I can't wear them. I'd like a refund please. Order K-4471.

— Dana
```

**Agent → tool call:** `file_write`
```json
{
  "path": "reply.txt",
  "content": "Hi Dana,\nThank you for contacting us about your refund request for order K-4471. I'm happy to confirm your request is eligible for a full refund per our policy. Your order was delivered on 2026-07-09, which falls within our 30-day refund window, your order status is \"delivered\", and the item is marked as unused, so all conditions for a refund have been met. We will process your full refund of $129.00 USD immediately.\nPlease let us know if you need any further assistance.\nBest regards,\nCustomer Support Team"
}
```

**Tool result:**
```
wrote reply.txt
```

**Agent → tool call:** `external_http_request`
```json
{
  "method": "POST",
  "url": "http://127.0.0.1:50935/refunds",
  "body": {
    "order_id": "K-4471",
    "amount": 129
  }
}
```

## The governed side effect

The external write was held for human approval, then executed **exactly once** (note `receivedCount: 1`) and recorded in the durable receipt ledger:

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

Receipt:

| action | status | reversibility |
| --- | --- | --- |
| external.http.request | COMMITTED | irreversible |

## The verified output

**`reply.txt`:**
```
Hi Dana,
Thank you for contacting us about your refund request for order K-4471. I'm happy to confirm your request is eligible for a full refund per our policy. Your order was delivered on 2026-07-09, which falls within our 30-day refund window, your order status is "delivered", and the item is marked as unused, so all conditions for a refund have been met. We will process your full refund of $129.00 USD immediately.
Please let us know if you need any further assistance.
Best regards,
Customer Support Team
```

## Takeaway

One policy decision, one human approval, one payout — provably. This is the canonical case for a durable agent runtime over a plain agent framework.

---

*Reproduce: `node --env-file=.env --import tsx scenarios/run.ts support-refund`. Full event timeline: [`scenarios/results/support-refund.md`](../../scenarios/results/support-refund.md).*