interface InvocationClientEvents {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Tie a provider request to both worker cancellation and the PostgreSQL session
 * that owns its advisory fence. If that session disappears, the lock is gone;
 * abort the HTTP request immediately so a retry cannot overlap an unfenced call.
 */
export function invocationAbortFence(
  client: InvocationClientEvents,
  parent: AbortSignal,
): {
  signal: AbortSignal;
  clientLost(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let lost = false;
  const abortFromParent = () => controller.abort(parent.reason);
  const abortFromClient = (reason?: unknown) => {
    lost = true;
    controller.abort(reason ?? new Error('model invocation lock session lost'));
  };
  parent.addEventListener('abort', abortFromParent, { once: true });
  client.once('error', abortFromClient);
  client.once('end', abortFromClient);
  if (parent.aborted) abortFromParent();

  return {
    signal: controller.signal,
    clientLost: () => lost,
    dispose() {
      parent.removeEventListener('abort', abortFromParent);
      client.removeListener('error', abortFromClient);
      client.removeListener('end', abortFromClient);
    },
  };
}
