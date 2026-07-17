# Data-engineering agent — messy CSV cleaning with schema gate

*Data pipelines with the data contract enforced automatically*

> **Result:** COMPLETED in 50s · 7 model calls · 0 governed external action(s) · model: Dola-Seed-2.0-lite

## The problem

Inbound data is messy — duplicates, missing fields, inconsistent casing and date formats. A cleaning agent is useful only if you can trust that its output actually conforms to your schema, every time.

## Why this needs a durable agent runtime

The agent transforms with real Python in the sandbox, and a schema-validation script is the completion gate: wrong header, empty required fields, or un-normalised values reject the run.

## The setup (what you give the runtime)

**System prompt (agent instructions):**
```
You are a data engineer. Use python3 (the csv module) for real transformations; do not hand-edit rows. Apply the cleaning rules exactly.
```

**Goal (the task message):**
```
raw_customers.csv is in your workspace (columns: id,name,email,signup_date). Clean it: (a) drop rows missing id, name, or email; (b) lowercase all emails; (c) remove duplicate rows by email (keep the first); (d) normalise signup_date to YYYY-MM-DD (input may be D/M/YYYY or YYYY-MM-DD). Write clean_customers.csv (same columns) and quality_report.json {"rows_in":..,"rows_out":..,"dropped_missing":..,"duplicates_removed":..}. Then call run_complete with artifacts ["clean_customers.csv","quality_report.json"].
```

**Seed files placed in the durable workspace:**

`raw_customers.csv`
```
id,name,email,signup_date
1,Alice Tan,Alice.Tan@Example.com,2026-01-15
2,Bob Lee,bob@example.com,3/2/2026
3,,noname@example.com,2026-02-10
1,Alice Tan,alice.tan@example.com,2026-01-15
4,Carol Ng,,2026-02-20
5,Dan Ong,DAN@example.com,15/3/2026
2,Bob Lee,BOB@example.com,3/2/2026
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
{"exit_code":0,"stdout":"total 12\ndrwxr-xr-x  2 gem gem 4096 Jul 17 12:13 .\ndrwxr-x--- 12 gem gem 4096 Jul 17 12:13 ..\n-rw-r--r--  1 gem gem  278 Jul 17 12:13 raw_customers.csv\n","stderr":""}
```

**Agent → tool call:** `file_read`
```json
{
  "path": "raw_customers.csv"
}
```

**Tool result:**
```
id,name,email,signup_date
1,Alice Tan,Alice.Tan@Example.com,2026-01-15
2,Bob Lee,bob@example.com,3/2/2026
3,,noname@example.com,2026-02-10
1,Alice Tan,alice.tan@example.com,2026-01-15
4,Carol Ng,,2026-02-20
5,Dan Ong,DAN@example.com,15/3/2026
2,Bob Lee,BOB@example.com,3/2/2026

```

**Agent → tool call:** `file_write`
```json
{
  "path": "clean_customers.py",
  "content": "import csv\nfrom datetime import datetime\nimport json\n\ndef main():\n    # Read input file\n    input_path = 'raw_customers.csv'\n    output_path = 'clean_customers.csv'\n    report_path = 'quality_report.json'\n    \n    rows_in = 0\n    rows = []\n    with open(input_path, 'r', newline='') as f:\n        reader = csv.DictReader(f)\n        for row in reader:\n            rows_in +=1\n            rows.append(row)\n    \n    # Step a: drop rows missing id, name, or email\n    dropped_missing = 0\n    valid_rows = []\n    for row in rows:\n        if not row['id'].strip() or not row['name'].strip() or not row['email'].strip():\n            dropped_missing +=1\n            continue\n        valid_rows.append(row)\n    \n    # Step b: lowercase all emails\n    for row in valid_rows:\n        row['email'] = row['email'].lower()\n    \n    # Step c: remove duplicates by email, keep first\n    seen_emails = set()\n    unique_rows = []\n    duplicates_removed =0\n    for row in valid_rows:\n        email = row['email']\n        if email in seen_emails:\n            duplicates_removed +=1\n            continue\n        seen_emails.add(email)\n        unique_rows.append(row)\n    \n    # Step d: normalize signup_date to YYYY-MM-DD\n    normalized_rows = []\n    for row in unique_rows:\n        date_str = row['signup_date'].strip()\n        # Try parsing both formats\n        try:\n            # First try YYYY-MM-DD\n            dt = datetime.strptime(date_str, '%Y-%m-%d')\n        except ValueError:\n            # Try D/M/YYYY\n            dt = datetime.strptime(date_str, '%d/%m/%Y')\n        row['signup_date'] = dt.strftime('%Y-%m-%d')\n        normalized_rows.append(row)\n    \n    # Write clean CSV\n    fieldnames = ['id', 'name', 'email', 'signup_date']\n    with open(output_path, 'w', newline='') as f:\n        writer = csv.DictWriter(f, fieldnames=fieldnames)\n        writer.writeheader()\n        for row in normalized_rows:\n            writer.writerow(row)\n    \n    rows_out = len(normalized_rows)\n    # Write quality report\n    report = {\n        \"rows_in\": rows_in,\n        \"rows_out\": rows_out,\n        \"dropped_missing\": dropped_missing,\n        \"duplicates_removed\": duplicates_removed\n    }\n    with open(report_path, 'w') as f:\n        json.dump(report, f, indent=2)\n    \n    print(f\"Processing complete. Rows in: {rows_in}, Rows out: {rows_out}, Dropped missing: {dropped_missing}, Duplicates removed: {duplicates_removed}\")\n\nif __name__ == \"__main__\":\n    main()\n"
}
```

**Tool result:**
```
wrote clean_customers.py
```

**Agent → tool call:** `bash_exec`
```json
{
  "command": "cd /home/gem/workspace && python3 clean_customers.py"
}
```

**Tool result:**
```
{"exit_code":0,"stdout":"Processing complete. Rows in: 7, Rows out: 3, Dropped missing: 2, Duplicates removed: 2\n","stderr":""}
```

**Agent → tool call:** `file_read`
```json
{
  "path": "clean_customers.csv"
}
```

**Tool result:**
```
id,name,email,signup_date
1,Alice Tan,alice.tan@example.com,2026-01-15
2,Bob Lee,bob@example.com,2026-02-03
5,Dan Ong,dan@example.com,2026-03-15

```

## The verified output

**`clean_customers.csv`:**
```
id,name,email,signup_date
1,Alice Tan,alice.tan@example.com,2026-01-15
2,Bob Lee,bob@example.com,2026-02-03
5,Dan Ong,dan@example.com,2026-03-15

```

**`quality_report.json`:**
```
{
  "rows_in": 7,
  "rows_out": 3,
  "dropped_missing": 2,
  "duplicates_removed": 2
}
```

## Takeaway

The agent deduplicated, dropped incomplete rows, and normalised emails and dates — and the schema gate proved the cleaned dataset honours the contract before it is ever accepted.

---

*Reproduce: `node --env-file=.env --import tsx scenarios/run.ts etl-clean`. Full event timeline: [`scenarios/results/etl-clean.md`](../../scenarios/results/etl-clean.md).*