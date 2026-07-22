# Public-image quickstart

This directory is the executable companion to
[Tutorial 1](../../docs/tutorials/01-first-durable-run.md).

```bash
docker compose up --detach --wait postgres api worker
docker compose run --rm first-run
```

The Compose project uses the public controlled-alpha digest by default. Set
`RUNTIME_IMAGE` to exercise the same contract against a locally built candidate:

```bash
RUNTIME_IMAGE=managed-agents-runtime:test docker compose up --detach --wait postgres api worker
```

The committed token in `runtime.env.example` is for this host-loopback tutorial
only. It is not a deployment secret.
