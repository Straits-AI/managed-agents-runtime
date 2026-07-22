import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export interface ReservedEvidenceRecord {
  path: string;
  commit(record: Record<string, unknown>): void;
}

export function reserveEvidenceRecord(
  requestedPath: string,
  pendingRecord: Record<string, unknown>,
): ReservedEvidenceRecord {
  const path = resolve(requestedPath);
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, serialize(pendingRecord), { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);

  return {
    path,
    commit(record) {
      const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        writeFileSync(temporaryPath, serialize(record), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        chmodSync(temporaryPath, 0o600);
        renameSync(temporaryPath, path);
      } catch (error) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // The original pending record remains the durable correlation fallback.
        }
        throw error;
      }
    },
  };
}

function serialize(record: Record<string, unknown>): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
