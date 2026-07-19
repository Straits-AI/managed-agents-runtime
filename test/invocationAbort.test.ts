import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { invocationAbortFence } from '../src/harness/invocationAbort.js';

describe('model invocation abort fence', () => {
  it('aborts when the advisory-lock database session is lost', () => {
    const client = new EventEmitter();
    const parent = new AbortController();
    const fence = invocationAbortFence(client, parent.signal);

    client.emit('error', new Error('connection terminated'));

    expect(fence.signal.aborted).toBe(true);
    expect(fence.clientLost()).toBe(true);
    fence.dispose();
  });

  it('also propagates normal worker cancellation without marking client loss', () => {
    const client = new EventEmitter();
    const parent = new AbortController();
    const fence = invocationAbortFence(client, parent.signal);

    parent.abort(new Error('lease lost'));

    expect(fence.signal.aborted).toBe(true);
    expect(fence.clientLost()).toBe(false);
    fence.dispose();
  });
});
