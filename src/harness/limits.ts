import type { Pool } from 'pg';
import type { ChatMessage, ToolDef } from '../providers/types.js';

/**
 * A run's token budget is a hard ceiling (memo §16.9): once cumulative model
 * usage reaches it, the run stops gracefully rather than looping. Shared by the
 * real and scripted epochs so both enforce it identically.
 */
export async function tokenBudgetExceeded(pool: Pool, runId: string): Promise<boolean> {
  const { rows } = await pool.query<{ tokens_used: string; token_budget: string | null }>(
    'SELECT tokens_used, token_budget FROM runs WHERE id = $1',
    [runId],
  );
  const row = rows[0];
  if (!row || row.token_budget === null) return false;
  return BigInt(row.tokens_used) >= BigInt(row.token_budget);
}

export interface ModelInvocationLimit {
  /** Provider output ceiling for this call. */
  maxTokens: number | undefined;
  /** Total run capacity remaining before this call. */
  remaining: bigint | null;
  /** Conservative upper bound for the serialized prompt and tool definitions. */
  inputTokenCeiling: bigint;
}

/**
 * Bound the next model call before it is dispatched. OpenAI-compatible models
 * tokenize UTF-8 bytes, so serialized byte length is a conservative ceiling on
 * input-token count. Reserving that ceiling and capping provider output means a
 * conforming provider cannot exceed the run's remaining hard budget.
 *
 * Returns null when even the prompt ceiling cannot fit.
 */
export function limitModelInvocation(input: {
  tokenBudget: string | null;
  tokensUsed: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  requestedMaxTokens?: number;
  defaultMaxTokens: number;
}): ModelInvocationLimit | null {
  const inputTokenCeiling = BigInt(
    Buffer.byteLength(JSON.stringify({ messages: input.messages, tools: input.tools }), 'utf8'),
  );
  if (input.tokenBudget === null) {
    return {
      maxTokens:
        normalizeRequestedMax(input.requestedMaxTokens) ?? input.defaultMaxTokens,
      remaining: null,
      inputTokenCeiling,
    };
  }

  const remaining = BigInt(input.tokenBudget) - BigInt(input.tokensUsed);
  const outputCapacity = remaining - inputTokenCeiling;
  if (outputCapacity <= 0n) return null;
  const requested =
    normalizeRequestedMax(input.requestedMaxTokens) ?? input.defaultMaxTokens;
  const requestedBigInt = BigInt(requested);
  const bounded = requestedBigInt < outputCapacity ? requestedBigInt : outputCapacity;
  const safe = bounded > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(bounded);
  return { maxTokens: safe, remaining, inputTokenCeiling };
}

function normalizeRequestedMax(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}
