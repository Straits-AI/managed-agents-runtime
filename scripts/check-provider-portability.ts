import { resolve } from 'node:path';
import { loadProviderPortability } from '../src/providers/portability.js';

const root = resolve(import.meta.dirname, '..');
const { catalog, manifests, deployments } = loadProviderPortability(root);
process.stdout.write(
  `PASS provider portability (${catalog.contracts.length} contracts, ${manifests.length} manifests, ${deployments.length} deployments)\n`,
);
