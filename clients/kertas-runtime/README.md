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
