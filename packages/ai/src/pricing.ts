import type { LlmUsage } from './types';

export interface ModelPricing {
  /** USD per million input tokens */
  inputPerMTok: number;
  /** USD per million output tokens */
  outputPerMTok: number;
}

// Anthropic first-party list prices, checked 2026-09-25. Update when prices change.
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  mock: { inputPerMTok: 0, outputPerMTok: 0 },
};

/** Cache reads bill at 0.1x the input price, 5-minute cache writes at 1.25x. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

const PER_MILLION = 1_000_000;

/** Estimated cost in USD, or null when the model has no known price. */
export function estimateCostUsd(model: string, usage: LlmUsage): number | null {
  const price = MODEL_PRICING[model] as ModelPricing | undefined;
  if (!price) return null;
  const inputEquivalent =
    usage.inputTokens +
    usage.cacheReadTokens * CACHE_READ_MULTIPLIER +
    usage.cacheWriteTokens * CACHE_WRITE_MULTIPLIER;
  return (
    (inputEquivalent * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / PER_MILLION
  );
}
