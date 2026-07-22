import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertProviderMatrix,
  loadProviderManifest,
  renderProviderMatrix,
} from './provider-claims.js';

const root = resolve(import.meta.dirname, '..');
const manifest = loadProviderManifest(resolve(root, 'provider-conformance/byteplus.v1.json'));
const expected = renderProviderMatrix(manifest);
for (const relative of ['README.md', 'docs/BYTEPLUS-PROVIDER-CONFORMANCE.md']) {
  assertProviderMatrix(readFileSync(resolve(root, relative), 'utf8'), expected, relative);
}
process.stdout.write(`PASS BytePlus provider claims (${manifest.surfaces.length} surfaces)\n`);
