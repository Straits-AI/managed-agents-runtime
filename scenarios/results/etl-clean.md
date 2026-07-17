# Data-engineering agent — messy CSV cleaning with schema gate

**Scenario id:** `etl-clean`  
**Teaches:** Real ETL: the agent normalises a dirty real-world dataset (dupes, missing fields, inconsistent casing/dates) and emits a clean dataset plus a quality report, with a schema validation script as the objective completion gate.  
**Result:** COMPLETED in 50s  
**Model usage:** 7 calls, 15336 in / 1893 out tokens

## Goal given to the agent

```
raw_customers.csv is in your workspace (columns: id,name,email,signup_date). Clean it: (a) drop rows missing id, name, or email; (b) lowercase all emails; (c) remove duplicate rows by email (keep the first); (d) normalise signup_date to YYYY-MM-DD (input may be D/M/YYYY or YYYY-MM-DD). Write clean_customers.csv (same columns) and quality_report.json {"rows_in":..,"rows_out":..,"dropped_missing":..,"duplicates_removed":..}. Then call run_complete with artifacts ["clean_customers.csv","quality_report.json"].
```

## Seed files

`raw_customers.csv`:
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
| 25 | SandboxTerminated |

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
| SandboxTerminated | 1 |

## Attempts (execution epochs)

| state | sandbox | exit reason |
| --- | --- | --- |
| EXITED | vefaas-jsdzgnxi-0d9v4raq51-d9cqno80d2stlmo028gg-sandbox | completed |

## Artifacts produced

### `clean_customers.csv`
```
id,name,email,signup_date
1,Alice Tan,alice.tan@example.com,2026-01-15
2,Bob Lee,bob@example.com,2026-02-03
5,Dan Ong,dan@example.com,2026-03-15

```

### `quality_report.json`
```
{
  "rows_in": 7,
  "rows_out": 3,
  "dropped_missing": 2,
  "duplicates_removed": 2
}
```
