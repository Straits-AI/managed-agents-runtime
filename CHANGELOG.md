# Changelog

All notable changes to this project are documented here. Release tags use the
package version with a `v` prefix.

## [0.1.0-alpha.1] - 2026-07-19

First deployable controlled-alpha release.

### Added

- durable multi-tenant execution with leases, fencing, recovery, child Runs,
  approvals, governed external actions, credential grants, and usage controls;
- a reviewed 30-assertion controlled-alpha release gate;
- a non-root OCI image with API, worker, relay, migration, preflight, and admin
  command contracts;
- real-container migration, process, and health/readiness smoke testing;
- CycloneDX application SBOM and image provenance evidence; and
- the Kertas product boundary, target ManagedSession contract, and public-beta
  engineering risk register.

### Release boundary

- This is a controlled alpha, not a public-beta or production-ready release.
- The local gate is provider-contract evidence, not current live BytePlus
  conformance.
- Database migrations are forward-only; application rollback does not
  automatically reverse schema changes.
