import { z } from 'zod';

export const PROVIDER_CONTRACT_SCHEMA = 'provider-contracts/v1' as const;
export const PROVIDER_MANIFEST_SCHEMA = 'provider-manifest/v1' as const;

const capabilityGroupSchema = z.enum([
  'model',
  'sandbox',
  'object-store',
  'event',
  'credential',
  'knowledge',
  'memory',
  'tool',
]);

const contractSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]+\/v1$/),
  group: capabilityGroupSchema,
  affinity: z.string().min(1).optional(),
  summary: z.string().min(1),
  requiredSemantics: z.array(z.string().min(1)).min(1),
});

const catalogSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONTRACT_SCHEMA),
  contracts: z.array(contractSchema).min(1),
}).superRefine((catalog, ctx) => {
  const seen = new Set<string>();
  for (const contract of catalog.contracts) {
    if (seen.has(contract.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate provider contract ${contract.id}` });
    }
    seen.add(contract.id);
  }
  for (const group of capabilityGroupSchema.options) {
    if (!catalog.contracts.some((contract) => contract.group === group)) {
      ctx.addIssue({ code: 'custom', message: `provider contract group ${group} is missing` });
    }
  }
});

const assuranceSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('none'), tests: z.array(z.string()).max(0) }),
  z.object({
    level: z.enum(['unit', 'integration']),
    tests: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    level: z.literal('live'),
    tests: z.array(z.string().min(1)).min(1),
    evidencePath: z.string().min(1),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

const declarationSchema = z.object({
  contract: z.string().min(1),
  status: z.enum(['required', 'optional', 'unsupported']),
  implementation: z.string().min(1).optional(),
  assurance: assuranceSchema,
  failureBoundary: z.string().min(1),
  limitations: z.array(z.string().min(1)),
}).superRefine((declaration, ctx) => {
  if (declaration.status === 'unsupported') {
    if (declaration.implementation) {
      ctx.addIssue({ code: 'custom', message: 'unsupported capability cannot name an implementation' });
    }
    if (declaration.assurance.level !== 'none') {
      ctx.addIssue({ code: 'custom', message: 'unsupported capability must use assurance level none' });
    }
    return;
  }
  if (!declaration.implementation) {
    ctx.addIssue({ code: 'custom', message: 'supported capability requires an implementation' });
  }
  if (declaration.assurance.level === 'none') {
    ctx.addIssue({ code: 'custom', message: 'supported capability requires conformance evidence' });
  }
});

const manifestSchema = z.object({
  schemaVersion: z.literal(PROVIDER_MANIFEST_SCHEMA),
  providerId: z.string().regex(/^[a-z][a-z0-9-]+$/),
  profileId: z.string().regex(/^[a-z][a-z0-9-]+$/),
  displayName: z.string().min(1),
  providerClass: z.enum(['local', 'cloud']),
  releaseVersion: z.string().min(1),
  capabilities: z.array(declarationSchema).min(1),
});

export type ProviderContractCatalogV1 = z.infer<typeof catalogSchema>;
export type ProviderContractV1 = ProviderContractCatalogV1['contracts'][number];
export type ProviderManifestV1 = z.infer<typeof manifestSchema>;
export type ProviderCapabilityDeclarationV1 = ProviderManifestV1['capabilities'][number];
export type ProviderAssuranceLevel = ProviderCapabilityDeclarationV1['assurance']['level'];

export function parseProviderContractCatalog(input: unknown): ProviderContractCatalogV1 {
  return catalogSchema.parse(input);
}

export function parseProviderManifest(
  catalog: ProviderContractCatalogV1,
  input: unknown,
): ProviderManifestV1 {
  const manifest = manifestSchema.parse(input);
  const catalogIds = new Set(catalog.contracts.map((contract) => contract.id));
  const declarations = new Map<string, ProviderCapabilityDeclarationV1>();
  for (const capability of manifest.capabilities) {
    if (!catalogIds.has(capability.contract)) {
      throw new Error(`${manifest.providerId}/${manifest.profileId} declares unknown contract ${capability.contract}`);
    }
    if (declarations.has(capability.contract)) {
      throw new Error(`${manifest.providerId}/${manifest.profileId} duplicates contract ${capability.contract}`);
    }
    declarations.set(capability.contract, capability);
  }
  for (const contract of catalog.contracts) {
    if (!declarations.has(contract.id)) {
      throw new Error(`${manifest.providerId}/${manifest.profileId} omits contract ${contract.id}`);
    }
  }
  return manifest;
}

const requirementSchema = z.object({
  contract: z.string().min(1),
  minimumAssurance: z.enum(['unit', 'integration', 'live']),
});

const selectionRequestSchema = z.object({
  apiVersion: z.literal('provider-selection/v1'),
  requirements: z.array(requirementSchema).min(1),
});

const bindingSchema = z.object({
  contract: z.string().min(1),
  providerId: z.string().regex(/^[a-z][a-z0-9-]+$/),
  profileId: z.string().regex(/^[a-z][a-z0-9-]+$/),
  implementation: z.string().min(1),
  assurance: z.enum(['unit', 'integration', 'live']),
  failureBoundary: z.string().min(1),
  limitations: z.array(z.string().min(1)),
});

const selectionSchema = z.object({
  schemaVersion: z.literal('provider-selection/v1'),
  bindings: z.array(bindingSchema).min(1),
});

export type CapabilityRequirementV1 = z.infer<typeof requirementSchema>;
export type CapabilityBindingV1 = z.infer<typeof bindingSchema>;
export type ProviderSelectionV1 = z.infer<typeof selectionSchema>;

export function parseCapabilitySelectionRequest(input: unknown): {
  apiVersion: 'provider-selection/v1';
  requirements: CapabilityRequirementV1[];
} {
  return selectionRequestSchema.parse(input);
}

const deploymentManifestSchema = z.object({
  schemaVersion: z.literal('provider-deployment/v1'),
  deploymentId: z.string().regex(/^[a-z][a-z0-9-]+$/),
  description: z.string().min(1),
  requirements: z.array(requirementSchema).min(1),
  resolvedSelection: selectionSchema,
  failurePolicy: z.literal('reject-unsatisfied-capabilities'),
});

export type ProviderDeploymentManifestV1 = z.infer<typeof deploymentManifestSchema>;

export function parseProviderDeploymentManifest(input: unknown): ProviderDeploymentManifestV1 {
  return deploymentManifestSchema.parse(input);
}

const assuranceRank: Record<ProviderAssuranceLevel, number> = {
  none: 0,
  unit: 1,
  integration: 2,
  live: 3,
};

/**
 * Resolve each capability (or affinity group) without accepting a provider
 * brand as input. Kertas states semantics and assurance; the runtime returns
 * the deterministic provider bindings that satisfy them.
 */
export function selectProvidersByCapability(input: {
  catalog: ProviderContractCatalogV1;
  manifests: ProviderManifestV1[];
  requirements: CapabilityRequirementV1[];
}): ProviderSelectionV1 {
  const contractById = new Map(input.catalog.contracts.map((contract) => [contract.id, contract]));
  const requirementsByGroup = new Map<string, CapabilityRequirementV1[]>();
  const seen = new Set<string>();
  for (const requirement of input.requirements) {
    if (seen.has(requirement.contract)) throw new Error(`duplicate capability requirement ${requirement.contract}`);
    seen.add(requirement.contract);
    const contract = contractById.get(requirement.contract);
    if (!contract) throw new Error(`unknown capability requirement ${requirement.contract}`);
    const group = contract.affinity ?? contract.id;
    const grouped = requirementsByGroup.get(group) ?? [];
    grouped.push(requirement);
    requirementsByGroup.set(group, grouped);
  }

  const bindings: CapabilityBindingV1[] = [];
  for (const [group, requirements] of [...requirementsByGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const candidates = input.manifests
      .map((manifest) => ({ manifest, declarations: declarationsFor(manifest, requirements) }))
      .filter(({ declarations }) => declarations !== null)
      .sort((a, b) => compareCandidates(a, b, requirements));
    const selected = candidates[0];
    if (!selected || !selected.declarations) {
      throw new Error(`no provider satisfies capability group ${group}`);
    }
    for (const requirement of requirements) {
      const declaration = selected.declarations.get(requirement.contract)!;
      bindings.push({
        contract: requirement.contract,
        providerId: selected.manifest.providerId,
        profileId: selected.manifest.profileId,
        implementation: declaration.implementation!,
        assurance: declaration.assurance.level as Exclude<ProviderAssuranceLevel, 'none'>,
        failureBoundary: declaration.failureBoundary,
        limitations: declaration.limitations,
      });
    }
  }
  return {
    schemaVersion: 'provider-selection/v1',
    bindings: bindings.sort((a, b) => a.contract.localeCompare(b.contract)),
  };
}

function declarationsFor(
  manifest: ProviderManifestV1,
  requirements: CapabilityRequirementV1[],
): Map<string, ProviderCapabilityDeclarationV1> | null {
  const declarations = new Map(manifest.capabilities.map((capability) => [capability.contract, capability]));
  for (const requirement of requirements) {
    const declaration = declarations.get(requirement.contract);
    if (!declaration || declaration.status === 'unsupported') return null;
    if (assuranceRank[declaration.assurance.level] < assuranceRank[requirement.minimumAssurance]) return null;
  }
  return declarations;
}

function compareCandidates(
  a: { manifest: ProviderManifestV1; declarations: Map<string, ProviderCapabilityDeclarationV1> | null },
  b: { manifest: ProviderManifestV1; declarations: Map<string, ProviderCapabilityDeclarationV1> | null },
  requirements: CapabilityRequirementV1[],
): number {
  const assurance = (candidate: typeof a) => Math.min(...requirements.map((requirement) =>
    assuranceRank[candidate.declarations!.get(requirement.contract)!.assurance.level]));
  return assurance(b) - assurance(a)
    || a.manifest.providerId.localeCompare(b.manifest.providerId)
    || a.manifest.profileId.localeCompare(b.manifest.profileId);
}
