import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export interface ReservedEvidenceRecord {
  path: string;
  commit(record: Record<string, unknown>): void;
}

export function reserveEvidenceRecord(
  requestedPath: string,
  pendingRecord: Record<string, unknown>,
): ReservedEvidenceRecord {
  const path = resolve(requestedPath);
  writeDurableExclusive(path, pendingRecord);
  syncDirectory(dirname(path));

  return {
    path,
    commit(record) {
      const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        writeDurableExclusive(temporaryPath, record);
        renameSync(temporaryPath, path);
        syncDirectory(dirname(path));
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

function writeDurableExclusive(path: string, record: Record<string, unknown>): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, serialize(record), { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function serialize(record: Record<string, unknown>): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
