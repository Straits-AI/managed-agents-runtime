import { describe, it, expect } from 'vitest';
import { canonicalJson, idempotencyKey } from '../src/store/receipts.js';
import { patternMatches } from '../src/store/grants.js';

describe('canonicalJson', () => {
  it('is stable under key ordering', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, null] } })).toBe(
      canonicalJson({ a: { c: [3, null], d: 2 }, b: 1 }),
    );
  });

  it('drops undefined properties', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('idempotencyKey', () => {
  const base = {
    runId: 'run_1',
    action: 'external.http.post',
    args: { url: 'https://x', body: { n: 1 } },
  };

  it('is identical for identical inputs regardless of arg order', () => {
    expect(idempotencyKey(base)).toBe(
      idempotencyKey({ ...base, args: { body: { n: 1 }, url: 'https://x' } }),
    );
  });

  it('differs across runs, actions, args, and approvals', () => {
    const k = idempotencyKey(base);
    expect(idempotencyKey({ ...base, runId: 'run_2' })).not.toBe(k);
    expect(idempotencyKey({ ...base, action: 'external.http.get' })).not.toBe(k);
    expect(idempotencyKey({ ...base, args: { url: 'https://y' } })).not.toBe(k);
    expect(idempotencyKey({ ...base, approvalId: 'apr_1' })).not.toBe(k);
  });
});

describe('patternMatches', () => {
  it('matches exact and wildcard patterns', () => {
    expect(patternMatches('external.http.post', 'external.http.post')).toBe(true);
    expect(patternMatches('external.http.*', 'external.http.post')).toBe(true);
    expect(patternMatches('*', 'anything.at.all')).toBe(true);
    expect(patternMatches('external.http.*', 'workspace.file.write')).toBe(false);
    expect(patternMatches('a.b', 'aXb')).toBe(false); // '.' is literal
  });
});
