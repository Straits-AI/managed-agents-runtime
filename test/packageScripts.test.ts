import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('BytePlus live conformance package scripts', () => {
  it('uses the credential-isolating bp profile instead of a secret env file', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['byteplus:sandbox:conformance']).toBe(
      'tsx scripts/conformance-runtime-sandbox.ts',
    );
  });
});
