import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertProviderMatrix,
  loadProviderManifest,
  renderProviderMatrix,
} from '../scripts/provider-claims.js';

const root = resolve(import.meta.dirname, '..');
const manifest = loadProviderManifest(resolve(root, 'provider-conformance/byteplus.v1.json'));

describe('versioned BytePlus provider claims', () => {
  it('retains complete provenance and five-plane evidence for every verified surface', () => {
    expect(manifest.surfaces.filter((surface) => surface.classification === 'verified').map((surface) => surface.id)).toEqual([
      'tos',
      'modelark',
      'vefaas-private-sandbox',
    ]);
  });

  it.each(['README.md', 'docs/BYTEPLUS-PROVIDER-CONFORMANCE.md'])(
    'checks %s against the conformance manifest',
    (relative) => {
      expect(() => assertProviderMatrix(
        readFileSync(resolve(root, relative), 'utf8'),
        renderProviderMatrix(manifest),
        relative,
      )).not.toThrow();
    },
  );
});
