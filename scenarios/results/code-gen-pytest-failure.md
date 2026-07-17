# Coding agent — implement a utility and pass its tests

**Scenario id:** `code-gen`  
**Teaches:** Objective verification: the agent writes code, and completion is gated on a real test command exiting 0 in the sandbox — not on the model claiming success.  
**Result:** FAILED in 74s  
**Model usage:** 15 calls, 39704 in / 2263 out tokens

## Goal given to the agent

```
Implement a Python module roman.py with a function to_roman(n) that converts an integer 1..3999 to a Roman numeral string. A test file test_roman.py is already in your workspace — make it pass. Run `python3 -m pytest -q` yourself to check, then call run_complete with artifacts ["roman.py"].
```

## Seed files

`test_roman.py`:
```
from roman import to_roman

def test_basic():
    assert to_roman(1) == 'I'
    assert to_roman(4) == 'IV'
    assert to_roman(9) == 'IX'
    assert to_roman(40) == 'XL'
    assert to_roman(90) == 'XC'
    assert to_roman(400) == 'CD'
    assert to_roman(1994) == 'MCMXCIV'
    assert to_roman(3999) == 'MMMCMXCIX'

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
| 22 | ModelInvocationStarted |
| 23 | ModelInvocationCompleted |
| 24 | ModelInvocationStarted |
| 25 | ModelInvocationCompleted |
| 26 | VerificationStarted |
| 27 | VerificationFailed |
| 28 | ModelInvocationStarted |
| 29 | ModelInvocationCompleted |
| 30 | WorkspaceCheckpointed |
| 31 | ModelInvocationStarted |
| 32 | ModelInvocationCompleted |
| 33 | ModelInvocationStarted |
| 34 | ModelInvocationCompleted |
| 35 | VerificationStarted |
| 36 | VerificationFailed |
| 37 | ModelInvocationStarted |
| 38 | ModelInvocationCompleted |
| 39 | ModelInvocationStarted |
| 40 | ModelInvocationCompleted |
| 41 | ModelInvocationStarted |
| 42 | ModelInvocationCompleted |
| 43 | VerificationStarted |
| 44 | VerificationFailed |
| 45 | RunFailed |
| 46 | SandboxTerminated |

## Event summary

| event | count |
| --- | --- |
| ModelInvocationStarted | 15 |
| ModelInvocationCompleted | 15 |
| VerificationStarted | 3 |
| VerificationFailed | 3 |
| AttemptStarted | 2 |
| WorkspaceCheckpointed | 2 |
| RunCreated | 1 |
| RunQueued | 1 |
| SandboxAllocated | 1 |
| WorkspaceRestored | 1 |
| RunFailed | 1 |
| SandboxTerminated | 1 |

## Attempts (execution epochs)

| state | sandbox | exit reason |
| --- | --- | --- |
| ACTIVE | vefaas-jsdzgnxi-0d9v4raq51-d9cqg900d2stlmo028dg-sandbox | - |
