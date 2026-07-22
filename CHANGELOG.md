# Changelog

All notable changes to this project are documented here. Release tags use the
package version with a `v` prefix.

## [0.1.0-alpha.2] - 2026-07-22

First published controlled-alpha release. This supersedes the unpublished
`v0.1.0-alpha.1` candidate tag, which remains immutable for audit history.

### Added

- the complete public `kertas.runtime/v1alpha1` ManagedSession and inbound-event
  contract, compatibility discovery, standalone Kertas client, and deployment
  conformance evidence;
- bounded public artifact content and delegated-child result projections; and
- BytePlus private WebSocket execution with live, sanitized provider evidence.

### Hardened

- tenant isolation, authenticated non-loopback deployment, credential handling,
  public API limits, container cleanup, and exact source/image evidence binding;
- registry attestation validation against BuildKit's decoded SLSA and SPDX
  documents rather than an inapplicable raw predicate-type string; and
- PR, main, and tag pipelines now run the standalone Kertas conformance through
  the release image smoke contract.

### Release boundary

- This remains a controlled alpha, not a public-beta or production-ready release.
- Database migrations are forward-only; application rollback does not
  automatically reverse schema changes.

## [0.1.0-alpha.1] - 2026-07-19

First deployable controlled-alpha release.

### Added

- durable multi-tenant execution with leases, fencing, recovery, child Runs,
  approvals, governed external actions, credential grants, and usage controls;
- a reviewed 30-assertion controlled-alpha release gate;
- a non-root OCI image with API, worker, relay, migration, preflight, and admin
  command contracts;
- real-container migration, process, and health/readiness smoke testing;
- CycloneDX application SBOM and image provenance evidence;
- annotated-main tag enforcement plus immutable registry-digest smoke and
  promotion; and
- the Kertas product boundary, target ManagedSession contract, and public-beta
  engineering risk register.

### Release boundary

- This is a controlled alpha, not a public-beta or production-ready release.
- The local gate is provider-contract evidence, not current live BytePlus
  conformance.
- Database migrations are forward-only; application rollback does not
  automatically reverse schema changes.
