# Tutorial 2: approval and recovery across a worker restart

This tutorial proves that an approval wait belongs to durable runtime state, not
to a particular worker process. The first Attempt suspends, the worker is
restarted, and a second Attempt completes the same Run after approval.

Complete [Tutorial 1](./01-first-durable-run.md) first and leave the Compose
services running.

## Create a Run that requires approval

```bash
docker compose run --rm \
  -e QUICKSTART_MODE=approval-create \
  first-run
```

The command returns a `runId` and `approvalId`, followed by
`PASS approval suspended`. Copy both IDs. The Run is now
`WAITING_APPROVAL`; its first Attempt has exited with
`suspended_for_approval`, so the wait holds no worker compute.

## Restart the worker

```bash
docker compose stop worker
docker compose start worker
```

Stopping the worker does not alter the Run, checkpoint, pending approval, or
event ledger. The replacement worker is disposable infrastructure.

## Approve and resume

Replace the placeholders with the copied IDs:

```bash
docker compose run --rm \
  -e QUICKSTART_MODE=approval-resume \
  -e RUN_ID=run_... \
  -e APPROVAL_ID=apr_... \
  first-run
```

The client approves through the public API, waits for completion, and verifies:

- one Attempt ended as `suspended_for_approval`;
- the resumed Attempt ended as `completed`;
- the event sequence remains gapless; and
- both `ApprovalRequested` and `ApprovalReceived` are present.

It finishes with `PASS approval recovery`.

## Approval is not the external action

The deterministic tutorial stops after the approval decision; it does not send
the example HTTP mutation. In a real harness, approved mutations still pass
through grant validation, scoped credential release, a pending receipt,
provider dispatch, and a committed receipt.

To exercise the stronger crash-after-commit guarantee from source, run:

```bash
npm run bench:survival
```

That benchmark kills a worker immediately after the remote commit and requires
exactly one `ToolInvocationCommitted` event after recovery. Do not infer that
approval alone proves the provider honored an idempotency key; provider
conformance evidence is a separate release boundary.

## Clean up

```bash
docker compose down --volumes --remove-orphans
```
