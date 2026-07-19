import { describe, expect, it } from 'vitest';
import { limitModelInvocation } from '../src/harness/limits.js';
import type { ChatMessage, ToolDef } from '../src/providers/types.js';

const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
const tools: ToolDef[] = [];

describe('model invocation token ceiling', () => {
  it('reserves a conservative prompt bound and caps the next output', () => {
    const serializedBytes = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8');
    const limit = limitModelInvocation({
      tokenBudget: String(serializedBytes + 7),
      tokensUsed: '0',
      messages,
      tools,
      requestedMaxTokens: 100,
      defaultMaxTokens: 8_192,
    });

    expect(limit).toMatchObject({
      maxTokens: 7,
      remaining: BigInt(serializedBytes + 7),
      inputTokenCeiling: BigInt(serializedBytes),
    });
  });

  it('refuses a call when the serialized prompt cannot fit', () => {
    const serializedBytes = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8');
    expect(
      limitModelInvocation({
        tokenBudget: String(serializedBytes),
        tokensUsed: '0',
        messages,
        tools,
        defaultMaxTokens: 8_192,
      }),
    ).toBeNull();
  });

  it('preserves the configured output ceiling for an unbounded run', () => {
    expect(
      limitModelInvocation({
        tokenBudget: null,
        tokensUsed: '0',
        messages,
        tools,
        requestedMaxTokens: 512,
        defaultMaxTokens: 8_192,
      })?.maxTokens,
    ).toBe(512);
  });

  it('uses the provider ceiling when a bounded version omits maxTokens', () => {
    const limit = limitModelInvocation({
      tokenBudget: '1000000',
      tokensUsed: '0',
      messages,
      tools,
      defaultMaxTokens: 8_192,
    });
    expect(limit?.maxTokens).toBe(8_192);
  });
});
