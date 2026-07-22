# Engineering risk register

**Baseline:** `c58e94c2d23220653959eda3f382a0fdd711d16f`  
**Release level:** controlled multi-tenant alpha  
**Last reviewed:** 2026-07-22

This register is the release-boundary record for the Managed Agents Runtime. It
distinguishes proven closure from remaining public-beta and production work.

## Severity

- `P0` blocks controlled multi-tenant use or external exposure.
- `P1` blocks a credible public beta or production-readiness claim.
- `P2` is hardening or maintainability work that may follow the correctness
  boundary but remains tracked.

## Readiness

| Release claim | State | Gate |
| --- | --- | --- |
| Local single-tenant development | Supported | Local tests and documented configuration |
| Controlled multi-tenant alpha | **Passed** | Versioned P0 gate, exact-commit CI evidence |
| Public beta | **Blocked** | Remaining P1 items below |
| Production ready | **Blocked** | All P1 items plus live conformance and explicit approval |

Passing a process or CI job proves the named gate only. It does not prove task
outcome quality, every cloud-provider contract, public-beta readiness, or
production approval.

## Closed controlled-alpha boundary

| Risk | Closure | Evidence |
| --- | --- | --- |
| `MAR-P0-001` delegated tenant/policy inheritance | Closed | [Issue #2](https://github.com/Straits-AI/managed-agents-runtime/issues/2), critical tenant-child and negative-delegation assertions |
| `MAR-P0-002` racy/bypassable run admission | Closed | [Issue #5](https://github.com/Straits-AI/managed-agents-runtime/issues/5), atomic burst and replacement assertions |
| `MAR-P0-003` cross-tenant AgentKit Knowledge | Closed | [Issue #4](https://github.com/Straits-AI/managed-agents-runtime/issues/4), tenant mapping and negative access assertions |
| `MAR-P0-004` ungoverned MCP mutations | Closed | [Issues #3](https://github.com/Straits-AI/managed-agents-runtime/issues/3) and [#8](https://github.com/Straits-AI/managed-agents-runtime/issues/8), receipt/recovery/concurrency assertions |
| `MAR-P0-005` incomplete outbound HTTP defense | Closed | [Issue #7](https://github.com/Straits-AI/managed-agents-runtime/issues/7), DNS/redirect/metadata/size assertions |
| `MAR-P0-006` unsafe production defaults | Closed | [Issue #1](https://github.com/Straits-AI/managed-agents-runtime/issues/1), fail-closed bind/auth/error assertions |
| Integrated P0 release gate | Closed | [Issue #9](https://github.com/Straits-AI/managed-agents-runtime/issues/9), 30 named critical assertions and retained exact-commit evidence |

The current controlled-alpha gate passes 287/287 tests, all 30 critical
assertions, TypeScript checking, and the production dependency audit. Evidence is
redacted, digest-bound, and retained by GitHub Actions.

## Other closed hardening

### MAR-P1-001 — execution-scoped credential grants

**Status:** closed by [Issue #6](https://github.com/Straits-AI/managed-agents-runtime/issues/6)

Credential resolution is constrained by tenant, caller/lineage, purpose, action,
resource, approval, expiry, and usage. Child/fork inheritance defaults to deny;
resolution/consumption is atomic and secret-free in receipts.

### MAR-P1-004 — high-severity TOS dependency chain

**Status:** closed by [Issue #19](https://github.com/Straits-AI/managed-agents-runtime/issues/19)

The vulnerable SDK/Axios chain was replaced with a bounded native TOS protocol
client. Official SDK signing vectors, retry/failure bounds, audit-policy parsing,
and a zero-vulnerability production audit are gated. Live TOS conformance for the
replacement remains a separate provider gate.

### MAR-P2-006 — deprecated GitHub Action runtimes

**Status:** closed by [Issue #20](https://github.com/Straits-AI/managed-agents-runtime/issues/20)

The release workflow pins official Node 24-native action commits. Tag/SHA/runtime
provenance and the complete `uses:` set are frozen by tests.

## Open public-beta risks

### MAR-P1-002 — terminal bookkeeping after verification exhaustion

**Status:** open — [Issue #23](https://github.com/Straits-AI/managed-agents-runtime/issues/23)  
**Owner:** runtime

After verifier retries are exhausted, the epoch writes `FAILED` but returns the
retryable `error` exit reason. Attempt settlement can then try a transition from
an already terminal Run.

**Closure:** return a definitive terminal outcome; atomically settle Run and
Attempt state; prove the full path remains stable after reaping.

### MAR-P1-003 — usage windows use event time

**Status:** closed — [Issue #24](https://github.com/Straits-AI/managed-agents-runtime/issues/24)

**Owner:** runtime

Tenant usage joins invocation events but filters by `runs.created_at`. A Run
created before the reporting window can spend tokens inside the window without
being counted.

**Closure:** tenant token and cost reporting filters immutable invocation-event
timestamps in an explicit half-open window. Regression coverage crosses UTC
midnight, proves an exclusive upper bound, and keeps Run-count semantics separate.
The default reporting window now matches admission's UTC-day boundary.

### MAR-P1-005 — reproducible deployable release

**Status:** release candidate; merge and tag pending — [Issue #25](https://github.com/Straits-AI/managed-agents-runtime/issues/25)
**Owner:** runtime/repository

The candidate adds a versioned non-root OCI image, real-container
migration/process/probe smoke testing, CycloneDX plus registry attestation
evidence, and an explicit migration/application rollback runbook. The package,
changelog, image label, and proposed tag agree on `v0.1.0-alpha.1`. Closure still
requires the PR and exact post-merge `main` gates, current live provider evidence
for every release claim, the immutable registry digest, and the final tag.

**Closure:** publish and verify the pinned deployment artifact and tag; attach
SBOM/provenance and digest evidence; preserve the documented forward/rollback
operations and agreed repository checks.

### MAR-P1-006 — provider claims and live conformance

**Status:** closed — [Issue #26](https://github.com/Straits-AI/managed-agents-runtime/issues/26)
**Owner:** runtime/provider adapters

The versioned BytePlus manifest records exact-source, region, retrieval time,
toolchain, control/data/failure/redaction/cleanup evidence for the current TOS,
ModelArk, and private veFaaS sandbox claims. AgentKit Memory, Kafka, and KMS are
explicitly unavailable as release-current claims; Skills/MCP are local-only; AgentKit Knowledge remains
unavailable and fail-closed for shared deployments without attestation. README
and runbook matrices are checked mechanically against the manifest.

**Closure:** release-current live claims have bounded retained evidence, every
other surface has an explicit non-verified classification, and contradictory
README claims fail the provider-claims check.

### MAR-P1-007 — first-class runtime artifacts

**Status:** closed — [Issue #27](https://github.com/Straits-AI/managed-agents-runtime/issues/27)
**Owner:** runtime

Completed Runs now reference immutable `art_…` resources. Each record persists a
content digest, MIME type, byte size, logical role, producer Run/Attempt/step,
source mapping, and explicit verification/evidence references. Provider object
keys remain internal and artifact bytes are reachable only through a
tenant-authorized API.

**Closure:** migration `0016_artifacts.sql`, atomic artifact/Run completion,
authorized metadata/content APIs, run-bundle v2 digest and lineage verification,
and pre-migration compatibility fixtures.

### MAR-P1-008 — bounded delegated results and lineage

**Status:** open — [Issue #28](https://github.com/Straits-AI/managed-agents-runtime/issues/28)  
**Owner:** runtime

Parent wake-up receives child ID, status, and goal, but not a bounded structured
result, artifact/evidence references, usage, or a first-class lineage query.

**Closure:** define a bounded child-result contract; expose current/replaced child
lineage and usage; test merge/conflict behavior without raw-event parsing.

### MAR-P1-009 — durable context and checkpoint evolution

**Status:** open — [Issue #29](https://github.com/Straits-AI/managed-agents-runtime/issues/29)  
**Owner:** runtime

Checkpoint state covers transcript, summary, step, supervisor state, and one
pending tool call. Active commitments, child/evidence references, context
selection, and schema-evolution behavior are not yet a complete contract.

**Closure:** version checkpoint schemas; distinguish durable truth from rebuilt
model context; add forwards/backwards restore fixtures and interrupted-upgrade
tests.

### MAR-P1-010 — actual portability boundary

**Status:** open — [Issue #30](https://github.com/Straits-AI/managed-agents-runtime/issues/30)  
**Owner:** runtime/provider adapters

Local and BytePlus adapters demonstrate useful seams, but there is no unified
provider conformance suite or second materially different cloud stack passing a
declared supported subset.

**Closure:** publish capability-level model/sandbox/object/event/credential/
knowledge/memory/tool contracts; test local plus at least two non-identical
providers; declare unsupported semantics in deployment manifests.

## P2 backlog

| ID | Risk | Closure signal |
| --- | --- | --- |
| `MAR-P2-001` | `toolRouter` still combines several capability handlers. | Focused modules retain governed-action parity tests. |
| `MAR-P2-002` | Several lifecycle values remain unconstrained database text. | Constraints/enums and invalid-state migration tests. |
| `MAR-P2-003` | No lint/format command or measured coverage baseline. | Reproducible commands and risk-sensitive thresholds in CI. |
| `MAR-P2-004` | Prompt/tool-name consistency is not one frozen contract. | Every instructed tool name resolves exactly to a registered tool. |
| `MAR-P2-005` | BytePlus signing implementations retain duplicated mechanics. | One reviewed signing core with service-specific golden fixtures. |

## Provider evidence boundary

The controlled-alpha release gate is local provider-contract evidence. It is not
a live BytePlus run. A provider surface may be claimed only with:

- adapter/version and target region;
- exact non-secret resource/capability under test;
- retrieval/test date;
- control-plane, data-plane, and failure evidence;
- credential/redaction boundary;
- cleanup result for disposable resources; and
- explicit untested semantics.

Historical scenario results remain useful demonstrations but are not automatically
current conformance evidence after adapter or provider changes.

## Tracking policy

Every open P0/P1 entry requires a GitHub issue before implementation. Closure
requires an exact-commit test, independent review, merged CI evidence, and a
post-merge main check appropriate to the risk. Status text in this document is
updated in the same change that closes or reclassifies the risk.
