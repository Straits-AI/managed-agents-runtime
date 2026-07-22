# Operational tutorials

These tutorials teach the public runtime contract. They use the same API and
container image that an external platform such as Kertas uses; none depends on
private database access or hidden repository state.

1. [First durable run](./01-first-durable-run.md) — start the public image and
   complete a deterministic run without BytePlus credentials.
2. [Approval and recovery](./02-approval-and-recovery.md) — suspend for human
   approval, restart the worker, and resume from durable state.
3. [Kertas integration](./03-kertas-integration.md) — bind Projects and Managed
   Sessions to this runtime through its public API and event protocol.

## Use-case showcases

The existing [production scenario articles](../articles/README.md) explain what
agents accomplished in SRE, support, accounts payable, DevSecOps, and data
engineering runs. They are evidence-backed showcases, not installation guides.

## Boundary

These tutorials stop at the managed execution plane: sessions, runs, attempts,
events, approvals, artifacts, and governed side effects. Kertas owns Projects,
interactive Workspaces, knowledge provenance, Outcome Contracts, Releases,
Deployments, Routines, connectors, CLI/Studio, and end-user experience.
