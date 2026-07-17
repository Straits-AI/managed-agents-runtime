# Accounts-payable agent — invoice ↔ purchase-order reconciliation

*Accounts-payable matching with machine-actionable output*

> **Result:** COMPLETED in 53s · 7 model calls · 0 governed external action(s) · model: Dola-Seed-2.0-lite

## The problem

AP teams match every supplier invoice against its purchase order before paying. It is high-volume, arithmetic-heavy, and audit-sensitive — exactly the work that is tedious for humans and error-prone for a language model that "eyeballs" numbers.

## Why this needs a durable agent runtime

The agent computes with real tools in the sandbox (not by guessing), and completion is gated on the output being valid, machine-readable JSON a downstream system can act on.

## The setup (what you give the runtime)

**System prompt (agent instructions):**
```
You are an accounts-payable analyst. Match strictly on SKU. Compute with real arithmetic (use python3), never estimate. A line matches only if quantity and unit_price both agree.
```

**Goal (the task message):**
```
invoice.json and purchase-order.json are in your workspace. Reconcile the invoice against the PO by SKU and write reconciliation.json with this shape: {"overall_match": <bool>, "invoice_total": <num>, "po_total": <num>, "lines": [{"sku":..., "status":"match"|"qty_mismatch"|"price_mismatch"|"missing_in_po", "detail":...}], "discrepancies": <count>}. Validate it parses, then call run_complete with artifacts ["reconciliation.json"].
```

**Seed files placed in the durable workspace:**

`purchase-order.json`
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

`invoice.json`
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

## The agent’s execution (real messages)

This is the actual sequence the agent ran — its tool calls and the results it saw, recovered from the run transcript persisted to TOS.

**Agent → tool call:** `bash_exec`
```json
{
  "command": "ls -la /home/gem/workspace"
}
```

**Tool result:**
```
{"exit_code":0,"stdout":"total 16\ndrwxr-xr-x  2 gem gem 4096 Jul 17 12:10 .\ndrwxr-x--- 12 gem gem 4096 Jul 17 12:10 ..\n-rw-r--r--  1 gem gem  234 Jul 17 12:10 invoice.json\n-rw-r--r--  1 gem gem  262 Jul 17 12:10 purchase-order.json\n","stderr":""}
```

**Agent → tool call:** `file_read`
```json
{
  "path": "invoice.json"
}
```

**Tool result:**
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

**Agent → tool call:** `file_read`
```json
{
  "path": "purchase-order.json"
}
```

**Tool result:**
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

**Agent → tool call:** `file_write`
```json
{
  "path": "reconcile.py",
  "content": "import json\n\n# Load files\nwith open(\"/home/gem/workspace/invoice.json\", \"r\") as f:\n    invoice = json.load(f)\nwith open(\"/home/gem/workspace/purchase-order.json\", \"r\") as f:\n    po = json.load(f)\n\n# Create PO sku lookup\npo_skus = {line[\"sku\"]: line for line in po[\"lines\"]}\n\n# Calculate totals\ninvoice_total = sum(line[\"qty\"] * line[\"unit_price\"] for line in invoice[\"lines\"])\npo_total = sum(line[\"qty\"] * line[\"unit_price\"] for line in po[\"lines\"])\n\n# Process lines\nlines = []\ndiscrepancies = 0\nfor inv_line in invoice[\"lines\"]:\n    sku = inv_line[\"sku\"]\n    if sku not in po_skus:\n        lines.append({\n            \"sku\": sku,\n            \"status\": \"missing_in_po\",\n            \"detail\": f\"SKU {sku} not found in purchase order\"\n        })\n        discrepancies +=1\n    else:\n        po_line = po_skus[sku]\n        qty_match = inv_line[\"qty\"] == po_line[\"qty\"]\n        price_match = inv_line[\"unit_price\"] == po_line[\"unit_price\"]\n        if qty_match and price_match:\n            lines.append({\n                \"sku\": sku,\n                \"status\": \"match\",\n                \"detail\": \"All values match\"\n            })\n        else:\n            details = []\n            if not qty_match:\n                details.append(f\"Invoice qty {inv_line['qty']}, PO qty {po_line['qty']}\")\n            if not price_match:\n                details.append(f\"Invoice unit price {inv_line['unit_price']}, PO unit price {po_line['unit_price']}\")\n            # Determine status: if both qty and price wrong? The problem says qty_mismatch or price_mismatch? Wait, problem says line matches only if quantity AND unit_price both agree. So if either is wrong, it's a mismatch, what status? Wait the problem's possible statuses are \"match\"|\"qty_mismatch\"|\"price_mismatch\"|\"missing_in_po\". Wait if both are wrong, which to pick? Let's check in our case, B-2 is only qty wrong, C-3 only price. If both were wrong, we can list both in detail, and maybe note? But in our case, let's follow the problem: let's set status as qty_mismatch if qty wrong, else price_mismatch if price wrong, even if both? Wait no, let's handle that: if both, then status can be \"qty_and_price_mismatch\"? No, wait the problem's allowed statuses are only those four. Wait let's re-read the problem statement: \"status\":\"match\"|\"qty_mismatch\"|\"price_mismatch\"|\"missing_in_po\". So let's prioritize: if qty is wrong, set to qty_mismatch, even if price is also wrong, and list both in detail. If only price is wrong, set to price_mismatch. That's okay. Let's do that.\n            status = \"match\"\n            if not qty_match:\n                status = \"qty_mismatch\"\n            elif not price_match:\n                status = \"price_mismatch\"\n            lines.append({\n                \"sku\": sku,\n                \"status\": status,\n                \"detail\": \"; \".join(details)\n            })\n            discrepancies +=1\n\n# Overall match\noverall_match = discrepancies == 0\n\n# Create reconciliation object\nreconciliation = {\n    \"overall_match\": overall_match,\n    \"invoice_total\": invoice_total,\n    \"po_total\": po_total,\n    \"lines\": lines,\n    \"discrepancies\": discrepancies\n}\n\n# Write to file\nwith open(\"/home/gem/workspace/reconciliation.json\", \"w\") as f:\n    json.dump(reconciliation, f, indent=2)\n\nprint(\"Reconciliation written to reconciliation.json\")\nprint(json.dumps(reconciliation, indent=2))\n"
}
```

**Tool result:**
```
wrote reconcile.py
```

**Agent → tool call:** `bash_exec`
```json
{
  "command": "cd /home/gem/workspace && python3 reconcile.py"
}
```

**Tool result:**
```
{"exit_code":0,"stdout":"Reconciliation written to reconciliation.json\n{\n  \"overall_match\": false,\n  \"invoice_total\": 1080.0,\n  \"po_total\": 940.0,\n  \"lines\": [\n    {\n      \"sku\": \"A-1\",\n      \"status\": \"match\",\n      \"detail\": \"All values match\"\n    },\n    {\n      \"sku\": \"B-2\",\n      \"status\": \"qty_mismatch\",\n      \"detail\": \"Invoice qty 60, PO qty 50\"\n    },\n    {\n      \"sku\": \"C-3\",\n      \"status\": \"price_mismatch\",\n      \"detail\": \"Invoice unit price 1.45, PO unit price 1.2\"\n    }\n  ],\n  \"discrepancies\": 2\n}\n","stderr":""}
```

## The verified output

**`reconciliation.json`:**
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

## Takeaway

The agent caught both the quantity and price discrepancies with exact totals and emitted a structured verdict — ready to auto-approve the matching lines and route the two exceptions to a human.

---

*Reproduce: `node --env-file=.env --import tsx scenarios/run.ts invoice-reconcile`. Full event timeline: [`scenarios/results/invoice-reconcile.md`](../../scenarios/results/invoice-reconcile.md).*