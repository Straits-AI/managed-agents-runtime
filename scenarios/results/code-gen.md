# Coding agent — implement a utility and pass its tests

**Scenario id:** `code-gen`  
**Teaches:** Objective verification: the agent writes code, and completion is gated on a real test command exiting 0 in the sandbox — not on the model claiming success.  
**Result:** COMPLETED in 32s  
**Model usage:** 5 calls, 8438 in / 827 out tokens

## Goal given to the agent

```
Implement a Python module roman.py with a function to_roman(n) that converts an integer 1..3999 to a Roman numeral string. A test file test_roman.py is already in your workspace — make it pass. Run `python3 -m unittest test_roman` yourself to check, then call run_complete with artifacts ["roman.py"].
```

## Seed files

`test_roman.py`:
```
import unittest
from roman import to_roman

class TestRoman(unittest.TestCase):
    def test_basic(self):
        cases = {1:'I',4:'IV',9:'IX',40:'XL',90:'XC',400:'CD',1994:'MCMXCIV',3999:'MMMCMXCIX'}
        for n, expected in cases.items():
            self.assertEqual(to_roman(n), expected)

if __name__ == '__main__':
    unittest.main()

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
| 20 | SandboxTerminated |

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
| SandboxTerminated | 1 |

## Attempts (execution epochs)

| state | sandbox | exit reason |
| --- | --- | --- |
| EXITED | vefaas-jsdzgnxi-0d9v4raq51-d9cqhdg07v3l4ko01dcg-sandbox | completed |

## Artifacts produced

### `roman.py`
```
def to_roman(n):
    roman_numerals = [
        (1000, 'M'),
        (900, 'CM'),
        (500, 'D'),
        (400, 'CD'),
        (100, 'C'),
        (90, 'XC'),
        (50, 'L'),
        (40, 'XL'),
        (10, 'X'),
        (9, 'IX'),
        (5, 'V'),
        (4, 'IV'),
        (1, 'I')
    ]
    result = []
    for value, symbol in roman_numerals:
        while n >= value:
            result.append(symbol)
            n -= value
        if n == 0:
            break
    return ''.join(result)

```
