import { readFileSync } from 'node:fs';
import path from 'node:path';

export const CONTRACT_CATALOG_VERSION = 'kertas.runtime/contracts/v1' as const;
export const CURRENT_COMPATIBILITY_MODE = 'run-as-session/v1' as const;

export interface RuntimeContractDocument {
  apiVersion: typeof CONTRACT_CATALOG_VERSION;
  id: string;
  status: 'compatibility' | 'planned' | 'active' | 'deprecated';
  semantics: Record<string, unknown>;
  routes: Record<string, string>;
  schemas: Record<string, Record<string, unknown>>;
}

const cache = new Map<string, RuntimeContractDocument>();

function loadContract(
  filename: string,
  expectedId: string,
  expectedStatus: RuntimeContractDocument['status'],
  requiredSchemas: string[],
  contractsRoot = path.resolve(process.cwd(), 'contracts'),
): RuntimeContractDocument {
  const cacheKey = `${contractsRoot}:${filename}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const fullPath = path.join(contractsRoot, filename);
  const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as RuntimeContractDocument;
  if (
    parsed.apiVersion !== CONTRACT_CATALOG_VERSION
    || parsed.id !== expectedId
    || parsed.status !== expectedStatus
    || requiredSchemas.some((name) => !parsed.schemas?.[name])
  ) {
    throw new Error(`invalid packaged runtime contract: ${fullPath}`);
  }
  cache.set(cacheKey, parsed);
  return parsed;
}

export function loadCurrentRunContract(
  contractsRoot = path.resolve(process.cwd(), 'contracts'),
): RuntimeContractDocument {
  return loadContract(
    'run-as-session.v1.json',
    CURRENT_COMPATIBILITY_MODE,
    'compatibility',
    ['runCreate', 'runResource', 'runEvent', 'runEventsResponse'],
    contractsRoot,
  );
}

export function loadManagedSessionContract(
  contractsRoot = path.resolve(process.cwd(), 'contracts'),
): RuntimeContractDocument {
  return loadContract(
    'managed-session.v1alpha1.json',
    'kertas.runtime/v1alpha1',
    'active',
    [
      'sessionCreate', 'sessionResource', 'sessionRunList', 'sessionCancel',
      'sessionEventCreate', 'sessionEventResource', 'sessionEventList',
    ],
    contractsRoot,
  );
}

export function runtimeContractCatalog() {
  return {
    apiVersion: CONTRACT_CATALOG_VERSION,
    currentCompatibilityMode: CURRENT_COMPATIBILITY_MODE,
    contracts: [
      {
        id: CURRENT_COMPATIBILITY_MODE,
        status: 'compatibility' as const,
        lifecycle: 'supported' as const,
        href: '/v1/contracts/run-as-session/v1',
        introducedAt: '2026-07-22',
        deprecatedAt: null,
        sunsetAt: null,
        replacement: 'kertas.runtime/v1alpha1',
        features: { managedSession: false, inboundEvents: false },
      },
      {
        id: 'kertas.runtime/v1alpha1',
        status: 'active' as const,
        lifecycle: 'supported' as const,
        href: '/v1/contracts/kertas.runtime/v1alpha1',
        introducedAt: '2026-07-22',
        deprecatedAt: null,
        sunsetAt: null,
        replacement: null,
        features: { managedSession: true, inboundEvents: true },
      },
    ],
    plannedContracts: [],
    deprecationPolicy: {
      minimumNoticeDays: 90,
      compatibilityModeRemoval: 'explicit_sunset_only' as const,
    },
  };
}
