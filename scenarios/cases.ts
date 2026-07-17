import type { Scenario } from './runner.js';

/**
 * Real-world use cases exercised against the live Managed Agents runtime.
 * Each is designed to (a) succeed with a modest model and bounded cost, and
 * (b) demonstrate a distinct platform capability worth a tutorial lesson.
 */
export const SCENARIOS: Record<string, Scenario> = {
  // ---------------------------------------------------------------------------
  'data-analysis': {
    id: 'data-analysis',
    title: 'Data analysis agent — CSV to summary report',
    teaches:
      'The core loop: seed data into the durable workspace, let the agent compute with real tools (python/bash), verify a required artifact exists, and retrieve it from TOS.',
    instructions:
      'You are a data analyst working in a Linux sandbox. Use python3 or shell tools to do real computation — never guess numbers. Keep your progress ledger updated.',
    goal:
      'The file sales.csv (columns: region,month,amount) is in your workspace. ' +
      '1) Compute total revenue, revenue per region, and the single best month by total revenue. ' +
      '2) Write REPORT.md with those figures clearly labelled. ' +
      '3) Call run_complete with artifacts ["REPORT.md"].',
    seedFiles: {
      'sales.csv':
        'region,month,amount\n' +
        'APAC,Jan,1200\nAPAC,Feb,1500\nAPAC,Mar,1800\n' +
        'EMEA,Jan,900\nEMEA,Feb,1100\nEMEA,Mar,1300\n' +
        'AMER,Jan,2000\nAMER,Feb,1700\nAMER,Mar,2100\n',
    },
    verifierPolicy: { requiredArtifacts: ['REPORT.md'] },
    maxSteps: 25,
    timeoutMs: 420_000,
  },

  // ---------------------------------------------------------------------------
  'code-gen': {
    id: 'code-gen',
    title: 'Coding agent — implement a utility and pass its tests',
    teaches:
      'Objective verification: the agent writes code, and completion is gated on a real test command exiting 0 in the sandbox — not on the model claiming success.',
    instructions:
      'You are a careful software engineer working in a Linux sandbox with python3 available. ' +
      'Write real, runnable code and verify it yourself with the shell before declaring completion.',
    goal:
      'Implement a Python module roman.py with a function to_roman(n) that converts an ' +
      'integer 1..3999 to a Roman numeral string. ' +
      'A test file test_roman.py is already in your workspace — make it pass. ' +
      'Run `python3 -m unittest test_roman` yourself to check, then call run_complete with ' +
      'artifacts ["roman.py"].',
    // unittest is in the Python stdlib — it always exists in the sandbox,
    // unlike pytest. Matching verification to the runtime is a real lesson
    // (an earlier pytest-based version failed here, correctly, because the
    // AIO image ships no pytest).
    seedFiles: {
      'test_roman.py':
        'import unittest\n' +
        'from roman import to_roman\n\n' +
        'class TestRoman(unittest.TestCase):\n' +
        '    def test_basic(self):\n' +
        "        cases = {1:'I',4:'IV',9:'IX',40:'XL',90:'XC',400:'CD'," +
        "1994:'MCMXCIV',3999:'MMMCMXCIX'}\n" +
        '        for n, expected in cases.items():\n' +
        '            self.assertEqual(to_roman(n), expected)\n\n' +
        "if __name__ == '__main__':\n" +
        '    unittest.main()\n',
    },
    verifierPolicy: {
      requiredArtifacts: ['roman.py'],
      command: 'python3 -m unittest test_roman',
    },
    maxSteps: 30,
    timeoutMs: 480_000,
  },

  // ---------------------------------------------------------------------------
  'approval-gated': {
    id: 'approval-gated',
    title: 'Governed operations agent — human-approved external write',
    teaches:
      'The governance story: a side-effecting external call is gated by a capability grant that requires human approval; the run suspends with zero compute, resumes on approval, and the write is recorded exactly once via a durable receipt.',
    instructions:
      'You are an operations agent. To register a result with an external system you must use ' +
      'external_http_request; that action requires human approval, so request it and wait.',
    goal:
      'Compute the sum of the integers in numbers.txt (one per line). ' +
      'Then register it by POSTing {"sum": <the sum>} to {{EXTERNAL}}/results using ' +
      'external_http_request (this needs human approval — request it and wait for the decision). ' +
      'After it succeeds, call run_complete with artifacts [].',
    seedFiles: { 'numbers.txt': '11\n22\n33\n44\n' }, // sum = 110
    grants: [
      { action: 'external.http.*', resource: '{{EXTERNAL}}', requiresApproval: true },
    ],
    externalSystem: true,
    autoApprove: true,
    maxSteps: 25,
    timeoutMs: 420_000,
  },

  // ---------------------------------------------------------------------------
  'doc-processing': {
    id: 'doc-processing',
    title: 'Document processing agent — extract structured data from prose',
    teaches:
      'A non-code knowledge-work domain: the agent reads an unstructured document from the ' +
      'workspace and produces a structured artifact (JSON), showing the runtime is workload-agnostic.',
    instructions:
      'You are a document-processing agent working in a Linux sandbox. Read the input file, ' +
      'extract the requested fields accurately, and write valid JSON.',
    goal:
      'Read meeting-notes.txt from your workspace. Extract every action item into ' +
      'actions.json as a JSON array of objects with keys "owner", "task", and "due". ' +
      'Validate it parses (e.g. with python3 -m json.tool), then call run_complete with ' +
      'artifacts ["actions.json"].',
    seedFiles: {
      'meeting-notes.txt':
        'Project sync — 14 July 2026\n\n' +
        'Attendees: Wei, Hana, Jayden.\n\n' +
        'Discussion: launch is slipping. We agreed on the following.\n' +
        '- Wei will finalise the pricing page by Friday.\n' +
        '- Hana to send the updated contract to legal by 18 July.\n' +
        '- Jayden owns migrating the database; target end of month.\n' +
        'Next sync: 21 July.\n',
    },
    verifierPolicy: {
      requiredArtifacts: ['actions.json'],
      command: 'python3 -m json.tool actions.json',
    },
    maxSteps: 25,
    timeoutMs: 420_000,
  },

  // ===========================================================================
  // Industry / production use cases
  // ===========================================================================

  // --- SRE / AIOps: incident triage + human-approved remediation ------------
  'sre-incident': {
    id: 'sre-incident',
    title: 'SRE agent — incident triage with human-approved remediation',
    teaches:
      'Autonomous on-call: the agent reads production logs, diagnoses a root cause against a ' +
      'runbook, writes an RCA, and only executes the remediation (a real ops side effect) after ' +
      'a human approves — the write happening exactly once even if the worker crashes after it.',
    instructions:
      'You are a Site Reliability Engineer on call. Diagnose from evidence in the logs; do not ' +
      'speculate beyond what the logs show. Remediation actions affect production and require ' +
      'human approval via external_http_request.',
    goal:
      'app-errors.log and runbook.md are in your workspace. ' +
      '1) Identify the root cause of the incident from the log. ' +
      '2) Write INCIDENT.md with: Summary, Root Cause, Impact, and the Remediation you will take ' +
      '(cite the matching runbook step). ' +
      '3) Execute that remediation by POSTing the runbook-specified JSON action to ' +
      '{{EXTERNAL}}/remediate using external_http_request (this affects production and needs ' +
      'human approval — request it and wait). ' +
      '4) Then call run_complete with artifacts ["INCIDENT.md"].',
    seedFiles: {
      'app-errors.log':
        '2026-07-17T02:14:03Z INFO  api server started, pool size=20\n' +
        '2026-07-17T02:41:11Z WARN  db pool near capacity: 18/20 active\n' +
        '2026-07-17T02:41:average latency 210ms\n' +
        '2026-07-17T02:42:03Z WARN  db pool near capacity: 20/20 active\n' +
        '2026-07-17T02:42:04Z ERROR could not get connection from pool: timeout after 5000ms\n' +
        '2026-07-17T02:42:04Z ERROR HTTP 503 GET /orders (pool exhausted)\n' +
        '2026-07-17T02:42:05Z ERROR could not get connection from pool: timeout after 5000ms\n' +
        '2026-07-17T02:42:06Z ERROR HTTP 503 POST /checkout (pool exhausted)\n' +
        '2026-07-17T02:43:00Z ERROR pool exhausted, 142 requests queued\n',
      'runbook.md':
        '# Runbook: API service\n\n' +
        '## DB connection pool exhausted\n' +
        'Symptom: repeated "could not get connection from pool: timeout" and HTTP 503.\n' +
        'Remediation: scale up the connection pool by POSTing this action to /remediate:\n' +
        '`{"action":"scale_pool","service":"api","target_pool_size":40}`\n\n' +
        '## High CPU\n' +
        'Symptom: cpu>90% sustained. Remediation: `{"action":"scale_out","service":"api"}`.\n',
    },
    grants: [
      { action: 'external.http.*', resource: '{{EXTERNAL}}', requiresApproval: true },
    ],
    externalSystem: true,
    autoApprove: true,
    verifierPolicy: { requiredArtifacts: ['INCIDENT.md'] },
    maxSteps: 28,
    timeoutMs: 480_000,
  },

  // --- Support / Fintech: policy-driven refund with money-movement guard -----
  'support-refund': {
    id: 'support-refund',
    title: 'Support agent — policy-driven refund with money-movement approval',
    teaches:
      'The canonical case for exactly-once + approval: a refund moves real money. The agent ' +
      'applies the written policy, drafts the customer reply, and the payout POST is both ' +
      'human-approved and guaranteed to execute exactly once — a crash never double-refunds.',
    instructions:
      'You are a customer support agent. Apply the refund policy exactly as written; do not ' +
      'invent exceptions. Issuing a refund moves money and requires human approval.',
    goal:
      'ticket.txt, order.json, and refund-policy.md are in your workspace. ' +
      '1) Decide whether the refund is eligible strictly per refund-policy.md. ' +
      '2) Write reply.txt: a polite customer response stating the decision and reason. ' +
      '3) If and only if eligible, issue the refund by POSTing ' +
      '{"order_id": <id>, "amount": <amount>} to {{EXTERNAL}}/refunds using ' +
      'external_http_request (moves money — request human approval and wait). ' +
      '4) Call run_complete with artifacts ["reply.txt"].',
    seedFiles: {
      'ticket.txt':
        'Subject: Wrong size, want my money back\n\n' +
        'Hi, I ordered the trail runners but they arrived a full size too small and I ' +
        "can't wear them. I'd like a refund please. Order K-4471.\n\n— Dana",
      'order.json':
        '{\n  "order_id": "K-4471",\n  "item": "Trail Runner shoes",\n  "amount": 129.00,\n' +
        '  "currency": "USD",\n  "ordered_at": "2026-07-02",\n  "delivered_at": "2026-07-09",\n' +
        '  "status": "delivered",\n  "used": false\n}\n',
      'refund-policy.md':
        '# Refund policy\n\n' +
        'A refund is eligible if ALL of the following hold:\n' +
        '- the order status is "delivered";\n' +
        '- it is within 30 days of delivered_at;\n' +
        '- the item is unused (used = false).\n\n' +
        'Today is 2026-07-17. If any condition fails, the refund is not eligible.\n',
    },
    grants: [
      { action: 'external.http.*', resource: '{{EXTERNAL}}', requiresApproval: true },
    ],
    externalSystem: true,
    autoApprove: true,
    verifierPolicy: { requiredArtifacts: ['reply.txt'] },
    maxSteps: 26,
    timeoutMs: 480_000,
  },

  // --- Finance / AP: invoice ↔ purchase-order reconciliation -----------------
  'invoice-reconcile': {
    id: 'invoice-reconcile',
    title: 'Accounts-payable agent — invoice ↔ purchase-order reconciliation',
    teaches:
      'Structured financial control work: the agent matches an invoice against its purchase ' +
      'order line by line, flags quantity and price discrepancies, and emits a machine-readable ' +
      'reconciliation that a downstream system can act on — verified to be valid JSON.',
    instructions:
      'You are an accounts-payable analyst. Match strictly on SKU. Compute with real arithmetic ' +
      '(use python3), never estimate. A line matches only if quantity and unit_price both agree.',
    goal:
      'invoice.json and purchase-order.json are in your workspace. ' +
      'Reconcile the invoice against the PO by SKU and write reconciliation.json with this shape: ' +
      '{"overall_match": <bool>, "invoice_total": <num>, "po_total": <num>, ' +
      '"lines": [{"sku":..., "status":"match"|"qty_mismatch"|"price_mismatch"|"missing_in_po", ' +
      '"detail":...}], "discrepancies": <count>}. ' +
      'Validate it parses, then call run_complete with artifacts ["reconciliation.json"].',
    seedFiles: {
      'purchase-order.json':
        '{\n  "po_number": "PO-9007",\n  "lines": [\n' +
        '    {"sku": "A-1", "desc": "Widget",   "qty": 100, "unit_price": 2.50},\n' +
        '    {"sku": "B-2", "desc": "Gadget",   "qty": 50,  "unit_price": 9.00},\n' +
        '    {"sku": "C-3", "desc": "Cable",    "qty": 200, "unit_price": 1.20}\n' +
        '  ]\n}\n',
      'invoice.json':
        '{\n  "invoice_number": "INV-5521",\n  "po_number": "PO-9007",\n  "lines": [\n' +
        '    {"sku": "A-1", "qty": 100, "unit_price": 2.50},\n' +
        '    {"sku": "B-2", "qty": 60,  "unit_price": 9.00},\n' +
        '    {"sku": "C-3", "qty": 200, "unit_price": 1.45}\n' +
        '  ]\n}\n',
    },
    verifierPolicy: {
      requiredArtifacts: ['reconciliation.json'],
      command: 'python3 -m json.tool reconciliation.json',
    },
    maxSteps: 28,
    timeoutMs: 480_000,
  },

  // --- DevSecOps: dependency vulnerability audit + remediation ---------------
  'dep-audit': {
    id: 'dep-audit',
    title: 'DevSecOps agent — dependency vulnerability audit with objective gate',
    teaches:
      'A security workflow with a verifier that is itself a security control: the agent audits ' +
      'dependencies against advisories and produces a patched manifest, and completion is gated ' +
      'by a script that FAILS if any known-vulnerable version remains. The gate, not the model, ' +
      'certifies the fix.',
    instructions:
      'You are a security engineer. Only trust advisories.json for what is vulnerable. For each ' +
      'vulnerable package, bump it to the listed safe_version exactly. Do not change unaffected ' +
      'packages.',
    goal:
      'requirements.txt and advisories.json are in your workspace. ' +
      '1) Cross-check each pinned dependency against advisories.json. ' +
      '2) Write AUDIT.md listing each vulnerable package, its current version, the advisory id, ' +
      'and the safe version. ' +
      '3) Write requirements.fixed.txt identical to requirements.txt but with every vulnerable ' +
      'package bumped to its safe_version. ' +
      '4) Call run_complete with artifacts ["AUDIT.md", "requirements.fixed.txt"].',
    seedFiles: {
      'requirements.txt':
        'flask==2.0.1\nrequests==2.25.0\npyyaml==5.3.1\nurllib3==1.26.4\nclick==8.1.3\n',
      'advisories.json':
        '{\n  "advisories": [\n' +
        '    {"package": "flask",   "vulnerable": "2.0.1",  "id": "CVE-2023-30861", "safe_version": "2.3.2"},\n' +
        '    {"package": "pyyaml",  "vulnerable": "5.3.1",  "id": "CVE-2020-14343", "safe_version": "5.4"},\n' +
        '    {"package": "urllib3", "vulnerable": "1.26.4", "id": "CVE-2021-33503", "safe_version": "1.26.5"}\n' +
        '  ]\n}\n',
    },
    // Objective security gate: fail if any advisory-listed vulnerable version
    // is still pinned in the fixed manifest.
    verifierPolicy: {
      requiredArtifacts: ['AUDIT.md', 'requirements.fixed.txt'],
      command:
        'python3 -c "import json; adv=json.load(open(\'advisories.json\'))[\'advisories\']; ' +
        'reqs=open(\'requirements.fixed.txt\').read(); ' +
        'bad=[a for a in adv if a[\'package\']+\'==\'+a[\'vulnerable\'] in reqs]; ' +
        'print(\'remaining vulnerable:\', bad); exit(1 if bad else 0)"',
    },
    maxSteps: 30,
    timeoutMs: 540_000,
  },

  // --- Data engineering: messy-CSV cleaning with schema validation gate ------
  'etl-clean': {
    id: 'etl-clean',
    title: 'Data-engineering agent — messy CSV cleaning with schema gate',
    teaches:
      'Real ETL: the agent normalises a dirty real-world dataset (dupes, missing fields, ' +
      'inconsistent casing/dates) and emits a clean dataset plus a quality report, with a schema ' +
      'validation script as the objective completion gate.',
    instructions:
      'You are a data engineer. Use python3 (the csv module) for real transformations; do not ' +
      'hand-edit rows. Apply the cleaning rules exactly.',
    goal:
      'raw_customers.csv is in your workspace (columns: id,name,email,signup_date). Clean it: ' +
      '(a) drop rows missing id, name, or email; ' +
      '(b) lowercase all emails; ' +
      '(c) remove duplicate rows by email (keep the first); ' +
      '(d) normalise signup_date to YYYY-MM-DD (input may be D/M/YYYY or YYYY-MM-DD). ' +
      'Write clean_customers.csv (same columns) and quality_report.json ' +
      '{"rows_in":..,"rows_out":..,"dropped_missing":..,"duplicates_removed":..}. ' +
      'Then call run_complete with artifacts ["clean_customers.csv","quality_report.json"].',
    seedFiles: {
      'raw_customers.csv':
        'id,name,email,signup_date\n' +
        '1,Alice Tan,Alice.Tan@Example.com,2026-01-15\n' +
        '2,Bob Lee,bob@example.com,3/2/2026\n' +
        '3,,noname@example.com,2026-02-10\n' +
        '1,Alice Tan,alice.tan@example.com,2026-01-15\n' +
        '4,Carol Ng,,2026-02-20\n' +
        '5,Dan Ong,DAN@example.com,15/3/2026\n' +
        '2,Bob Lee,BOB@example.com,3/2/2026\n',
    },
    // Schema gate: clean file must parse, have the right header, and contain no
    // empty required fields or uppercase emails.
    verifierPolicy: {
      requiredArtifacts: ['clean_customers.csv', 'quality_report.json'],
      command:
        'python3 -c "import csv,json; ' +
        'rows=list(csv.DictReader(open(\'clean_customers.csv\'))); ' +
        'assert rows, \'no rows\'; ' +
        'assert set(rows[0].keys())>={\'id\',\'name\',\'email\',\'signup_date\'}, \'bad header\'; ' +
        'assert all(r[\'id\'] and r[\'name\'] and r[\'email\'] for r in rows), \'missing fields\'; ' +
        'assert all(r[\'email\']==r[\'email\'].lower() for r in rows), \'uppercase email\'; ' +
        'json.load(open(\'quality_report.json\')); print(\'schema ok\', len(rows), \'rows\')"',
    },
    maxSteps: 32,
    timeoutMs: 540_000,
  },
};
