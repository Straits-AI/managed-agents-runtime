# BytePlus provider conformance

This matrix is the current claim boundary for BytePlus adapters. Historical
scenario runs demonstrate that a stack worked at a point in time; they do not
attest a changed adapter, tool version, API surface, region, or deployment.

## Current matrix

| Capability | Implementation | Current evidence | Shared-deployment claim |
| --- | --- | --- | --- |
| TOS object storage | `TosObjectStore` plus `scripts/provision-tos.ts` | Automated direct and presigned runner is unit-tested locally; a fresh live record is pending operator authentication | Blocked until the live record is retained |
| ModelArk inference | `ModelArkModel` plus `scripts/conformance-modelark.ts` | Bounded temporary-key runner is locally gated; live inference requires a current endpoint resource ID | Historical demonstration only |
| veFaaS Cloud Sandbox | `VefaasSandbox` plus private WebShell transport and `scripts/conformance-sandbox.ts` | Private lifecycle, fixed marker/file operations, secret isolation, and cleanup are locally gated; a fresh released sandbox application is required for live evidence | Historical demonstration only |
| AgentKit Memory | `AgentKitMemory` | Historical write/extract/recall result only; current adapter-version record pending | Historical demonstration only |
| AgentKit Knowledge | `AgentKitKnowledge` | No current shared-deployment isolation attestation | Fail-closed unless `AGENTKIT_KNOWLEDGE_LIVE_VERIFIED=1` for that deployment |
| Skills and MCP | Registry implementations and adapter seams | Local contract evidence; no BytePlus-hosted Skills/MCP claim | Local/registry semantics only |
| Message Queue for Kafka | `KafkaEventPublisher` | Historical provision/publish/consume/cleanup result only; current rerun pending | Historical demonstration only |
| KMS credential cipher | `KmsCipher` | Historical encrypt/decrypt result only; current key/API-version rerun pending | Historical demonstration only |

This document records status, not secrets or live resource inventory. Operator
evidence must be retained outside the repository unless its resource metadata
has been reviewed for publication.

## Required evidence record

Every provider capability promoted to current live conformance must record:

- the full source commit and adapter/package version;
- runtime, CLI/tool, and provider API or protocol version;
- target provider, region, retrieval time, and non-secret resource identity;
- exact capability names and explicit unsupported semantics;
- control-plane, data-plane, and expected-failure observations;
- credential and output-redaction boundaries;
- cleanup verification for every disposable resource; and
- a stable evidence ID linked from the release or provider issue.

Successful process exit alone is insufficient. Evidence must show the expected
result and cleanup, and it must not serialize credentials, request payloads,
authorization headers, session tokens, presigned URLs, or unbounded provider
errors.

## Authentication boundary

Interactive OAuth is performed by the operator in a normal host browser. The
runtime and its validation containers are non-interactive consumers of
explicitly granted short-lived credentials; they do not own the browser login
or callback flow. Credentials are never copied into repository evidence.

## TOS record generation

The TOS runner is the first adapter using the complete record contract:

```bash
python3 scripts/refresh-creds.py
node --env-file=.env --import tsx scripts/provision-tos.ts \
  --evidence-file /secure/path/tos-conformance.json
```

The output includes direct PUT/GET/HEAD, presigned GET/PUT with 60-second URLs,
an expected post-delete 404 with bounded code/request ID, and confirmed absence
of both disposable objects. The configured bucket is retained.

## ModelArk record generation

The ModelArk runner requires an actual endpoint resource for temporary-key
issuance. A public preset model identifier is not interchangeable with that
resource ID:

```bash
node --import tsx scripts/conformance-modelark.ts \
  --profile dev \
  --region ap-southeast-1 \
  --model seed-2-0-lite-260228 \
  --resource-type endpoint \
  --key-resource-id ep-... \
  --evidence-file /secure/path/modelark-conformance.json
```

The temporary key and model output remain in memory. The evidence contains only
bounded request, token, finish, source, and redaction metadata.

## Private sandbox record generation

The private runner requires a released sandbox application and creates one
short-lived 1-vCPU/2-GiB instance. It uses the ticketed WebShell endpoint only
inside the credential-isolating Node process, executes fixed marker operations,
verifies the instance configuration and file round-trip, then kills the instance:

```bash
node --import tsx scripts/conformance-sandbox.ts \
  --profile dev \
  --region ap-southeast-1 \
  --function-id <released-sandbox-function-id> \
  --run-id <non-secret-run-id> \
  --evidence-file /secure/path/sandbox-conformance.json
```

This proves private WebShell execution, not public HTTP. It does not create or
use an API Gateway route. The application is an explicit input and is retained;
the disposable sandbox instance is the runner's cleanup responsibility.

## Promotion rule

A matrix row moves from historical or local evidence to current live
conformance only in the same exact source revision that:

1. passes the repository release gate;
2. produces the bounded live record in the target region;
3. receives provider-focused review; and
4. links the retained record from the tracking issue or release evidence.

If any adapter, protocol, CLI/tool, provider API, permission boundary, or target
region changes, the row returns to pending until rerun.
