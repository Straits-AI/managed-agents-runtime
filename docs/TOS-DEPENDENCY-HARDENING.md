# TOS dependency hardening

The runtime does not depend on `@volcengine/tos-sdk`. Version 2.9.1 was the
latest npm release when this boundary was reviewed on 2026-07-19, and it pulled
Axios 0.21/0.27 through both a direct dependency and `axios-adapter-uniapp`.
`npm audit` reported three high-severity production dependency findings and no
available package-manager fix.

The runtime needs only a small subset of TOS:

- put, get, head, and presign an object;
- head or create the configured bucket for provisioning; and
- delete the provisioning smoke-test object.

[`tosObjectStore.ts`](../src/providers/tosObjectStore.ts) now implements that
surface with native Node.js `fetch`, while
[`tosProtocol.ts`](../src/providers/tosProtocol.ts) owns the TOS4-HMAC-SHA256
wire contract. The signing fixtures were generated from the official
`volcengine/ve-tos-js-sdk` 2.9.1 implementation at repository commit
`5416f2019f5fe9efd4a8ca7838b281786c28aad9` and frozen in
[`tosObjectStore.test.ts`](../test/tosObjectStore.test.ts). They cover header
authentication, temporary session credentials, GET/PUT presigned URLs, bucket
operations, encoded object keys, and object deletion.

The replacement additionally enforces:

- HTTPS to a validated hostname-only endpoint;
- no redirects;
- a configurable 120-second default request timeout;
- a configurable default of three attempts for transport and transient HTTP failures;
- bounded 64 KiB error bodies and configurable 512 MiB default object reads; and
- structured status, TOS code, and request-ID errors.

The live conformance runner is the authoritative deployment check for
put/get/presign behavior. `scripts/provision-tos.ts` exercises bucket
head/create, direct put/get/head, presigned GET/PUT, a post-delete 404, and
verified cleanup of both disposable objects without reintroducing the SDK. It
emits a versioned record containing the exact source commit, adapter and package
version, runtime and protocol version, region, retrieval time, capabilities,
explicit untested/unsupported semantics, credential mode and source, bounded
provider error metadata, and redaction/cleanup assertions. It never includes
credential values, payload bytes, or presigned URLs.

Write evidence to a new operator-controlled file with:

```bash
node --env-file=.env --import tsx scripts/provision-tos.ts \
  --evidence-file /secure/path/tos-conformance.json
```

The destination is created with mode `0600` and is never overwritten. A run is
not current live-provider evidence until this command succeeds against the
target deployment and its record is retained with the release evidence. Unit
fixtures prove protocol compatibility but are not represented as current
live-provider evidence. Source runs require a clean Git worktree; packaged
builds set `CONFORMANCE_SOURCE_COMMIT` to their exact full revision. See
[`BYTEPLUS-PROVIDER-CONFORMANCE.md`](./BYTEPLUS-PROVIDER-CONFORMANCE.md).

## Dependency release policy

The controlled-alpha gate now runs:

```bash
npm audit --omit=dev --audit-level=high --json
```

It retains the machine-readable report and fails any unexcepted high or
critical production advisory. Missing or malformed audit structure, severity
inconsistency, unresolved dependency references, and abnormal process exits
also fail closed. Exit code 1 is accepted only when a complete valid report
shows that every finding is covered by the reviewed exception set. Exceptions live in
[`dependency-audit-exceptions.v1.json`](../release-gate/dependency-audit-exceptions.v1.json)
and must identify the exact advisory, package, and severity, plus an owner,
rationale, and UTC expiry date. Severity escalation invalidates the exception.
The file is frozen by a compiled SHA-256 baseline. Changing it is
therefore a reviewable release-policy change rather than an environment bypass.
Expired, stale, duplicate, malformed, or unreviewed exceptions fail closed.

The v1 exception set is empty.
