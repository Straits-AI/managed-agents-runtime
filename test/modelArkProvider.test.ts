import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ModelArkProvider } from '../src/providers/modelark.js';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

function providerWith(completion: unknown) {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(completion);
  return {
    provider: new ModelArkProvider(loadConfig({ ARK_API_KEY: 'fixture-key' })),
    create: mockCreate,
  };
}

describe('ModelArk provider contract', () => {
  it('forwards bounds and cancellation and preserves valid tool calls and usage', async () => {
    const { provider, create } = providerWith({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"id":42}' },
          }],
        },
      }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const controller = new AbortController();
    const result = await provider.chat({
      model: 'seed-fixture',
      messages: [{ role: 'user', content: 'lookup' }],
      tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
      maxTokens: 19,
      temperature: 0,
      signal: controller.signal,
    });

    expect(result).toEqual({
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { id: 42 } }],
      },
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'seed-fixture',
      max_tokens: 19,
      temperature: 0,
      tools: [{
        type: 'function',
        function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } },
      }],
    }), { signal: controller.signal });
  });

  it('preserves malformed tool arguments for deterministic router rejection', async () => {
    const { provider } = providerWith({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call-bad',
            type: 'function',
            function: { name: 'lookup', arguments: '{bad json' },
          }],
        },
      }],
      usage: null,
    });

    await expect(provider.chat({ model: 'seed-fixture', messages: [] })).resolves.toMatchObject({
      message: {
        toolCalls: [{
          id: 'call-bad',
          name: 'lookup',
          arguments: { __raw: '{bad json' },
        }],
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it('rejects a provider response without a choice', async () => {
    const { provider } = providerWith({ choices: [], usage: null });
    await expect(provider.chat({ model: 'seed-fixture', messages: [] }))
      .rejects.toThrow('ModelArk returned no choices');
  });
});
