// OpenAI price table (USD per 1M text tokens, Standard tier, short context).
// Source: https://developers.openai.com/api/docs/pricing (accessed 2026-10-29, M0-07).
// Re-verify on any model change; a model missing here is refused, never priced at zero.

export interface ModelPrice {
  readonly inputPerM: number;
  readonly cachedInputPerM: number;
  readonly outputPerM: number;
}

export const PRICES_SOURCE = "https://developers.openai.com/api/docs/pricing";
export const PRICES_ACCESSED = "2026-10-29";

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-6-luna": { inputPerM: 0.1, cachedInputPerM: 0.01, outputPerM: 0.5 },
  "gpt-6.1-terra": { inputPerM: 1.0, cachedInputPerM: 0.05, outputPerM: 5.0 },
  "gpt-6.1-sol": { inputPerM: 2.0, cachedInputPerM: 0.1, outputPerM: 10.0 },
  "gpt-5.6-luna": { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.2 },
  "gpt-5.4-mini-2026-03-17": { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 },
  "gpt-5.4-nano-2026-03-17": { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.25 },
};

/** The token counts we bill on, taken from the Responses API `usage` object. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export class UnknownModelPriceError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`no price for model "${model}" in pricing.ts`);
    this.model = model;
    this.name = "UnknownModelPriceError";
  }
}

export function priceFor(model: string): ModelPrice {
  const price = PRICES[model];
  if (price === undefined) throw new UnknownModelPriceError(model);
  return price;
}

/** Cost in USD. Cached input is a subset of input; reasoning tokens are billed inside output. */
export function costUsd(model: string, usage: TokenUsage): number {
  const p = priceFor(model);
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncached * p.inputPerM +
      usage.cachedInputTokens * p.cachedInputPerM +
      usage.outputTokens * p.outputPerM) /
    1_000_000
  );
}

/**
 * M4-05 (owner decision on #49): the most one request can bill. `max_output_tokens` bounds output,
 * reasoning included; input is priced uncached at the caller's upper bound.
 */
export function worstCaseCostUsd(model: string, inputTokensBound: number, maxOutputTokens: number): number {
  return costUsd(model, {
    inputTokens: inputTokensBound,
    cachedInputTokens: 0,
    outputTokens: maxOutputTokens,
    reasoningTokens: 0,
  });
}
