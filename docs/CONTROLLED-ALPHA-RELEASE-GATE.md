# Controlled multi-tenant alpha release gate

The controlled multi-tenant alpha is admitted by one versioned command:

```bash
npm run release:gate
```

The command is not a shorthand for “the tests looked green.” It audits
production dependencies, runs TypeScript checking and the complete Vitest
integration suite, then validates the emitted
Vitest JSON against
[`controlled-multitenant-alpha.v1.json`](../release-gate/controlled-multitenant-alpha.v1.json).
That manifest names the tests that must continue to prove:

- fail-closed shared configuration;
- two-tenant delegation and negative authorization cases;
- atomic admission and concurrent capacity enforcement;
- tenant-owned knowledge bindings;
- governed HTTP and MCP reads and mutations;
- execution-scoped credentials;
- concurrency fencing; and
- crashes before dispatch, after remote commit, and after local receipt commit.

Renaming, deleting, skipping, or failing a critical assertion fails the gate even
if the rest of Vitest succeeds. Pending, skipped, or todo tests also fail. The
v1 manifest is frozen by an expected SHA-256 digest and assertion count, and the
full suite cannot fall below its reviewed minimum test count, so shrinking
coverage cannot self-attest as an equivalent v1 gate. A future manifest revision
must update that reviewed baseline explicitly.

The dependency step fails high or critical production advisories unless an
exact advisory/package/severity tuple has a reviewed, owned, reasoned, unexpired entry in
the frozen exception registry. It validates audit schema, severity propagation,
metadata consistency, and process completion before applying those exceptions.
The v1 registry is empty. See
[`TOS-DEPENDENCY-HARDENING.md`](./TOS-DEPENDENCY-HARDENING.md).

## Clean local run

Use a clean checkout, Node.js 22, npm's committed lockfile, and PostgreSQL 16:

```bash
git clone https://github.com/Straits-AI/managed-agents-runtime.git
cd managed-agents-runtime
npm ci
docker compose up -d postgres
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres \
  npm run release:gate -- --evidence-dir release-evidence/local
```

The gate refuses tracked or untracked source changes by default because evidence without an
identifiable source revision is not release evidence. During development only,
`--allow-dirty` permits a non-release run recorded as `dry-run-passed`; it can
never emit release status `passed`.

## Evidence

Each run retains:

```text
release-evidence/<run>/
├── summary.json
├── manifest.snapshot.json
├── dependency-audit-exceptions.snapshot.json
├── dependency-audit.json
├── dependency-audit.stdout.log
├── dependency-audit.stderr.log
├── vitest.json
├── typecheck.stdout.log
├── typecheck.stderr.log
├── vitest.stdout.log
└── vitest.stderr.log
```

`summary.json` records the gate version, result, exact commit, runtime, step exit
codes, dependency findings and exceptions, every critical assertion,
provider-surface policy, limitations, and SHA-256 digests for policy and test
evidence. The child processes receive
a minimal environment without cloud/provider credentials, and every retained
diagnostic and Vitest string is redacted before upload. The summary records only
the database variable name, never connection strings or credentials. When CI
supplies `RELEASE_GATE_COMMIT`, the gate rejects evidence unless that value
matches the checked-out Git object.

Missing or malformed manifests still produce a failed `summary.json`; a broken
gate definition is retained as evidence rather than disappearing before the
artifact step.

The GitHub workflow runs the same command with a clean dependency install and a
fresh PostgreSQL service. It uploads the evidence directory even when the gate
fails, retaining the artifact for 30 days.

## Provider boundary and limitations

This gate certifies the kernel's controlled multi-tenant boundary against local
provider contracts. It does not silently convert historical cloud smoke tests
into current live conformance evidence.

- AgentKit Knowledge stays disabled in shared deployments until the deployment
  attestation and each tenant binding have passed live verification.
- Shared HTTP egress requires an allowlist or controlled proxy.
- Harness fault injection is prohibited in production or on an exposed API.
- MCP tools without a valid read/mutation and recovery policy are not exposed.
- Exactly-once mutation recovery is claimed only when the remote provider
  honors the idempotency key or supports authoritative reconciliation.

Passing this gate establishes the **controlled multi-tenant alpha** boundary.
It does not establish public-beta or production readiness. The P1 risk register,
live provider conformance, operational review, and explicit release approval
remain separate gates.
