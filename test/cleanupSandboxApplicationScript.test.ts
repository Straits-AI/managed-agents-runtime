import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('private sandbox cleanup command', () => {
  it('reserves the evidence destination before its first BytePlus call', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sandbox-cleanup-command-'));
    const fakeBin = join(directory, 'bin');
    const marker = join(directory, 'bp-called');
    const evidence = join(directory, 'cleanup.json');
    mkdirSync(fakeBin);
    const fakeGit = join(fakeBin, 'git');
    const fakeBp = join(fakeBin, 'bp');
    writeFileSync(fakeGit, '#!/bin/sh\nexit 1\n');
    writeFileSync(fakeBp, '#!/bin/sh\n: > "$MARKER_FILE"\nprintf \'%s\\n\' \'{"ResponseMetadata":{"RequestId":"request-fixture"},"Result":{}}\'\n');
    chmodSync(fakeGit, 0o700);
    chmodSync(fakeBp, 0o700);
    writeFileSync(evidence, '{"owner":"existing"}\n', { mode: 0o600 });

    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      resolve('scripts/cleanup-sandbox-application.ts'),
      '--profile',
      'dev',
      '--region',
      'ap-southeast-1',
      '--function-id',
      'function-fixture',
      '--name',
      'managed-agents-runtime-test',
      '--evidence-file',
      evidence,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        CONFORMANCE_SOURCE_COMMIT: '0000000000000000000000000000000000000000',
        MARKER_FILE: marker,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
