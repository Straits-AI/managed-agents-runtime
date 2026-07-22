export class RegistryAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryAttestationError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RegistryAttestationError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RegistryAttestationError(`${label} must be a non-empty string`);
  }
  return value;
}

/** Validate the decoded provenance returned by `buildx imagetools inspect .Provenance`. */
export function validateDecodedBuildkitProvenance(value: unknown): void {
  const root = record(value, 'registry provenance');
  const slsa = record(root.SLSA, 'registry provenance SLSA predicate');
  const definition = record(slsa.buildDefinition, 'SLSA buildDefinition');
  nonEmptyString(definition.buildType, 'SLSA buildDefinition.buildType');
  record(definition.externalParameters, 'SLSA buildDefinition.externalParameters');
  const details = record(slsa.runDetails, 'SLSA runDetails');
  const builder = record(details.builder, 'SLSA runDetails.builder');
  if (typeof builder.id !== 'string') {
    throw new RegistryAttestationError('SLSA runDetails.builder.id must be a string');
  }
  record(details.metadata, 'SLSA runDetails.metadata');
}

/** Validate the decoded SBOM returned by `buildx imagetools inspect .SBOM`. */
export function validateDecodedSpdxSbom(value: unknown): void {
  const root = record(value, 'registry SBOM');
  const spdx = record(root.SPDX, 'registry SPDX predicate');
  const version = nonEmptyString(spdx.spdxVersion, 'SPDX spdxVersion');
  if (version !== 'SPDX-2.3') {
    throw new RegistryAttestationError('SPDX spdxVersion must equal SPDX-2.3');
  }
  if (spdx.dataLicense !== 'CC0-1.0') {
    throw new RegistryAttestationError('SPDX dataLicense must equal CC0-1.0');
  }
  nonEmptyString(spdx.name, 'SPDX name');
  const namespace = nonEmptyString(spdx.documentNamespace, 'SPDX documentNamespace');
  try {
    new URL(namespace);
  } catch {
    throw new RegistryAttestationError('SPDX documentNamespace must be an absolute URL');
  }
  const creationInfo = record(spdx.creationInfo, 'SPDX creationInfo');
  const created = nonEmptyString(creationInfo.created, 'SPDX creationInfo.created');
  if (Number.isNaN(Date.parse(created))) {
    throw new RegistryAttestationError('SPDX creationInfo.created must be a timestamp');
  }
  if (
    !Array.isArray(creationInfo.creators)
    || creationInfo.creators.length === 0
    || creationInfo.creators.some(
      (creator) => typeof creator !== 'string' || creator.trim().length === 0,
    )
  ) {
    throw new RegistryAttestationError(
      'SPDX creationInfo.creators must be a non-empty string array',
    );
  }
  if (!Array.isArray(spdx.packages) || spdx.packages.length === 0) {
    throw new RegistryAttestationError('SPDX packages must be a non-empty array');
  }
  for (const [index, value] of spdx.packages.entries()) {
    const pkg = record(value, `SPDX packages[${index}]`);
    const id = nonEmptyString(pkg.SPDXID, `SPDX packages[${index}].SPDXID`);
    if (!id.startsWith('SPDXRef-')) {
      throw new RegistryAttestationError(
        `SPDX packages[${index}].SPDXID must start with SPDXRef-`,
      );
    }
    nonEmptyString(pkg.name, `SPDX packages[${index}].name`);
  }
}
