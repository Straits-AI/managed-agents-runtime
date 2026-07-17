# Document processing agent — extract structured data from prose

**Scenario id:** `doc-processing`  
**Teaches:** A non-code knowledge-work domain: the agent reads an unstructured document from the workspace and produces a structured artifact (JSON), showing the runtime is workload-agnostic.  
**Result:** COMPLETED in 38s  
**Model usage:** 4 calls, 6163 in / 865 out tokens

## Goal given to the agent

```
Read meeting-notes.txt from your workspace. Extract every action item into actions.json as a JSON array of objects with keys "owner", "task", and "due". Validate it parses (e.g. with python3 -m json.tool), then call run_complete with artifacts ["actions.json"].
```

## Seed files

`meeting-notes.txt`:
```
Project sync — 14 July 2026

Attendees: Wei, Hana, Jayden.

Discussion: launch is slipping. We agreed on the following.
- Wei will finalise the pricing page by Friday.
- Hana to send the updated contract to legal by 18 July.
- Jayden owns migrating the database; target end of month.
Next sync: 21 July.

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
| 15 | VerificationStarted |
| 16 | WorkspaceCheckpointed |
| 17 | RunCompleted |
| 18 | SandboxTerminated |

## Event summary

| event | count |
| --- | --- |
| ModelInvocationStarted | 4 |
| ModelInvocationCompleted | 4 |
| AttemptStarted | 2 |
| RunCreated | 1 |
| RunQueued | 1 |
| SandboxAllocated | 1 |
| WorkspaceRestored | 1 |
| VerificationStarted | 1 |
| WorkspaceCheckpointed | 1 |
| RunCompleted | 1 |
| SandboxTerminated | 1 |

## Attempts (execution epochs)

| state | sandbox | exit reason |
| --- | --- | --- |
| EXITED | vefaas-jsdzgnxi-0d9v4raq51-d9cqibg0d2stlmo028fg-sandbox | completed |

## Artifacts produced

### `actions.json`
```
[{"owner": "Wei", "task": "finalise the pricing page", "due": "Friday"}, {"owner": "Hana", "task": "send the updated contract to legal", "due": "18 July"}, {"owner": "Jayden", "task": "migrating the database", "due": "end of month"}]
```
