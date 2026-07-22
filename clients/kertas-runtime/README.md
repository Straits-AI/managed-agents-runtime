# Kertas runtime contract compatibility client

This deliberately small client discovers the managed runtime through
authenticated HTTP and chooses either the real `kertas.runtime/v1alpha1`
ManagedSession contract or the temporary `run-as-session/v1` compatibility
contract. It has no runtime storage, migration, scheduler, or harness imports.

The package is a conformance fixture, not a claim that the ManagedSession API is
already available. `plannedContracts` are informational; selection considers
only advertised supported contracts and their feature flags.
