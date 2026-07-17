# Accounts-payable agent — invoice ↔ purchase-order reconciliation

**Scenario id:** `invoice-reconcile`  
**Teaches:** Structured financial control work: the agent matches an invoice against its purchase order line by line, flags quantity and price discrepancies, and emits a machine-readable reconciliation that a downstream system can act on — verified to be valid JSON.  
**Result:** COMPLETED in 53s  
**Model usage:** 7 calls, 16193 in / 1937 out tokens

## Goal given to the agent

```
invoice.json and purchase-order.json are in your workspace. Reconcile the invoice against the PO by SKU and write reconciliation.json with this shape: {"overall_match": <bool>, "invoice_total": <num>, "po_total": <num>, "lines": [{"sku":..., "status":"match"|"qty_mismatch"|"price_mismatch"|"missing_in_po", "detail":...}], "discrepancies": <count>}. Validate it parses, then call run_complete with artifacts ["reconciliation.json"].
```

## Seed files

`purchase-order.json`:
```
{
  "po_number": "PO-9007",
  "lines": [
    {"sku": "A-1", "desc": "Widget",   "qty": 100, "unit_price": 2.50},
    {"sku": "B-2", "desc": "Gadget",   "qty": 50,  "unit_price": 9.00},
    {"sku": "C-3", "desc": "Cable",    "qty": 200, "unit_price": 1.20}
  ]
}

```

`invoice.json`:
```
{
  "invoice_number": "INV-5521",
  "po_number": "PO-9007",
  "lines": [
    {"sku": "A-1", "qty": 100, "unit_price": 2.50},
    {"sku": "B-2", "qty": 60,  "unit_price": 9.00},
    {"sku": "C-3", "qty": 200, "unit_price": 1.45}
  ]
}

```

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
| 17 | WorkspaceCheckpointed |
| 18 | ModelInvocationStarted |
| 19 | ModelInvocationCompleted |
| 20 | ModelInvocationStarted |
| 21 | ModelInvocationCompleted |
| 22 | VerificationStarted |
| 23 | WorkspaceCheckpointed |
| 24 | RunCompleted |

## Event summary

| event | count |
| --- | --- |
| ModelInvocationStarted | 7 |
| ModelInvocationCompleted | 7 |
| AttemptStarted | 2 |
| WorkspaceCheckpointed | 2 |
| RunCreated | 1 |
| RunQueued | 1 |
| SandboxAllocated | 1 |
| WorkspaceRestored | 1 |
| VerificationStarted | 1 |
| RunCompleted | 1 |

## Attempts (execution epochs)

| state | sandbox | exit reason |
| --- | --- | --- |
| ACTIVE | vefaas-jsdzgnxi-0d9v4raq51-d9cqmgo0lmcclio05iug-sandbox | - |

## Artifacts produced

### `reconciliation.json`
```
{
  "overall_match": false,
  "invoice_total": 1080.0,
  "po_total": 940.0,
  "lines": [
    {
      "sku": "A-1",
      "status": "match",
      "detail": "All values match"
    },
    {
      "sku": "B-2",
      "status": "qty_mismatch",
      "detail": "Invoice qty 60, PO qty 50"
    },
    {
      "sku": "C-3",
      "status": "price_mismatch",
      "detail": "Invoice unit price 1.45, PO unit price 1.2"
    }
  ],
  "discrepancies": 2
}
```
