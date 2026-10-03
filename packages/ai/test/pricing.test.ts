import { describe, it, expect } from 'vitest';
import { EMPTY_USAGE, estimateCostUsd, MODEL_PRICING } from '../src';

const MILLION_EACH = { ...EMPTY_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 };

describe('estimateCostUsd', () => {
  it.each([
    ['claude-fable-5-1', 60],
    ['claude-opus-5-5', 24],
    ['claude-opus-5', 30],
    ['claude-opus-4-8', 30],
    ['claude-sonnet-5-5', 12],
    ['claude-sonnet-5', 12],
    ['claude-sonnet-4-6', 18],
    ['claude-haiku-4-5', 6],
    ['mock', 0],
  ])('prices 1M input + 1M output tokens on %s at $%d', (model, expected) => {
    expect(estimateCostUsd(model, MILLION_EACH)).toBeCloseTo(expected, 6);
  });

  it('covers every model in the pricing table', () => {
    expect(Object.keys(MODEL_PRICING)).toHaveLength(9);
  });

  it('bills cache reads at 0.1x and cache writes at 1.25x the input price', () => {
    const usage = { ...EMPTY_USAGE, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    // Opus 5.5 input is $4/MTok: 0.4 + 5
    expect(estimateCostUsd('claude-opus-5-5', usage)).toBeCloseTo(5.4, 6);
  });

  it('returns null for an unknown model', () => {
    expect(estimateCostUsd('gpt-unknown', MILLION_EACH)).toBeNull();
  });
});
