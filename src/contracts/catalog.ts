import { readFileSync } from 'node:fs';
import path from 'node:path';

export const CONTRACT_CATALOG_VERSION = 'kertas.runtime/contracts/v1' as const;
export const CURRENT_COMPATIBILITY_MODE = 'run-as-session/v1' as const;

export interface RuntimeContractDocument {
  apiVersion: typeof CONTRACT_CATALOG_VERSION;
  id: string;
  status: 'compatibility' | 'active' | 'deprecated';
  semantics: Record<string, unknown>;
  routes: Record<string, string>;
  schemas: Record<string, Record<string, unknown>>;
}

let cached: RuntimeContractDocument | undefined;

export function loadCurrentRunContract(
  contractsRoot = path.resolve(process.cwd(), 'contracts'),
): RuntimeContractDocument {
  if (cached && contractsRoot === path.resolve(process.cwd(), 'contracts')) return cached;
  const filename = path.join(contractsRoot, 'run-as-session.v1.json');
  const parsed = JSON.parse(readFileSync(filename, 'utf8')) as RuntimeContractDocument;
  if (
    parsed.apiVersion !== CONTRACT_CATALOG_VERSION ||
    parsed.id !== CURRENT_COMPATIBILITY_MODE ||
    parsed.status !== 'compatibility' ||
    !parsed.schemas?.runCreate ||
    !parsed.schemas?.runResource ||
    !parsed.schemas?.runEvent ||
    !parsed.schemas?.runEventsResponse
  ) {
    throw new Error(`invalid packaged runtime contract: ${filename}`);
  }
  if (contractsRoot === path.resolve(process.cwd(), 'contracts')) cached = parsed;
  return parsed;
}

export function runtimeContractCatalog() {
  return {
    apiVersion: CONTRACT_CATALOG_VERSION,
    currentCompatibilityMode: CURRENT_COMPATIBILITY_MODE,
    contracts: [
      {
        id: CURRENT_COMPATIBILITY_MODE,
        status: 'compatibility' as const,
        href: '/v1/contracts/run-as-session/v1',
      },
    ],
  };
}
