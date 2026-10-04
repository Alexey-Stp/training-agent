import { Sport } from '@triathlon/core';
import { describe, expect, it } from 'vitest';
import {
  DAILY_PROMPT_VERSION,
  MockProvider,
  runRulesFallback,
  SUGGESTION_PROMPT_VERSION,
} from '../../src';
import {
  easy,
  FakeDecisionSink,
  hard,
  NO_HISTORY,
  readiness,
  TODAY,
  USER_ID,
  week,
} from './fixtures';

describe('runRulesFallback', () => {
  it('writes one rules-engine decision without an LLM', async () => {
    const provider = new MockProvider();
    const sink = new FakeDecisionSink();
    const record = await runRulesFallback(
      { provider, decisions: sink },
      {
        userId: USER_ID,
        date: TODAY,
        promptVersion: DAILY_PROMPT_VERSION,
        sessions: [hard(TODAY, Sport.bike, 60, 'VO2 5x4'), easy('2026-10-06', Sport.run, 45)],
        context: readiness(2),
      },
      'internal_error'
    );

    expect(provider.calls).toHaveLength(0);
    expect(sink.records).toEqual([record]);
    expect(record).toMatchObject({
      userId: USER_ID,
      origin: 'daily',
      date: TODAY,
      suggestionPromptVersion: SUGGESTION_PROMPT_VERSION,
      source: 'fallback',
      fallbackReason: 'internal_error',
      attempts: 0,
      rawResponses: [],
      suggestion: null,
      verdict: null,
      finalAction: 'reduce',
      finalChanges: [
        { sessionId: '2026-10-05/bike-1', field: 'intensity', before: 'z4', after: 'z2' },
      ],
    });
    expect(record.athleteMessage).toContain('standard safety rules');
    expect(record.contextHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the plan when the rules engine has nothing to change', async () => {
    const provider = new MockProvider();
    const sink = new FakeDecisionSink();
    const record = await runRulesFallback(
      { provider, decisions: sink },
      {
        userId: USER_ID,
        date: TODAY,
        promptVersion: DAILY_PROMPT_VERSION,
        sessions: week(),
        context: NO_HISTORY,
      },
      'internal_error'
    );

    expect(record).toMatchObject({ finalAction: 'keep', finalChanges: [] });
  });
});
