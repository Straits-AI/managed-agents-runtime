import { describe, expect, it } from 'vitest';
import { summarizeExactSandboxInventory } from '../src/providers/byteplus/sandboxInventory.js';

describe('BytePlus sandbox inventory summary', () => {
  it('distinguishes exact terminating tombstones from live instances', () => {
    expect(summarizeExactSandboxInventory({
      Sandboxes: [{
        FunctionId: 'function-1',
        Status: 'Terminating',
        Metadata: { runId: 'run-1' },
      }],
      Total: 1,
    }, {
      functionId: 'function-1',
      metadata: { runId: 'run-1' },
    })).toEqual({ liveInstances: 0, terminatingTombstones: 1 });

    expect(summarizeExactSandboxInventory({
      Sandboxes: [{
        FunctionId: 'function-1',
        Status: 'Ready',
        Metadata: { runId: 'run-1' },
      }],
      Total: 1,
    }, {
      functionId: 'function-1',
      metadata: { runId: 'run-1' },
    })).toEqual({ liveInstances: 1, terminatingTombstones: 0 });
  });

  it.each([
    [{ Sandboxes: [], Total: 1 }, 'incomplete'],
    [{ Sandboxes: [{ FunctionId: 'function-other', Status: 'Terminating' }], Total: 1 }, 'ownership'],
    [{ Sandboxes: [{ FunctionId: 'function-1', Status: 'Terminating', Metadata: { runId: 'other' } }], Total: 1 }, 'ownership'],
    [{ Sandboxes: [{ FunctionId: 'function-1', Metadata: { runId: 'run-1' } }], Total: 1 }, 'status'],
  ])('fails closed for invalid inventory: %s', (inventory, reason) => {
    expect(() => summarizeExactSandboxInventory(inventory, {
      functionId: 'function-1',
      metadata: inventory.Total === 1 ? { runId: 'run-1' } : undefined,
    })).toThrow(reason);
  });
});
