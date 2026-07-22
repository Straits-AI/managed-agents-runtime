# Provider portability contract

**Contract schema:** `provider-contracts/v1`  
**Manifest schema:** `provider-manifest/v1`  
**Deployment schema:** `provider-deployment/v1`  
**Release:** `0.1.0-alpha.2`

This is the runtime's public provider-selection boundary. It records exact
capabilities and assurance without treating a cloud brand, historical demo, or
TypeScript interface as proof of semantic portability.

## Capability catalog

[`provider-conformance/contracts.v1.json`](../provider-conformance/contracts.v1.json)
defines versioned semantics for:

- model chat;
- sandbox workspace lifecycle;
- object read, write, and presigning;
- event publication;
- credential resolution;
- knowledge retrieval;
- semantic memory; and
- Skill resolution and MCP invocation.

Every provider manifest under `provider-conformance/providers/` declares every
contract exactly once as:

- `required`: part of that profile's intended runtime surface;
- `optional`: implemented and selectable, but not required by that profile; or
- `unsupported`: unavailable and rejected during selection.

Supported declarations identify an implementation, test paths, failure
boundary, limitations, and an assurance level. `live` assurance additionally
binds a retained evidence record by SHA-256. Unsupported declarations cannot
name an implementation or evidence.

## Release-current provider profiles

| Profile | Declared subset | Assurance boundary |
| --- | --- | --- |
| `local/reference` | sandbox, object store, event, credential, knowledge, memory, Skills, MCP | Integration tests. The sandbox is a host child process and is not an isolation boundary. |
| `byteplus/managed-runtime` | ModelArk chat, private veFaaS sandbox, TOS read/write/presign | Live retained evidence for only these capabilities. ModelArk forwards the requested output ceiling, but the retained run reported 48 output tokens for a 32-token request and therefore does not prove provider-side enforcement. BytePlus Kafka, KMS, AgentKit Knowledge/Memory/Skills/MCP are unsupported in this profile. |
| `aws/public-s3-read` | anonymous bounded S3 `HEAD`/`GET` | Live read-only proof against the NOAA GOES-16 AWS Open Data bucket. No authenticated read, write, list, presign, version, availability, or performance claim. |

The AWS profile is deliberately a materially different but narrow provider
subset. `AwsPublicS3Reader` implements only `ReadableObjectStore`; it cannot be
assigned where a runtime requires object writes or presigning.

## Capability-based deployment selection

Kertas or another client states semantic requirements and minimum assurance:

```json
{
  "contract": "sandbox.workspace/v1",
  "minimumAssurance": "live"
}
```

The runtime resolves deterministic bindings through
`selectProvidersByCapability`. Provider names are outputs, not selection inputs.
The checked deployment profiles are:

- [`kertas-managed`](../deploy/provider-profiles/kertas-managed.v1.json), which
  resolves the live cloud core to BytePlus and integration-tested control-plane
  capabilities to local providers; and
- [`aws-public-read`](../deploy/provider-profiles/aws-public-read.v1.json), a
  bounded demonstration that resolves only `object.read/v1` to AWS.

Object read, write, and presigning share the `object-store` affinity group. A
deployment cannot silently combine AWS public reads with BytePlus writes and
claim one coherent object-store implementation. If no single manifest satisfies
the required affinity group and assurance, selection rejects the deployment.

`resolvedSelection` is checked into each deployment manifest as an auditable
result. Each binding carries its selected failure boundary and limitations. The
gate recalculates it and rejects stale or brand-forced bindings.

### Kertas-facing runtime API

The production API loads the same catalog, manifests, evidence hashes, and
deployment checks that CI validates. Test source files are verified in CI and
intentionally omitted from the runtime image. An authenticated Kertas client can
discover the boundary at:

```text
GET /v1/provider-capabilities
```

and resolve an operational binding without supplying a provider name:

```http
POST /v1/provider-capabilities/resolve
Authorization: Bearer ...
Content-Type: application/json

{
  "apiVersion": "provider-selection/v1",
  "requirements": [
    { "contract": "object.read/v1", "minimumAssurance": "live" }
  ]
}
```

The response returns the selected provider/profile/implementation, assurance,
failure boundary, and limitations. Unknown contracts, unsatisfied assurance, and
unsatisfied affinity groups return a bounded `400 ProviderSelectionError` rather
than falling back to a brand-specific default. The same directories are copied
into the controlled-alpha OCI image, so the checked contract is available in the
deployed API rather than only in a repository script.

## Evidence and gate

Run:

```bash
npm run provider:portability
```

The gate verifies:

- catalog completeness and unique versioned contracts;
- one declaration per contract per provider;
- implementation/evidence rules for required, optional, and unsupported status;
- referenced conformance tests, including bounded local object/file operations
  and ModelArk request/tool-call translation;
- exact hashes and minimum provenance for live evidence;
- local plus two distinct cloud providers;
- deterministic capability-based deployment resolution; and
- fail-closed behavior when a required capability or affinity group is absent.

The standalone gate runs in the controlled-alpha workflow. Unit tests also
exercise malformed manifests, unsupported selection, object-store affinity,
bounded AWS failures, redirects, timeouts, object sizes, and invalid targets.

## Claims this does not establish

This contract does not prove that all providers implement all semantics, that a
deployment is production-ready, or that providers have equivalent cost,
latency, isolation, durability, or regional availability. A new capability,
provider, profile, or stronger assurance claim requires a versioned declaration,
tests, and—where `live` is claimed—fresh retained evidence.
