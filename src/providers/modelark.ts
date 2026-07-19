import OpenAI from 'openai';
import type { Config } from '../config.js';
import { requireConfig } from '../config.js';
import type { ChatMessage, ModelProvider, ToolCall, ToolDef } from './types.js';

/**
 * BytePlus ModelArk provider — an OpenAI-compatible chat completions
 * endpoint, so the official openai package with a baseURL override is the
 * whole integration.
 */
export class ModelArkProvider implements ModelProvider {
  private readonly client: OpenAI;

  constructor(cfg: Config) {
    const required = requireConfig(cfg, ['ARK_API_KEY']);
    this.client = new OpenAI({
      apiKey: required.ARK_API_KEY,
      baseURL: cfg.ARK_BASE_URL,
      maxRetries: 3,
    });
  }

  async chat(req: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDef[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<{
    message: ChatMessage;
    usage: { inputTokens: number; outputTokens: number };
  }> {
    const completion = await this.client.chat.completions.create(
      {
        model: req.model,
        messages: req.messages.map(toOpenAiMessage),
        tools: req.tools?.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      },
      { signal: req.signal },
    );

    const choice = completion.choices[0];
    if (!choice) throw new Error('ModelArk returned no choices');

    const toolCalls: ToolCall[] = [];
    for (const tc of choice.message.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        // Preserve unparseable arguments so the tool router can reject
        // them with a useful message instead of dropping the call.
        args = { __raw: tc.function.arguments };
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
    }

    return {
      message: {
        role: 'assistant',
        content: choice.message.content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function toOpenAiMessage(
  m: ChatMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content ?? '' };
    case 'user':
      return { role: 'user', content: m.content ?? '' };
    case 'tool':
      return { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId! };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
  }
}
