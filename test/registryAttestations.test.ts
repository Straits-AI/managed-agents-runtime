import { describe, expect, it } from 'vitest';
import {
  RegistryAttestationError,
  validateDecodedBuildkitProvenance,
  validateDecodedSpdxSbom,
} from '../src/registryAttestations.js';

describe('registry attestation validation', () => {
  it('accepts the decoded BuildKit provenance shape', () => {
    expect(() => validateDecodedBuildkitProvenance({
      SLSA: {
        buildDefinition: {
          buildType: 'https://github.com/moby/buildkit/attestations/slsa',
          externalParameters: { request: {} },
        },
        runDetails: {
          builder: { id: '' },
          metadata: { invocationId: 'build-1' },
        },
      },
    })).not.toThrow();
  });

  it('rejects metadata without a decoded SLSA predicate', () => {
    expect(() => validateDecodedBuildkitProvenance({ predicateType: 'claimed' }))
      .toThrow(RegistryAttestationError);
  });

  it('accepts a non-empty decoded SPDX document', () => {
    expect(() => validateDecodedSpdxSbom({
      SPDX: {
        spdxVersion: 'SPDX-2.3',
        dataLicense: 'CC0-1.0',
        name: 'sbom',
        documentNamespace: 'https://example.invalid/sbom',
        creationInfo: {
          created: '2026-07-22T00:00:00Z',
          creators: ['Tool: test-generator'],
        },
        packages: [{ SPDXID: 'SPDXRef-Package', name: 'runtime' }],
      },
    })).not.toThrow();
  });

  it('rejects a malformed document that only resembles SPDX', () => {
    expect(() => validateDecodedSpdxSbom({
      SPDX: {
        spdxVersion: 'SPDX-',
        documentNamespace: 'x',
        packages: [null],
      },
    })).toThrow(RegistryAttestationError);
  });

  it('rejects an empty decoded SPDX package inventory', () => {
    expect(() => validateDecodedSpdxSbom({
      SPDX: {
        spdxVersion: 'SPDX-2.3',
        dataLicense: 'CC0-1.0',
        name: 'sbom',
        documentNamespace: 'https://example.invalid/sbom',
        creationInfo: {
          created: '2026-07-22T00:00:00Z',
          creators: ['Tool: test-generator'],
        },
        packages: [],
      },
    })).toThrow(/packages must be a non-empty array/);
  });
});
