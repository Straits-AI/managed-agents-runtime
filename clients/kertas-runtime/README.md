# Kertas runtime contract compatibility client

This deliberately small client discovers the managed runtime through
authenticated HTTP and chooses either the real `kertas.runtime/v1alpha1`
ManagedSession contract or the temporary `run-as-session/v1` compatibility
contract. It has no runtime storage, migration, scheduler, or harness imports.

The package is a conformance fixture for both compatibility and active
ManagedSession modes. `plannedContracts` are informational; selection considers
only advertised supported contracts and their feature flags. Missing newer
feature flags normalize to `false`, so an older compatibility deployment remains
discoverable instead of being mistaken for target support.

The client also exposes the public ManagedSession, Run event, artifact, and
bounded child-result projections needed by Kertas. Its boundary check rejects
imports from runtime stores, migrations, tests, or other internal modules.

`npm run kertas:conformance` proves the integration against an independently
deployed runtime image. API, worker, PostgreSQL, and the compiled standalone
client run in separate containers on an isolated Docker network. The client
uses a non-loopback service endpoint and two tenant-scoped API keys, exercises
both `kertas.runtime/v1alpha1` and `run-as-session/v1`, and retains a redacted,
digest-bound receipt under `release-evidence/kertas-conformance/`. A terminal
Run is recorded only as an execution disposition; it never becomes a Kertas
Outcome or Release decision.
