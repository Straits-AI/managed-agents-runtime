# Data analysis agent — CSV to summary report

**Scenario id:** `data-analysis`  
**Teaches:** The core loop: seed data into the durable workspace, let the agent compute with real tools (python/bash), verify a required artifact exists, and retrieve it from TOS.  
**Result:** COMPLETED in 41s  
**Model usage:** 5 calls, 8329 in / 1263 out tokens

## Goal given to the agent

```
The file sales.csv (columns: region,month,amount) is in your workspace. 1) Compute total revenue, revenue per region, and the single best month by total revenue. 2) Write REPORT.md with those figures clearly labelled. 3) Call run_complete with artifacts ["REPORT.md"].
```

## Seed files

`sales.csv`:
```
region,month,amount
APAC,Jan,1200
APAC,Feb,1500
APAC,Mar,1800
EMEA,Jan,900
EMEA,Feb,1100
EMEA,Mar,1300
AMER,Jan,2000
AMER,Feb,1700
AMER,Mar,2100

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
| 17 | VerificationStarted |
| 18 | WorkspaceCheckpointed |
| 19 | RunCompleted |

## Event summary

| event | count |
| --- | --- |
| ModelInvocationStarted | 5 |
| ModelInvocationCompleted | 5 |
| AttemptStarted | 2 |
| RunCreated | 1 |
| RunQueued | 1 |
| SandboxAllocated | 1 |
| WorkspaceRestored | 1 |
| VerificationStarted | 1 |
| WorkspaceCheckpointed | 1 |
| RunCompleted | 1 |

## Attempts (execution epochs)

| state | sandbox | exit reason |
| --- | --- | --- |
| ACTIVE | vefaas-jsdzgnxi-0d9v4raq51-d9cqfn807v3l4ko01dc0-sandbox | - |

## Artifacts produced

### `REPORT.md`
```
# Sales Report

## Total Revenue
The total revenue across all regions and months is **$13,600**.

## Revenue by Region
- AMER: $5,800
- APAC: $4,500
- EMEA: $3,300

## Best Month by Total Revenue
The single best month by total revenue is **March**, with a total revenue of $5,200.
```
