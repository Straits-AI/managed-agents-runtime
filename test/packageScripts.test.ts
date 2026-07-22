import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('BytePlus live conformance package scripts', () => {
  it('loads refreshed credentials for the private runtime command', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['byteplus:sandbox:conformance']).toContain('--env-file=.env');
  });
});
