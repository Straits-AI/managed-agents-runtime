/**
 * Cost model (memo §25 cost attribution). Model tokens dominate the cost of a
 * text agent, and unlike sandbox/storage they are metered exactly per run, so
 * this computes model cost precisely. Sandbox/storage/database costs are
 * infrastructure-level and documented in docs/COST.md rather than estimated
 * per-run here. Prices are configurable (see MODEL_PRICE_* config); the numbers
 * are estimates for planning, not a billing-authoritative invoice.
 */
export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/** BytePlus ModelArk Seed-2.0-lite list price (0–128K input tier), July 2026. */
export const SEED_2_0_LITE_PRICE: ModelPrice = { inputPerMTok: 0.25, outputPerMTok: 2.0 };

export function estimateModelCostUsd(
  inputTokens: number,
  outputTokens: number,
  price: ModelPrice,
): number {
  const cost =
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok;
  // Round to whole micro-dollars — meaningful precision without float noise.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
