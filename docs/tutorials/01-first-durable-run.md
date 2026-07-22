# Tutorial 1: complete a first durable run

This tutorial starts the published controlled-alpha image, PostgreSQL, the API,
and one deterministic worker. It then creates an Agent, immutable Agent Version,
and Run through the public HTTP API. No BytePlus account, model key, or local
Node.js installation is required.

## Prerequisites

- Docker Engine or Docker Desktop with Compose v2.
- A Git checkout or downloaded archive of this repository.
- At least 2 GiB of free memory.
- Host port `8080` available on loopback.

`curl` is optional and used only by the inspection example.

The controlled-alpha runtime image is currently `linux/amd64`. The Compose file
selects that platform explicitly. Docker Desktop can emulate it on Apple Silicon,
but startup will be slower than on an amd64 host.

## Start the runtime

Clone the public repository if necessary, then enter the quickstart directory:

```bash
git clone https://github.com/Straits-AI/managed-agents-runtime.git
cd managed-agents-runtime
```

From the repository root, start the runtime:

```bash
cd examples/quickstart
docker compose up --detach --wait postgres api worker
```

Compose performs the migration as a one-shot dependency before starting the API
and worker. The API listens inside the container on all interfaces but is
published to the host only at `127.0.0.1:8080`.

## Create and complete a run

```bash
docker compose run --rm first-run
```

The client waits for readiness, creates the Agent and Version, submits a bounded
scripted Run, waits for `COMPLETED`, and verifies that its durable event sequence
is gapless. The final output resembles:

```text
{
  "runId": "run_...",
  "status": "COMPLETED",
  "eventCount": 9,
  "lastEvent": "RunCompleted"
}
PASS first durable run
```

The exact event count may grow as the runtime contract evolves; the client
checks sequence continuity and terminal status rather than freezing an internal
implementation detail.

## Inspect the runtime

```bash
curl -s http://127.0.0.1:8080/readyz
docker compose logs api worker
```

Authenticated API calls use the tutorial token in
`runtime.env.example`. That token is intentionally committed for this
loopback-only demo and must never be reused for a shared deployment.

## Clean up

```bash
docker compose down --volumes --remove-orphans
```

This deletes only the Compose project containers, network, and named tutorial
volumes. It does not remove the downloaded images.

## Troubleshooting

- **Port 8080 is already allocated:** stop the existing listener or change the
  host side of `127.0.0.1:8080:8080`, then use that port for host-side probes.
- **An Apple Silicon pull or start is slow:** the alpha is `linux/amd64`; Docker
  Desktop uses emulation. The tutorial does not claim a native arm64 image.
- **A service exits:** run `docker compose ps --all` followed by
  `docker compose logs api worker migrate`. Startup remains fail-closed for a
  weak token, open production egress, unavailable PostgreSQL, or unwritable
  object storage.
- **Retry from a clean tutorial state:** run the cleanup command above and start
  again. The named volumes are intentionally disposable.

## What to try next

Continue with [approval and recovery](./02-approval-and-recovery.md), then read
the [controlled-alpha deployment runbook](../CONTROLLED-ALPHA-DEPLOYMENT.md)
before adapting the image to a shared environment.
