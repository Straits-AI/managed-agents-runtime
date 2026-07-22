# Controlled-alpha deployment and rollback

**Applies to:** `v0.1.0-alpha.1`

**Release level:** controlled multi-tenant alpha

**Image:** `ghcr.io/straits-ai/managed-agents-runtime:v0.1.0-alpha.1`

This runbook defines the deployable image contract. Passing it does not establish
live provider conformance, public-beta readiness, or production approval.

## Immutable inputs

The release image is built from:

- an exact Git tag and commit;
- `node:22.23.0-bookworm-slim` pinned by multi-platform manifest digest;
- dependencies installed by `npm ci` from the committed lockfile;
- compiled JavaScript produced by the pinned TypeScript dependency; and
- migration files copied from the tagged source.

The tag workflow also pins the Dockerfile frontend, BuildKit builder image,
SBOM scanner, and PostgreSQL smoke dependency by digest. The hosted runner and
Buildx client versions are recorded by workflow logs and provenance.

The release workflow first pushes a commit-scoped candidate Linux `amd64`
manifest with BuildKit SBOM and provenance attestations. It resolves and pulls
that immutable digest, verifies both attestations, removes registry credentials,
proves the digest can be pulled with a fresh anonymous Docker configuration, and
exercises the exact pulled bytes through the complete container smoke. Only then
does it promote the same digest to the version tags. GitHub release evidence
records that registry digest, image configuration digest, CycloneDX application
SBOM, source commit, labels, user, entrypoint, kernel gate bundle, and artifact
hashes. A later release may add a multi-architecture manifest; do not assume one
for this alpha.

GitHub Container Registry creates a newly published organization package as
private. On the first publication only, the workflow is therefore expected to
stop at the anonymous-pull gate after the candidate exists. An organization
owner must review the candidate package and change its visibility to **Public**
in the GitHub package settings, acknowledging that GitHub does not allow a
public package to be made private again. Rerun the same tag workflow after that
one-time bootstrap. Do not create a GitHub release, promote version tags, or
accept the release until the isolated anonymous pull passes.

Always deploy by digest after resolving the tag:

```bash
docker pull ghcr.io/straits-ai/managed-agents-runtime:v0.1.0-alpha.1
docker image inspect \
  ghcr.io/straits-ai/managed-agents-runtime:v0.1.0-alpha.1 \
  --format '{{index .RepoDigests 0}}'
```

Record that digest in the deployment inventory. A mutable tag is not a rollback
identifier.

## Image commands

The image runs as the named non-root `node` user. Its entrypoint accepts only the
following commands:

| Command | Contract | Lifecycle |
| --- | --- | --- |
| `api` | Serves the authenticated runtime API on `API_HOST:API_PORT` | Long-running |
| `worker` | Claims and executes Runs; one or more replicas are allowed | Long-running |
| `relay` | Drains the transactional outbox to the configured publisher | Long-running |
| `migrate` | Applies unapplied SQL migrations under a PostgreSQL advisory lock | One shot |
| `preflight` | Checks configured provider surfaces and reports PASS/FAIL/SKIP | One shot, may create disposable provider resources |
| `admin ...` | Performs explicit tenant, key, credential, and knowledge administration | One shot, operator controlled |

Unknown commands fail with exit code 64. The image is not a general-purpose
shell environment.

Examples:

```bash
docker run --rm --env-file runtime.env \
  ghcr.io/straits-ai/managed-agents-runtime@sha256:... migrate

docker run --rm --env-file runtime.env \
  ghcr.io/straits-ai/managed-agents-runtime@sha256:... \
  admin tenant list
```

Do not place secret values in command arguments, image labels, or orchestrator
manifests. Supply them through the deployment secret mechanism.

## Required safety configuration

Every production-mode command parses the common fail-closed configuration. At a
minimum:

- set `DATABASE_URL` to the deployment database;
- set `NODE_ENV=production`;
- set a non-default `API_AUTH_TOKEN` with at least 32 non-whitespace characters;
- set `HTTP_EGRESS_MODE=allowlist` with `HTTP_EGRESS_ALLOWLIST`, or configure a
  controlled HTTPS/loopback proxy;
- keep `HARNESS_ENABLE_FAULTS=0`; and
- leave AgentKit Knowledge disabled in shared mode until that deployment and
  tenant binding have live verification evidence.

An externally reachable API must also set `API_HOST=0.0.0.0` or the intended
interface explicitly. The default loopback bind is deliberately not deployable
through an external load balancer.

## Health and readiness

Only the API process serves probes:

- `GET /healthz` returns `200 {"status":"ok"}` when the process can serve HTTP;
- `GET /readyz` queries PostgreSQL and returns
  `200 {"status":"ready"}` only when the process can do useful work; otherwise
  it returns 503 with a bounded reason.

These routes are unauthenticated and intentionally expose no tenant or internal
diagnostic data. Configure the orchestrator to use `/healthz` for liveness and
`/readyz` for readiness. Worker and relay health is determined from process
liveness plus their structured logs and workload/backlog monitoring; do not run
the API probe against those roles.

## Forward migration

Migrations are idempotent and ordered by filename. Each file runs in its own
transaction, completed files are recorded in `schema_migrations`, and an
advisory lock serializes concurrent migration jobs.

Before an upgrade:

1. Record the current application image digest and database migration list.
2. Take and verify a restorable PostgreSQL backup or provider snapshot.
3. Read every new migration and confirm old and new application versions can
   coexist for the rollout window.
4. Run the new image once with `migrate`.
5. Run it a second time and require `Already up to date.`.
6. Deploy one API canary, then workers and relay, pinned to the new digest.
7. Require readiness, controlled-alpha smoke scenarios, and bounded error/queue
   health before increasing traffic.

Never run migrations from every application replica as an implicit startup
side effect. Use a distinct, auditable one-shot job.

## Rollback

### Application rollback

If the new processes fail but the schema remains compatible:

1. Stop further rollout and new migration jobs.
2. Restore API, worker, and relay to the previously recorded image digest.
3. Verify `/readyz`, worker claims, relay drain, and a read-only tenant query.
4. Preserve failed-release logs, image digest, and release evidence.

### Database rollback limitation

The repository intentionally has no automatic down-migration mechanism.
Application rollback does **not** reverse SQL. If a migration is incompatible
with the prior application, the only supported recovery is one of:

- deploy a reviewed forward corrective migration; or
- stop writes and restore the verified pre-upgrade database snapshot, accepting
  the documented recovery-point data loss.

Choose and rehearse the recovery path before running a destructive or
non-backwards-compatible migration. A release requiring destructive schema work
must remain blocked until it has an explicit data migration and recovery plan.

## Release sequence

1. PR CI passes the kernel gate, image build, real-container smoke, and evidence
   generation at the synthetic merge commit.
2. The PR is reviewed and merged.
3. The same checks pass on the exact `main` commit.
4. Live provider conformance is recorded for every provider capability claimed
   by the release; unavailable capabilities remain labelled and fail closed.
5. Only then is the annotated `v0.1.0-alpha.1` tag created.
6. The tag workflow rejects a tag that is not annotated, is not the exact
   current `main` commit, or lacks a successful exact-commit `main` gate.
7. The publish job pushes an unpromoted candidate, verifies its attestations,
   proves an isolated anonymous pull, and smokes its immutable registry digest.
8. For the first package publication only, an organization owner changes the
   reviewed package to public after the expected anonymous-pull failure, then
   reruns the same tag workflow.
9. Only a publicly pullable and passing digest is promoted to the release tags
   and used to create the GitHub prerelease with kernel and container evidence.

The package version, changelog heading, release tag, image version label, and
GitHub prerelease title must agree exactly.
