export const DELEGATED_RESULT_SCHEMA_VERSION = 1 as const;
export const MAX_DELEGATED_RESULT_BYTES = 65_536;
export const MAX_DELEGATED_CHILDREN = 8;
export const MAX_DELEGATED_GOAL_BYTES = 4_096;
export const MAX_DELEGATED_ARTIFACT_REFS = 32;

export interface DurableRunResult {
  schemaVersion: typeof DELEGATED_RESULT_SCHEMA_VERSION;
  summary: string;
  data: Record<string, unknown>;
}

export interface BoundedRunResult {
  value: DurableRunResult;
  sizeBytes: number;
}

export function buildBoundedRunResult(
  summary: string,
  data: unknown,
): BoundedRunResult {
  const normalizedData = isPlainRecord(data) ? data : {};
  const value: DurableRunResult = {
    schemaVersion: DELEGATED_RESULT_SCHEMA_VERSION,
    summary,
    data: normalizedData,
  };
  const sizeBytes = Buffer.byteLength(JSON.stringify(value));
  if (sizeBytes > MAX_DELEGATED_RESULT_BYTES) {
    throw new Error(
      `structured run result exceeds ${MAX_DELEGATED_RESULT_BYTES} encoded bytes`,
    );
  }
  return { value, sizeBytes };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
