import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reserveEvidenceRecord } from '../src/providers/byteplus/provisioningEvidence.js';

describe('provisioning evidence record', () => {
  it('reserves an owner-only pending record and atomically commits the final receipt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'provisioning-evidence-'));
    const path = join(directory, 'receipt.json');
    const writer = reserveEvidenceRecord(path, { status: 'pending', attemptId: 'attempt-1' });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      status: 'pending',
      attemptId: 'attempt-1',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    writer.commit({ status: 'succeeded', functionId: 'function-1' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      status: 'succeeded',
      functionId: 'function-1',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses an existing destination before provisioning can begin', () => {
    const directory = mkdtempSync(join(tmpdir(), 'provisioning-evidence-'));
    const path = join(directory, 'receipt.json');
    writeFileSync(path, 'existing', { mode: 0o600 });
    expect(() => reserveEvidenceRecord(path, { status: 'pending' })).toThrow();
  });

  it('retains the pending correlation record when a final atomic update cannot start', () => {
    const directory = mkdtempSync(join(tmpdir(), 'provisioning-evidence-'));
    const path = join(directory, 'receipt.json');
    const pending = { status: 'pending', attemptId: 'attempt-1' };
    const writer = reserveEvidenceRecord(path, pending);
    chmodSync(directory, 0o500);
    try {
      expect(() => writer.commit({ status: 'succeeded' })).toThrow();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(pending);
    } finally {
      chmodSync(directory, 0o700);
    }
  });

  it('refuses a destination whose parent is not writable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'provisioning-evidence-'));
    chmodSync(directory, 0o500);
    const path = join(directory, 'receipt.json');
    try {
      expect(() => reserveEvidenceRecord(path, { status: 'pending' })).toThrow();
    } finally {
      chmodSync(directory, 0o700);
    }
  });
});
