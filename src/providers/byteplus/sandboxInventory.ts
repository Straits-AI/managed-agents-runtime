const KNOWN_STATUSES = new Set([
  'Creating',
  'Pending',
  'Ready',
  'Paused',
  'Failed',
  'Terminating',
  'Terminated',
  'Deleted',
  'Killed',
  'Stopped',
]);

export function summarizeExactSandboxInventory(
  inventory: Record<string, unknown>,
  target: { functionId: string; metadata?: Record<string, string> },
): { liveInstances: number; terminatingTombstones: number } {
  const sandboxes = Array.isArray(inventory.Sandboxes) ? inventory.Sandboxes : null;
  const total = typeof inventory.Total === 'number' && Number.isSafeInteger(inventory.Total)
    ? inventory.Total
    : null;
  if (sandboxes === null || total === null || total < 0 || total !== sandboxes.length) {
    throw new Error('Sandbox inventory was incomplete');
  }

  let terminatingTombstones = 0;
  for (const sandbox of sandboxes) {
    if (!isRecord(sandbox) || sandbox.FunctionId !== target.functionId) {
      throw new Error('Sandbox inventory ownership did not match');
    }
    if (target.metadata) {
      const metadata = sandbox.Metadata;
      if (!isRecord(metadata)
        || Object.entries(target.metadata).some(([key, value]) => metadata[key] !== value)) {
        throw new Error('Sandbox inventory ownership did not match');
      }
    }
    if (typeof sandbox.Status !== 'string' || !KNOWN_STATUSES.has(sandbox.Status)) {
      throw new Error('Sandbox inventory status was invalid');
    }
    if (sandbox.Status === 'Terminating') terminatingTombstones += 1;
  }

  return {
    liveInstances: total - terminatingTombstones,
    terminatingTombstones,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
