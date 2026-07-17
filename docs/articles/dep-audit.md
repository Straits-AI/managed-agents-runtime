# DevSecOps agent — dependency vulnerability audit with objective gate

*DevSecOps where the verifier is itself a security control*

> **Result:** COMPLETED in 43s · 8 model calls · 0 governed external action(s) · model: Dola-Seed-2.0-lite

## The problem

Dependency remediation is easy to get subtly wrong: bump the wrong package, miss one, or declare success while a vulnerable version is still pinned. "The agent said it fixed it" is not an acceptable security posture.

## Why this needs a durable agent runtime

The completion gate is a script that fails if *any* advisory-listed vulnerable version remains in the patched manifest. The run can only reach COMPLETED if that script passes — so the runtime, not the model, certifies the fix.

## The setup (what you give the runtime)

**System prompt (agent instructions):**
```
You are a security engineer. Only trust advisories.json for what is vulnerable. For each vulnerable package, bump it to the listed safe_version exactly. Do not change unaffected packages.
```

**Goal (the task message):**
```
requirements.txt and advisories.json are in your workspace. 1) Cross-check each pinned dependency against advisories.json. 2) Write AUDIT.md listing each vulnerable package, its current version, the advisory id, and the safe version. 3) Write requirements.fixed.txt identical to requirements.txt but with every vulnerable package bumped to its safe_version. 4) Call run_complete with artifacts ["AUDIT.md", "requirements.fixed.txt"].
```

**Seed files placed in the durable workspace:**

`requirements.txt`
```
flask==2.0.1
requests==2.25.0
pyyaml==5.3.1
urllib3==1.26.4
click==8.1.3
```

`advisories.json`
```
{
  "advisories": [
    {"package": "flask",   "vulnerable": "2.0.1",  "id": "CVE-2023-30861", "safe_version": "2.3.2"},
    {"package": "pyyaml",  "vulnerable": "5.3.1",  "id": "CVE-2020-14343", "safe_version": "5.4"},
    {"package": "urllib3", "vulnerable": "1.26.4", "id": "CVE-2021-33503", "safe_version": "1.26.5"}
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
{"exit_code":0,"stdout":"total 16\ndrwxr-xr-x  2 gem gem 4096 Jul 17 12:12 .\ndrwxr-x--- 12 gem gem 4096 Jul 17 12:12 ..\n-rw-r--r--  1 gem gem  327 Jul 17 12:12 advisories.json\n-rw-r--r--  1 gem gem   73 Jul 17 12:12 requirements.txt\n","stderr":""}
```

**Agent → tool call:** `file_read`
```json
{
  "path": "requirements.txt"
}
```

**Tool result:**
```
flask==2.0.1
requests==2.25.0
pyyaml==5.3.1
urllib3==1.26.4
click==8.1.3

```

**Agent → tool call:** `file_read`
```json
{
  "path": "advisories.json"
}
```

**Tool result:**
```
{
  "advisories": [
    {"package": "flask",   "vulnerable": "2.0.1",  "id": "CVE-2023-30861", "safe_version": "2.3.2"},
    {"package": "pyyaml",  "vulnerable": "5.3.1",  "id": "CVE-2020-14343", "safe_version": "5.4"},
    {"package": "urllib3", "vulnerable": "1.26.4", "id": "CVE-2021-33503", "safe_version": "1.26.5"}
  ]
}

```

**Agent → tool call:** `file_write`
```json
{
  "path": "AUDIT.md",
  "content": "# Dependency Audit Results\n\nThis document lists vulnerable dependencies found in requirements.txt, along with their recommended fixes.\n\n| Package   | Current Version | Advisory ID       | Safe Version |\n|-----------|-----------------|-------------------|--------------|\n| flask     | 2.0.1           | CVE-2023-30861    | 2.3.2        |\n| pyyaml     | 5.3.1           | CVE-2020-14343    | 5.4          |\n| urllib3    | 1.26.4          | CVE-2021-33503    | 1.26.5       |\n"
}
```

**Tool result:**
```
wrote AUDIT.md
```

**Agent → tool call:** `file_write`
```json
{
  "path": "requirements.fixed.txt",
  "content": "flask==2.3.2\nrequests==2.25.0\npyyaml==5.4\nurllib3==1.26.5\nclick==8.1.3\n"
}
```

**Tool result:**
```
wrote requirements.fixed.txt
```

## The verified output

**`AUDIT.md`:**
```
# Dependency Audit Results

This document lists vulnerable dependencies found in requirements.txt, along with their recommended fixes.

| Package   | Current Version | Advisory ID       | Safe Version |
|-----------|-----------------|-------------------|--------------|
| flask     | 2.0.1           | CVE-2023-30861    | 2.3.2        |
| pyyaml     | 5.3.1           | CVE-2020-14343    | 5.4          |
| urllib3    | 1.26.4          | CVE-2021-33503    | 1.26.5       |

```

**`requirements.fixed.txt`:**
```
flask==2.3.2
requests==2.25.0
pyyaml==5.4
urllib3==1.26.5
click==8.1.3

```

## Takeaway

The agent patched exactly the vulnerable packages and left the rest alone, and the security gate independently confirmed no vulnerable version survived. Objective verification turns an agent into an auditable control.

---

*Reproduce: `node --env-file=.env --import tsx scenarios/run.ts dep-audit`. Full event timeline: [`scenarios/results/dep-audit.md`](../../scenarios/results/dep-audit.md).*