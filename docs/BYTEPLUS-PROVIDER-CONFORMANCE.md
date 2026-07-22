# BytePlus provider conformance

This matrix is the current claim boundary for BytePlus adapters. Historical
scenario runs demonstrate that a stack worked at a point in time; they do not
attest a changed adapter, tool version, API surface, region, or deployment.

## Current matrix

<!-- byteplus-conformance-matrix:start -->
| Capability | Classification | Current evidence | Shared-deployment claim |
| --- | --- | --- | --- |
| TOS object storage | `verified` | byteplus-tos-attestation-56861a83-c502-4814-a17a-ba7e60d3661a at `e2665c98cb14` | Verified for the bounded object operations named in the retained record |
| ModelArk inference | `verified` | byteplus-modelark-021784694981398d82d61e1341a38f1d55b18f5893f198bb3a585 at `7c2526d9648a` | Verified for one bounded activated preset-model chat invocation |
| veFaaS private Cloud Sandbox | `verified` | byteplus-runtime-sandbox-runtime-903655c at `903655c21fee` | Verified for one bounded private CPU sandbox lifecycle with exact cleanup |
| AgentKit Memory | `unavailable` | No release-current live record | No release-current adapter/version record; do not present as currently verified |
| AgentKit Knowledge | `unavailable` | No release-current live record | Fail-closed in shared deployments until deployment and tenant bindings are attested |
| Skills and MCP | `local-only` | No release-current live record | Local registry semantics only; no BytePlus-hosted Skills or MCP claim |
| Message Queue for Kafka | `unavailable` | No release-current live record | No release-current cluster/API-version record; do not present as currently verified |
| KMS credential cipher | `unavailable` | No release-current live record | No release-current key/API-version record; do not present as currently verified |
<!-- byteplus-conformance-matrix:end -->

The machine-readable source is
[`provider-conformance/byteplus.v1.json`](../provider-conformance/byteplus.v1.json).
`npm run provider:claims` validates this table and the README against that
manifest, rejects blanket claims in the README and usage guide, binds the
manifest to `package.json`, and hashes every retained receipt. A `verified` row
is limited to the named evidence and limitations; it
does not promote every operation offered by the product.

This document records status, not secrets or live resource inventory. Sanitized,
reviewed receipts are retained under `provider-conformance/evidence/`; raw
operator records remain private when they contain non-public resource metadata.

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
of both disposable objects. The configured bucket is retained. The committed
TOS attestation names the private raw-record hash and content-hashes every
adapter/runner source file; the claim checker withdraws continuity if any of
those files changes.

## ModelArk record generation

The ModelArk runner requires an actual endpoint resource for temporary-key
issuance. A public preset model identifier is not interchangeable with that
resource ID:

```bash
node --import tsx scripts/conformance-modelark.ts \
  --profile dev \
  --region ap-southeast-1 \
  --model seed-2-0-mini-260428 \
  --negative-model seed-2-0-lite-260228 \
  --expected-failure-code ModelNotOpen \
  --resource-type presetendpoint \
  --project-name default \
  --evidence-file /secure/path/modelark-conformance.json
```

For a provisioned inference endpoint, use `--resource-type endpoint` and its
`ep-...` identifier instead; the project field is omitted from that key request.
The two temporary keys and model output remain in memory. The evidence contains
only bounded request, token, finish, source, key-scope, expected-failure, and
redaction metadata. The negative probe fails closed if the model becomes
available or returns a different error code.
For `presetendpoint`, the positive and negative key-resource IDs must equal the
respective invoked model IDs. For an `endpoint`, pass explicit
`--key-resource-id` and `--negative-key-resource-id`; both bindings are retained
in the sanitized record.

## Private sandbox record generation

The private workflow creates or reuses one exact, released CPU sandbox
application, invokes the production `VefaasSandboxProvider` through an OAuth-backed
`bp` lifecycle adapter with one short-lived 1-vCPU/2-GiB instance, and removes the
explicitly disposable application as the verified post-kill cascade. The signed
WebShell endpoint remains only inside the credential-isolating process. Successful
provider calls retain only bounded action and request-ID metadata. Because the
`bp` structured-body channel is transported through process arguments, this
adapter rejects all per-run environment values before invoking `bp`; runtime
secrets require a separate credential-isolating provider channel:

```bash
npm run byteplus:sandbox:provision -- \
  --profile dev --region ap-southeast-1 \
  --name managed-agents-runtime-private-<date> \
  --evidence-file /secure/path/sandbox-provisioning.json

npm run byteplus:sandbox:conformance -- \
  --profile dev --region ap-southeast-1 \
  --function-id <released-sandbox-function-id> \
  --application-name managed-agents-runtime-private-<date> \
  --run-id <non-secret-run-id> \
  --evidence-file /secure/path/sandbox-runtime.json

npm run byteplus:sandbox:cleanup -- \
  --profile dev --region ap-southeast-1 \
  --function-id <released-sandbox-function-id> \
  --name managed-agents-runtime-private-<date> \
  --evidence-file /secure/path/sandbox-cleanup.json
```

The application uses BytePlus's documented minimum `MaxConcurrency` of 10 but
releases with `MaxInstance: 1`; this permits no more than one warm application
instance. Before any cloud call, provisioning reserves an owner-only pending
receipt containing the unique attempt ID used as an application tag. Final
success or sanitized failure evidence replaces that receipt atomically.
BytePlus may omit default CPU allocation, empty environment variables, and a
disabled VPC from application/revision readback; omission is accepted only for
those canonical defaults, while any returned conflicting value fails closed.
After a release completes, `GetReleaseStatus` may also omit the transient
release-record ID; reuse still requires `Status: done`, a positive stable
revision, and full application plus revision configuration readback.
The released image is the exact pre-cached SandboxFusion image using its
documented `bash /root/sandbox/scripts/run.sh`, port 8080, and
`HOME=/home/tiger` contract. Current pre-cached All-in-one images were rejected
after live startup showed their `/opt/gem/run.sh` exiting on an invalid
`/etc/sudoers.d/` redirection. Runtime conformance also reserves a pending
receipt before creation. If creation fails after BytePlus allocates an instance,
the provider inventories by the exact run metadata, kills only those instances,
verifies their absence, and records a sanitized failure receipt.
Application cleanup reserves its owner-only evidence destination before its first
cloud call. It normally requires an empty child inventory. For an exact disposable
application it also permits the documented cascading `DeleteFunction` path only
when every returned child belongs to the target function and is already
`Terminating`; any active non-terminating, unknown, paginated, or cross-function
child fails closed. Fresh function-inventory absence is then required.
Runtime termination does not treat the provider's post-kill `Terminating` state
as completion. A reusable application polls `DescribeSandbox` and an exact
`SandboxId` inventory until `Terminated`, `Deleted`, `ResourceNotFound`, or complete
exact absence and otherwise fails closed. The live conformance application is
instead explicitly disposable: after kill acceptance and exact `Terminating`-only
inventory, its injected cleanup hook uses the documented cascading function delete
and requires fresh function absence before the provider can observe `Deleted`.
Transient private-WebShell failures are retried only for idempotent workspace
and file operations. File chunks use fixed byte offsets so an uncertain retry
cannot duplicate content; arbitrary shell commands are never retried.

This proves private WebShell execution, not public HTTP. It does not create or
use an API Gateway route. Provisioning omits `InstanceType`, verifies the draft
as CPU-only before release, and refuses to adopt a differing exact-name
application. The runtime record must show successful request IDs for create,
describe, WebShell lease, kill, and final inventory. Cleanup refuses to delete
an application with active non-terminating instances or a mismatched ID/name pair.

## Promotion rule

A matrix row moves from local or unavailable to current live conformance only
when:

1. the release candidate passes the repository release gate;
2. an exact clean source revision produces the bounded live record in the
   target region;
3. the sanitized receipt is committed and hash-checked, or a sanitized
   attestation binds a private raw-record hash to unchanged source-file hashes;
4. provider-focused review passes; and
5. the tracking issue or release evidence links the retained record.

If any adapter, protocol, CLI/tool, provider API, permission boundary, or target
region changes, the row returns to pending until rerun.
