export interface DiscoveredContract {
  id: string;
  status: string;
  lifecycle: 'supported' | 'deprecated';
  href: string;
  introducedAt: string;
  deprecatedAt: string | null;
  sunsetAt: string | null;
  replacement: string | null;
  features: { managedSession: boolean; inboundEvents: boolean };
}

export interface RuntimeContractDiscovery {
  apiVersion: 'kertas.runtime/contracts/v1';
  currentCompatibilityMode: 'run-as-session/v1';
  contracts: DiscoveredContract[];
  plannedContracts: unknown[];
  deprecationPolicy: {
    minimumNoticeDays: number;
    compatibilityModeRemoval: 'explicit_sunset_only';
  };
}

export interface SelectedRuntimeContract {
  contractId: 'run-as-session/v1' | 'kertas.runtime/v1alpha1';
  mode: 'compatibility' | 'managed-session';
  managedSession: boolean;
  inboundEvents: boolean;
  lifecycle: 'supported' | 'deprecated';
  deprecatedAt: string | null;
  sunsetAt: string | null;
}

export class RuntimeContractCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeContractCompatibilityError';
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseContract(value: unknown): DiscoveredContract {
  if (!value || typeof value !== 'object') {
    throw new RuntimeContractCompatibilityError('runtime contract entry is not an object');
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    typeof item.status !== 'string' ||
    (item.lifecycle !== 'supported' && item.lifecycle !== 'deprecated') ||
    typeof item.href !== 'string' ||
    typeof item.introducedAt !== 'string' ||
    !isNullableString(item.deprecatedAt) ||
    !isNullableString(item.sunsetAt) ||
    !isNullableString(item.replacement) ||
    !item.features ||
    typeof item.features !== 'object' ||
    typeof (item.features as Record<string, unknown>).managedSession !== 'boolean' ||
    (
      (item.features as Record<string, unknown>).inboundEvents !== undefined
      && typeof (item.features as Record<string, unknown>).inboundEvents !== 'boolean'
    )
  ) {
    throw new RuntimeContractCompatibilityError('runtime contract entry is malformed');
  }
  return {
    ...(item as unknown as Omit<DiscoveredContract, 'features'>),
    features: {
      managedSession: (item.features as Record<string, unknown>).managedSession as boolean,
      inboundEvents: (item.features as Record<string, unknown>).inboundEvents === true,
    },
  };
}

export function parseRuntimeContractDiscovery(value: unknown): RuntimeContractDiscovery {
  if (!value || typeof value !== 'object') {
    throw new RuntimeContractCompatibilityError('runtime discovery is not an object');
  }
  const discovery = value as Record<string, unknown>;
  const policy = discovery.deprecationPolicy as Record<string, unknown> | undefined;
  if (
    discovery.apiVersion !== 'kertas.runtime/contracts/v1' ||
    discovery.currentCompatibilityMode !== 'run-as-session/v1' ||
    !Array.isArray(discovery.contracts) ||
    !Array.isArray(discovery.plannedContracts) ||
    !policy ||
    typeof policy.minimumNoticeDays !== 'number' ||
    policy.minimumNoticeDays < 1 ||
    policy.compatibilityModeRemoval !== 'explicit_sunset_only'
  ) {
    throw new RuntimeContractCompatibilityError('runtime discovery is malformed or unsupported');
  }
  return {
    apiVersion: 'kertas.runtime/contracts/v1',
    currentCompatibilityMode: 'run-as-session/v1',
    contracts: discovery.contracts.map(parseContract),
    plannedContracts: discovery.plannedContracts,
    deprecationPolicy: {
      minimumNoticeDays: policy.minimumNoticeDays,
      compatibilityModeRemoval: 'explicit_sunset_only',
    },
  };
}

export function selectCompatibleContract(value: unknown): SelectedRuntimeContract {
  const discovery = parseRuntimeContractDiscovery(value);
  const managed = discovery.contracts.find(
    (contract) =>
      contract.id === 'kertas.runtime/v1alpha1'
      && contract.features.managedSession
      && contract.features.inboundEvents,
  );
  if (managed) {
    return {
      contractId: 'kertas.runtime/v1alpha1',
      mode: 'managed-session',
      managedSession: true,
      inboundEvents: true,
      lifecycle: managed.lifecycle,
      deprecatedAt: managed.deprecatedAt,
      sunsetAt: managed.sunsetAt,
    };
  }

  const compatibility = discovery.contracts.find(
    (contract) => contract.id === discovery.currentCompatibilityMode,
  );
  if (!compatibility || compatibility.features.managedSession) {
    throw new RuntimeContractCompatibilityError(
      'runtime supports neither kertas.runtime/v1alpha1 nor run-as-session/v1',
    );
  }
  return {
    contractId: 'run-as-session/v1',
    mode: 'compatibility',
    managedSession: false,
    inboundEvents: false,
    lifecycle: compatibility.lifecycle,
    deprecatedAt: compatibility.deprecatedAt,
    sunsetAt: compatibility.sunsetAt,
  };
}

export async function discoverRuntimeContract(input: {
  baseUrl: string;
  bearerToken: string;
  fetchImpl?: typeof fetch;
}): Promise<SelectedRuntimeContract> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${input.baseUrl.replace(/\/$/, '')}/v1/contracts`, {
    headers: { authorization: `Bearer ${input.bearerToken}` },
  });
  if (!response.ok) {
    throw new RuntimeContractCompatibilityError(
      `runtime contract discovery failed with HTTP ${response.status}`,
    );
  }
  return selectCompatibleContract(await response.json());
}
